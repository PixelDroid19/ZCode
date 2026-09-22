import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  zcodeProtocolMessageSchema,
  zcodeProtocolMethods,
  zcodeProtocolNotifications,
  zcodeProtocolRequestSchema,
  zcodeProtocolResponseSchema,
  zcodeSessionCapabilitiesChangedNotificationSchema,
  zcodeSessionRequestRuntimePreferencesParamsSchema,
  zcodeSessionRuntimePreferencesResultSchema,
  type ZCodeCapabilitiesStatus,
  type ZCodeProtocolMessage,
  type ZCodeProtocolRequestId,
} from "@zcode/shared";

export const LIVE_PROTOCOL_PROVIDER_ID = "protocol-live-provider";
export const LIVE_PROTOCOL_MODEL_ID = "protocol-live-model";
export const LIVE_PROTOCOL_TOOL_NAME = "live_word_count";

const FIXTURE_API_KEY = "fixture-key";
const DEFAULT_TIMEOUT_MS = 10_000;
const APP_SERVER_ARGUMENT = "app-server";
const PROTOCOL_BUNDLE_EXTENSION = ".cjs";

export interface OpenAiChatRequest {
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
}

export type OpenAiChatReply =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "tool_calls";
      readonly calls: readonly {
        readonly arguments: Record<string, unknown>;
        readonly id: string;
        readonly name: string;
      }[];
    };

type OpenAiChatScript = (
  request: OpenAiChatRequest,
  call: number,
) => OpenAiChatReply | Promise<OpenAiChatReply>;

export interface ProtocolFrame {
  readonly index: number;
  readonly message: ZCodeProtocolMessage;
}

export interface ProtocolResponse {
  readonly frame: ProtocolFrame;
  readonly id: ZCodeProtocolRequestId;
  readonly result: unknown;
}

interface PendingResponse {
  readonly reject: (error: Error) => void;
  readonly resolve: (response: ProtocolResponse) => void;
}

interface FrameListener {
  readonly reject: (error: Error) => void;
  readonly resolve: (frame: ProtocolFrame) => void;
  readonly startIndex: number;
  readonly predicate: (frame: ProtocolFrame) => boolean;
}

function isProtocolRequest(
  message: ZCodeProtocolMessage,
): message is ZCodeProtocolMessage & { id: ZCodeProtocolRequestId; method: string } {
  return "id" in message && "method" in message;
}

function isProtocolResponse(
  message: ZCodeProtocolMessage,
): message is ZCodeProtocolMessage & { id: ZCodeProtocolRequestId; result: unknown } {
  return "id" in message && "result" in message;
}

function isProtocolError(message: ZCodeProtocolMessage): message is ZCodeProtocolMessage & {
  id: ZCodeProtocolRequestId;
  error: { code: number; message: string };
} {
  return "id" in message && "error" in message;
}

function isProtocolNotification(
  message: ZCodeProtocolMessage,
): message is ZCodeProtocolMessage & { method: string; params?: unknown } {
  return "method" in message && !("id" in message);
}

function requestKey(id: ZCodeProtocolRequestId): string {
  return `${typeof id}:${String(id)}`;
}

