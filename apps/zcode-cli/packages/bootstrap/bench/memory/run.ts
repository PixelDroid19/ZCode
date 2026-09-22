import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { startProcessProviderRegistryRuntime } from "../../src/index.js";
import { fixture, questionPrompt, score, type Arm, type Stage } from "./cases.js";
import { copyMemory, runTurn, snapshot, memoryDigest } from "./app.js";
import { safeError, usage, type CallObservation } from "./observer.js";

const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    model: { type: "string" },
    reasoning: { type: "string" },
    replicas: { type: "string", default: "2" },
    output: { type: "string" },
  },
});
if (!values.provider || !values.model || !values.reasoning) {
  throw new Error(
    "Required: --provider ID --model ID --reasoning OPTION; provider paths come from ZCODE_*_PROVIDER_CONFIG_FILE",
  );
}
const replicas = Number(values.replicas);
if (!Number.isInteger(replicas) || replicas < 1 || replicas > 4)
  throw new Error("replicas must be 1..4");
const root = await mkdtemp(join(tmpdir(), "zcode-memory-benchmark-"));
const output = resolve(values.output ?? join(root, "results.json"));
const selection = {
  providerId: values.provider,
  modelId: values.model,
  options: { reasoningLevel: values.reasoning },
};
const { stdout: commit } = await promisify(execFile)("git", ["rev-parse", "HEAD"]);
const sourceFiles = ["cases.ts", "observer.ts", "app.ts", "run.ts"];
const sourceHash = createHash("sha256");
for (const file of sourceFiles) sourceHash.update(await readFile(new URL(file, import.meta.url)));

