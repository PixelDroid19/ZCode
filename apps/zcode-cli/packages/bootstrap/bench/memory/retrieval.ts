import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { SqliteMemoryStore } from "@zcode/adapters/storage";
import type { MemoryRecord } from "@zcode/contracts";
import { retrievalCases } from "./retrieval-cases.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    distractors: { type: "string", default: "1000" },
  },
});
const distractors = Number(values.distractors);
if (!Number.isInteger(distractors) || distractors < 0 || distractors > 10_000)
  throw new Error("distractors must be 0..10000");
const root = await mkdtemp(join(tmpdir(), "zcode-memory-retrieval-"));
const dbPath = join(root, "experience.sqlite");
const output = resolve(values.output ?? join(root, "results.json"));
const access = { projectKey: "project-a", sessionId: "synthetic-learning" };
let store = await SqliteMemoryStore.open({ dbPath });
const ids = new Map<string, string>();
const started = performance.now();
let superseded: MemoryRecord;
try {
  for (const item of retrievalCases) {
    const record = await store.save(access, {
      operationId: `seed-${item.topic}`,
      scope: "project",
      content: {
        topicKey: item.topic,
        kind: "episode",
        title: item.title,
        summary: item.summary,
        tags: [],
      },
    });
    ids.set(item.topic, record.id);
  }
  for (let index = 0; index < distractors; index += 1) {
    await store.save(access, {
      operationId: `distractor-${index}`,
      scope: "project",
      content: {
        topicKey: `catalog-${index}`,
        kind: "fact",
        title: `Catálogo del módulo de interfaz ${index}`,
        summary: `El componente visual ${index} usa el color de tema ${index % 7}. La documentación del proyecto recomienda revisar el diseño y las traducciones antes de publicar una modificación.`,
        tags: ["interfaz", "tema"],
      },
    });
  }
  const old = await store.save(access, {
    operationId: "old-port",
    scope: "project",
    content: {
      topicKey: "fixture-port-old",
      kind: "fact",
      title: "fixtureport current",
      summary: "fixtureport=42141",
      tags: [],
    },
  });
  superseded = await store.save(access, {
    operationId: "new-port",
    scope: "project",
    supersedes: { id: old.id, expectedRevision: old.revision },
    content: {
      topicKey: "fixture-port-current",
      kind: "fact",
      title: "fixtureport current",
      summary: "fixtureport=42741",
      tags: [],
    },
  });
  await store.save(access, {
    operationId: "portable",
    scope: "user",
    content: {
      topicKey: "portable-style",
      kind: "preference",
      title: "portablebranch",
      summary: "Use repair/ for fixes across my projects.",
      tags: [],
    },
  });
} finally {
  await store.close();
}
const seedMs = performance.now() - started;
store = await SqliteMemoryStore.open({ dbPath });
const results: {
  topic: string;
  category: string;
  query: string;
  rank: number | null;
  milliseconds: number;
  returnedTopics: string[];
}[] = [];
const repeatedLatency: number[] = [];
try {
  for (const item of retrievalCases) {
    for (const category of ["keyword", "paraphrase", "crossLanguage"] as const) {
      const query = item[category];
      const before = performance.now();
      const rows = await store.search(access, { query, scope: "all", limit: 6 });
      const elapsed = performance.now() - before;
      const index = rows.findIndex((row) => row.id === ids.get(item.topic));
      results.push({
        topic: item.topic,
        category,
        query,
        rank: index < 0 ? null : index + 1,
        milliseconds: elapsed,
        returnedTopics: rows.map((row) => row.content.topicKey),
      });
      for (let repetition = 0; repetition < 20; repetition += 1) {
        const beforeRepeat = performance.now();
        await store.search(access, { query, scope: "all", limit: 6 });
        repeatedLatency.push(performance.now() - beforeRepeat);
      }
    }
  }
  const other = { ...access, projectKey: "project-b" };
  const current = await store.search(access, { query: "fixtureport", limit: 6 });
  const leak = await store.search(other, { query: "fixtureport SQLite", limit: 6 });
  const portable = await store.search(other, { query: "portablebranch", limit: 6 });
  const sorted = repeatedLatency.toSorted((a, b) => a - b);
  const sourceSha256 = createHash("sha256")
    .update(await readFile(new URL("retrieval-cases.ts", import.meta.url)))
    .update(await readFile(new URL("retrieval.ts", import.meta.url)))
    .digest("hex");
  const report = {
    type: "retrieval-component-only",
    createdAt: new Date().toISOString(),
    sourceSha256,
    commit: (await promisify(execFile)("git", ["rev-parse", "HEAD"])).stdout.trim(),
    runtime: { node: process.version, platform: process.platform, architecture: process.arch },
    corpus: { targets: retrievalCases.length, distractors, otherRecords: 3 },
    seedMs,
    semantics: {
      latestOnly: current.length === 1 && current[0].id === superseded.id,
      projectIsolation: leak.length === 0,
      userPortable: portable.length === 1 && portable[0].scope === "user",
    },
    summary: Object.fromEntries(
      ["keyword", "paraphrase", "crossLanguage"].map((category) => {
        const rows = results.filter((result) => result.category === category);
        return [
          category,
          {
            hitsAt6: rows.filter((row) => row.rank !== null).length,
            queries: rows.length,
            mrrAt6: rows.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) / rows.length,
          },
        ];
      }),
    ),
    warmLatency: {
      queries: sorted.length,
      p50Ms: sorted[Math.floor(sorted.length * 0.5)],
      p95Ms: sorted[Math.floor(sorted.length * 0.95)],
      maxMs: sorted.at(-1),
    },
    results,
    limitations: [
      "Manually seeded data: does not measure automatic learning or agent utility",
      "No LLM calls or provider token measurements",
      "Small synthetic corpus; distractors are repetitive",
      "Warm latency measures search only, excluding model, runtime and database-open time",
    ],
  };
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      output,
      summary: report.summary,
      semantics: report.semantics,
      latency: report.warmLatency,
    }),
  );
} finally {
  await store.close();
}