function withTimeout<T>(
  promise: Promise<T>,
  description: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${description}`)),
      timeoutMs,
    );
    void promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function compactOutput(value: string): string {
  const normalized = value.trim();
  return normalized.length <= 4_000 ? normalized : `${normalized.slice(-4_000)}…`;
}

async function resolveAppServerArguments(bundlePath: string | undefined): Promise<string[]> {
  if (bundlePath === undefined) {
    const require = createRequire(import.meta.url);
    const source = fileURLToPath(new URL("../src/main.ts", import.meta.url));
    return [require.resolve("tsx/cli"), source, APP_SERVER_ARGUMENT];
  }
  if (!isAbsolute(bundlePath) || extname(bundlePath) !== PROTOCOL_BUNDLE_EXTENSION) {
    throw new Error("ZCODE_PROTOCOL_BUNDLE must be an absolute path to an existing .cjs file");
  }
  let bundleInfo;
  try {
    bundleInfo = await stat(bundlePath);
  } catch (error: unknown) {
    throw new Error("ZCODE_PROTOCOL_BUNDLE must be an absolute path to an existing .cjs file", {
      cause: error,
    });
  }
  if (!bundleInfo.isFile()) {
    throw new Error("ZCODE_PROTOCOL_BUNDLE must point to an existing .cjs file");
  }
  return [bundlePath, APP_SERVER_ARGUMENT];
}

export class LoopbackOpenAiServer {
  readonly requests: OpenAiChatRequest[] = [];

  private readonly requestListeners = new Set<() => void>();
  private readonly server: Server;
  private script?: OpenAiChatScript;
  private address?: string;
  private failure?: Error;

  constructor() {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  get baseUrl(): string {
    if (!this.address) throw new Error("Loopback OpenAI server has not started");
    return `${this.address}/v1`;
  }

  setScript(script: OpenAiChatScript): void {
    this.script = script;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Loopback OpenAI server did not expose a TCP address");
    }
    this.address = `http://127.0.0.1:${address.port}`;
  }

  async waitForRequestCount(count: number, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
    if (this.requests.length >= count) return;
    await withTimeout(
      new Promise<void>((resolve) => {
        const listener = () => {
          if (this.requests.length < count) return;
          this.requestListeners.delete(listener);
          resolve();
        };
        this.requestListeners.add(listener);
      }),
      `${count} loopback model requests (received ${this.requests.length})`,
      timeoutMs,
    );
  }

  assertHealthy(): void {
    if (this.failure) throw this.failure;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse<IncomingMessage>,
  ): Promise<void> {
    try {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        throw new Error(
          `Unexpected loopback request ${request.method ?? "unknown"} ${request.url ?? ""}`,
        );
      }
      const body = await readJsonBody(request);
      if (body.stream !== true)
        throw new Error("The CLI model request must use OpenAI-compatible SSE streaming");
      if (body.model !== LIVE_PROTOCOL_MODEL_ID) {
        throw new Error(`Unexpected fixture model ${String(body.model)}`);
      }
      const authorization = request.headers.authorization;
      if (authorization !== `Bearer ${FIXTURE_API_KEY}`) {
        throw new Error("The CLI did not send the fixture-only provider credential");
      }
      const chatRequest = { authorization, body };
      this.requests.push(chatRequest);
      for (const listener of this.requestListeners) listener();
      const reply = await this.script?.(chatRequest, this.requests.length);
      if (!reply)
        throw new Error(`No loopback model reply configured for call ${this.requests.length}`);
      writeSseReply(response, reply);
    } catch (error: unknown) {
      this.failure ??= errorFromUnknown(error);
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: this.failure.message } }));
    }
  }
}

export class ProtocolClient {
  readonly frames: ProtocolFrame[] = [];