type Turn = Awaited<ReturnType<typeof runTurn>>;
interface Observation {
  replica: number;
  arm: Arm;
  phase: "learning" | "query";
  id: string;
  turn: Turn;
  grade?: ReturnType<typeof score>;
  category?: string;
  protocolViolations?: string[];
}
const observations: Observation[] = [];
const snapshots: object[] = [];
const report: Record<string, unknown> = {
  protocol: "shared-experience-memory-v1",
  startedAt: new Date().toISOString(),
  commit: commit.trim(),
  sourceSha256: sourceHash.digest("hex"),
  selection,
  replicas,
  runtime: { node: process.version, platform: process.platform, architecture: process.arch },
  limitations: [
    "Synthetic pilot; not a coding benchmark",
    "No statistical generalization from two replicas",
    "Provider sampling defaults; deterministic sampling is not promised",
  ],
  observations,
  snapshots,
};
const persist = () => writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
let registry: Awaited<ReturnType<typeof startProcessProviderRegistryRuntime>> | undefined;
let modelCalls = 0;
try {
  registry = await startProcessProviderRegistryRuntime(process.env);
  const valid = registry.runtime.registryService.validateSelection(selection);
  if (!valid.ok) throw new Error("Benchmark model selection is not available");
  for (let replica = 0; replica < replicas; replica += 1) {
    const data = fixture(replica);
    const profile = (arm: Arm) => `replica-${replica}/${arm}/learning`;
    const key = (arm: Arm, project: "a" | "b") => `replica-${replica}-${arm}-${project}`;
    const order = (offset: number): Arm[] =>
      (replica + offset) % 2 ? ["on", "off"] : ["off", "on"];
    for (const stage of ["initial", "updated"] as Stage[]) {
      const teaching = stage === "initial" ? data.initial : data.updates;
      for (let index = 0; index < teaching.length; index += 1) {
        for (const arm of order(index)) {
          if (modelCalls >= replicas * 100) throw new Error("Overall model-call budget exhausted");
          const turn = await runTurn({
            root,
            profile: profile(arm),
            projectKey: key(arm, "a"),
            arm,
            learning: true,
            prompt: teaching[index],
            registry,
            selection,
          });
          modelCalls += turn.calls.length;
          observations.push({ replica, arm, phase: "learning", id: `${stage}-${index}`, turn });
          await persist();
          console.log(
            JSON.stringify({
              replica,
              arm,
              phase: "learning",
              stage,
              index,
              calls: turn.calls.length,
              error: turn.error,
            }),
          );
          if (turn.error || turn.calls.some((call) => call.error))
            throw new Error("Learning failed; partial results retained");
          if (turn.mutatingForegroundCalls)
            throw new Error(
              "Foreground teaching wrote memory; automatic-extraction isolation failed",
            );
        }
      }
      for (const arm of ["off", "on"] as Arm[]) {
        snapshots.push({
          replica,
          arm,
          stage,
          ...(await snapshot(root, profile(arm), key(arm, "a"))),
        });
      }
      for (const [index, item] of data.cases.filter((item) => item.stage === stage).entries()) {
        for (const arm of order(index)) {
          if (modelCalls >= replicas * 100) throw new Error("Overall model-call budget exhausted");
          const target = `replica-${replica}/${arm}/query-${item.id}`;
          await copyMemory(root, profile(arm), target);
          const before = await memoryDigest(root, target);
          const turn = await runTurn({
            root,
            profile: target,
            projectKey: key(arm, item.project),
            arm,
            learning: false,
            prompt: questionPrompt(item.question),
            registry,
            selection,
          });
          modelCalls += turn.calls.length;
          const after = await memoryDigest(root, target);
          const grade = score(turn.response, item.expected);
          const protocolViolations: string[] = [];
          if (turn.mutatingForegroundCalls || before !== after)
            protocolViolations.push("evaluation_mutated_memory");
          if (
            arm === "off" &&
            turn.calls.some((call) => call.recalled || call.memoryContext.length)
          )
            protocolViolations.push("off_received_memory");
          if (
            item.project === "b" &&
            (turn.response.includes(data.privateValue) ||
              turn.calls.some((call) =>
                call.memoryContext.some((text) => text.includes(data.privateValue)),
              ))
          )
            protocolViolations.push("project_private_value_leaked");
          if (turn.unexpectedOperations.length)
            protocolViolations.push("unexpected_model_operation");
          if (turn.error || turn.calls.some((call) => call.error) || protocolViolations.length)
            grade.passed = false;
          observations.push({
            replica,
            arm,
            phase: "query",
            id: item.id,
            category: item.category,
            grade,
            protocolViolations,
            turn,
          });
          await persist();
          console.log(
            JSON.stringify({
              replica,
              arm,
              phase: "query",
              id: item.id,
              passed: grade.passed,
              error: turn.error,
            }),
          );
        }
      }
    }
  }
  report.status = observations.some(
    (row) =>
      row.turn.error ||
      !row.turn.totalUsage.complete ||
      !row.turn.physicalUsage.complete ||
      row.turn.unexpectedOperations.length ||
      row.protocolViolations?.length,
  )
    ? "incomplete"
    : "completed";
  if (report.status === "incomplete") process.exitCode = 1;
} catch (error) {
  report.status = "blocked";
  report.error = safeError(error);
  process.exitCode = 1;
} finally {
  registry?.dispose();
  report.finishedAt = new Date().toISOString();
  report.summary = Object.fromEntries(
    (["off", "on"] as Arm[]).map((arm) => {
      const rows = observations.filter((row) => row.arm === arm);
      const queries = rows.filter((row) => row.phase === "query");
      const calls: CallObservation[] = rows.flatMap((row) => row.turn.calls);
      return [
        arm,
        {
          passed: queries.filter((row) => row.grade?.passed).length,
          evaluated: queries.length,
          malformed: queries.filter((row) => row.grade?.malformed).length,
          operationalErrors: rows.filter(
            (row) => row.turn.error || row.turn.calls.some((call) => call.error),
          ).length,
          protocolViolations: queries.flatMap((row) => row.protocolViolations ?? []),
          elapsedMs: rows.reduce((sum, row) => sum + row.turn.elapsedMs, 0),
          queryElapsedMs: queries.reduce((sum, row) => sum + row.turn.elapsedMs, 0),
          drainWaitMs: rows.reduce((sum, row) => sum + (row.turn.drainWaitMs ?? 0), 0),
          extractionModelMs: rows.reduce((sum, row) => sum + row.turn.extractionModelMs, 0),
          allUsage: usage(calls),
          physicalUsage: usage(rows.flatMap((row) => row.turn.attempts)),
          queryUsage: usage(queries.flatMap((row) => row.turn.calls)),
          extractionUsage: usage(
            calls.filter((call) => call.operation === "project_memory_extract"),
          ),
        },
      ];
    }),
  );
  report.pairedQueries = observations
    .filter((row) => row.arm === "on" && row.phase === "query")
    .flatMap((on) => {
      const off = observations.find(
        (row) =>
          row.arm === "off" &&
          row.phase === "query" &&
          row.replica === on.replica &&
          row.id === on.id,
      );
      if (!off) return [];
      const tokens = (turn: Turn) =>
        turn.totalUsage.complete
          ? turn.calls.reduce((sum, call) => sum + (call.usage?.totalTokens ?? 0), 0)
          : null;
      const onTokens = tokens(on.turn);
      const offTokens = tokens(off.turn);
      return [
        {
          replica: on.replica,
          id: on.id,
          onPassed: on.grade?.passed,
          offPassed: off.grade?.passed,
          tokenDelta: onTokens === null || offTokens === null ? null : onTokens - offTokens,
          elapsedDeltaMs: on.turn.elapsedMs - off.turn.elapsedMs,
        },
      ];
    });
  await persist();
  console.log(JSON.stringify({ status: report.status, output, root, summary: report.summary }));
}