  private readonly frameListeners = new Set<FrameListener>();
  private readonly pendingResponses = new Map<string, PendingResponse>();
  private readonly unexpectedRequests: string[] = [];
  private closed = false;
  private nextRequestId = 0;
  private stderr = "";
  private readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleStdoutLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    void this.exited.then(
      () =>
        this.rejectPending(
          new Error(`CLI exited before protocol request completed\n${compactOutput(this.stderr)}`),
        ),
      (error: unknown) => this.rejectPending(errorFromUnknown(error)),
    );
  }

  get frameCount(): number {
    return this.frames.length;
  }

  async request(
    method: string,
    params?: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<ProtocolResponse> {
    if (this.closed) throw new Error("Cannot send a protocol request after stdin has closed");
    const id = `live-protocol-${++this.nextRequestId}`;
    const message = zcodeProtocolRequestSchema.parse({
      id,
      method,
      ...(params === undefined ? {} : { params }),
    });
    const response = new Promise<ProtocolResponse>((resolve, reject) => {
      this.pendingResponses.set(requestKey(id), { reject, resolve });
    });
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    try {
      return await withTimeout(response, `${method} protocol response`, timeoutMs);
    } catch (error: unknown) {
      throw new Error(
        `${errorFromUnknown(error).message}\nCLI stderr:\n${compactOutput(this.stderr)}`,
      );
    }
  }

  async waitForCapability(
    input: {
      readonly afterFrame?: number;
      readonly description: string;
      readonly predicate: (status: ZCodeCapabilitiesStatus) => boolean;
      readonly sessionId: string;
    },
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<ProtocolFrame> {
    return await this.waitForFrame(
      input.description,
      (frame) => {
        if (!isProtocolNotification(frame.message)) return false;
        if (frame.message.method !== zcodeProtocolNotifications.sessionCapabilitiesChanged)
          return false;
        const notification = zcodeSessionCapabilitiesChangedNotificationSchema.parse(
          frame.message.params,
        );
        return notification.sessionId === input.sessionId && input.predicate(notification.status);
      },
      input.afterFrame ?? 0,
      timeoutMs,
    );
  }

  async waitForFrame(
    description: string,
    predicate: (frame: ProtocolFrame) => boolean,
    startIndex = 0,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<ProtocolFrame> {
    const current = this.frames.slice(startIndex).find(predicate);
    if (current) return current;
    return await withTimeout(
      new Promise<ProtocolFrame>((resolve, reject) => {
        this.frameListeners.add({ predicate, reject, resolve, startIndex });
      }),
      description,
      timeoutMs,
    );
  }

  assertNoUnexpectedServerRequests(): void {
    if (this.unexpectedRequests.length > 0) {
      throw new Error(
        `Unexpected server-to-client requests: ${this.unexpectedRequests.join(", ")}`,
      );
    }
  }

  async closeInputAndWait(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }> {
    if (!this.closed) {
      this.closed = true;
      this.child.stdin.end();
    }
    return await withTimeout(this.exited, "CLI app-server shutdown after stdin EOF", timeoutMs);
  }

  async dispose(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.child.stdin.end();
    }
    try {
      await withTimeout(this.exited, "CLI fixture cleanup", 2_000);
    } catch {
      if (!this.child.killed) this.child.kill("SIGTERM");
      await withTimeout(this.exited, "forced CLI fixture cleanup", 2_000).catch(() => undefined);
    }
  }

  private handleStdoutLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.rejectPending(new Error(`CLI emitted non-JSON stdout: ${line}`));
      return;
    }
    const parsed = zcodeProtocolMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.rejectPending(new Error(`CLI emitted invalid protocol stdout: ${parsed.error.message}`));
      return;
    }
    const frame: ProtocolFrame = { index: this.frames.length, message: parsed.data };
    this.frames.push(frame);
    this.notifyFrameListeners(frame);
    if (isProtocolResponse(parsed.data)) {
      const pending = this.pendingResponses.get(requestKey(parsed.data.id));
      if (!pending) return;
      this.pendingResponses.delete(requestKey(parsed.data.id));
      pending.resolve({ frame, id: parsed.data.id, result: parsed.data.result });
      return;
    }
    if (isProtocolError(parsed.data)) {
      const pending = this.pendingResponses.get(requestKey(parsed.data.id));
      if (!pending) return;
      this.pendingResponses.delete(requestKey(parsed.data.id));
      pending.reject(
        new Error(
          `Protocol ${String(parsed.data.id)} failed (${parsed.data.error.code}): ${parsed.data.error.message}`,
        ),
      );
      return;
    }
    if (isProtocolRequest(parsed.data)) this.handleServerRequest(parsed.data);
  }

  private handleServerRequest(request: {
    id: ZCodeProtocolRequestId;
    method: string;
    params?: unknown;
  }): void {
    let result: unknown;
    switch (request.method) {
      case zcodeProtocolMethods.interactionRequestPermission:
        result = { decision: "allow" };
        break;
      case zcodeProtocolMethods.sessionRequestRuntimePreferences:
        zcodeSessionRequestRuntimePreferencesParamsSchema.parse(request.params);
        result = zcodeSessionRuntimePreferencesResultSchema.parse({
          askUserQuestionAutoResolutionEnabled: true,
          memoryEnabled: false,
          modelContextBudgetStrategy: "preflight-v1",
          nativeSearchEnhancementsEnabled: false,
        });
        break;
      default:
        this.unexpectedRequests.push(request.method);
        return;
    }
    const response = zcodeProtocolResponseSchema.parse({ id: request.id, result });
    this.child.stdin.write(`${JSON.stringify(response)}\n`);
  }

  private notifyFrameListeners(frame: ProtocolFrame): void {
    for (const listener of this.frameListeners) {
      if (frame.index < listener.startIndex) continue;
      try {
        if (!listener.predicate(frame)) continue;
        this.frameListeners.delete(listener);
        listener.resolve(frame);
      } catch (error: unknown) {
        this.frameListeners.delete(listener);
        listener.reject(errorFromUnknown(error));
      }
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingResponses.values()) pending.reject(error);
    this.pendingResponses.clear();
    for (const listener of this.frameListeners) listener.reject(error);
    this.frameListeners.clear();
  }
}

export interface LiveProtocolFixture {
  readonly client: ProtocolClient;
  readonly home: string;
  readonly model: LoopbackOpenAiServer;
  readonly root: string;
  readonly toolRoot: string;
  readonly workspace: string;
  dispose(): Promise<void>;
}

export async function createLiveProtocolFixture(): Promise<LiveProtocolFixture> {
  const appServerArguments = await resolveAppServerArguments(process.env.ZCODE_PROTOCOL_BUNDLE);
  const root = await mkdtemp(join(tmpdir(), "zcode-live-protocol-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const data = join(root, "data");
  const toolRoot = join(workspace, ".zcode", "tools");
  const userConfig = join(home, ".zcode", "cli", "config.json");
  const projectConfig = join(workspace, ".zcode", "config.json");
  const providerConfig = join(root, "provider-config.json");
  const model = new LoopbackOpenAiServer();
  let client: ProtocolClient | undefined;
  try {
    await mkdir(toolRoot, { recursive: true });
    await mkdir(dirname(userConfig), { recursive: true });
    await Promise.all([
      writeFile(userConfig, JSON.stringify({ features: { mcp: false, memory: false } }), "utf8"),
      writeFile(projectConfig, "{}\n", "utf8"),
    ]);
    await model.start();
    await writeFile(
      providerConfig,
      `${JSON.stringify(providerConfigFile(model.baseUrl), null, 2)}\n`,
      "utf8",
    );
    const builtinConfig = fileURLToPath(
      new URL("../dist/provider/zcode-builtin.json", import.meta.url),
    );
    const env: NodeJS.ProcessEnv = {
      ALL_PROXY: "",
      HOME: home,
      HTTPS_PROXY: "",
      HTTP_PROXY: "",
      NO_PROXY: "127.0.0.1,localhost",
      PATH: process.env.PATH,
      USERPROFILE: home,
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_CONFIG_HOME: join(root, "config"),
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinConfig,
      ZCODE_DATA_BASE_DIR: data,
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: providerConfig,
      all_proxy: "",
      https_proxy: "",
      http_proxy: "",
      no_proxy: "127.0.0.1,localhost",
    };
    const child = spawn(process.execPath, appServerArguments, {
      cwd: workspace,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    client = new ProtocolClient(child);
    return {
      client,
      home,
      model,
      root,
      toolRoot,
      workspace,
      async dispose(): Promise<void> {
        await client?.dispose();
        await model.close();
        await rm(root, { force: true, recursive: true });
      },
    };
  } catch (error: unknown) {
    await client?.dispose();
    await model.close().catch(() => undefined);
    await rm(root, { force: true, recursive: true });
    throw error;
  }
}

export function requestToolNames(request: OpenAiChatRequest): Set<string> {
  const tools = Array.isArray(request.body.tools) ? request.body.tools : [];
  return new Set(
    tools.flatMap((tool) => {
      if (!tool || typeof tool !== "object") return [];
      const functionShape = (tool as { function?: unknown }).function;
      if (!functionShape || typeof functionShape !== "object") return [];
      const name = (functionShape as { name?: unknown }).name;
      return typeof name === "string" ? [name] : [];
    }),
  );
}

export function requestText(request: OpenAiChatRequest): string {
  return JSON.stringify(request.body.messages ?? []);
}

function providerConfigFile(baseUrl: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: LIVE_PROTOCOL_PROVIDER_ID,
            providerName: "Protocol live fixture",
            enabled: true,
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: FIXTURE_API_KEY },
              api: { type: "openai-chat-completions", baseUrl },
              personalModelIds: [LIVE_PROTOCOL_MODEL_ID],
              modelOrder: [LIVE_PROTOCOL_MODEL_ID],
            },
          },
        ],
      },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      defaultModelSelection: {
        providerId: LIVE_PROTOCOL_PROVIDER_ID,
        modelId: LIVE_PROTOCOL_MODEL_ID,
        options: { reasoningLevel: "disabled" },
      },
    },
  };
}

async function readJsonBody(stream: AsyncIterable<Uint8Array>): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of stream) body += Buffer.from(chunk).toString("utf8");
  const parsed: unknown = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Loopback model request must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function writeSseReply(response: ServerResponse<IncomingMessage>, reply: OpenAiChatReply): void {
  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream",
  });
  if (reply.kind === "tool_calls") {
    writeSseChunk(response, {
      choices: [
        {
          delta: {
            role: "assistant",
            tool_calls: reply.calls.map((call, index) => ({
              index,
              id: call.id,
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            })),
          },
          finish_reason: null,
        },
      ],
    });
    writeSseChunk(response, { choices: [{ delta: {}, finish_reason: "tool_calls" }] });
  } else {
    writeSseChunk(response, {
      choices: [{ delta: { role: "assistant", content: reply.text }, finish_reason: null }],
    });
    writeSseChunk(response, { choices: [{ delta: {}, finish_reason: "stop" }] });
  }
  writeSseChunk(response, {
    choices: [],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  response.end("data: [DONE]\n\n");
}

function writeSseChunk(
  response: ServerResponse<IncomingMessage>,
  value: Record<string, unknown>,
): void {
  response.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-live-protocol",
      object: "chat.completion.chunk",
      created: 0,
      model: LIVE_PROTOCOL_MODEL_ID,
      ...value,
    })}\n\n`,
  );
}
