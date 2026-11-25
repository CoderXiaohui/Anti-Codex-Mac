import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  createAntigravityAcpClient,
  resolveAntigravityAcpExecutable,
} from "../provider/antigravity-acp-client.mjs";
import { mapAntigravityProviderError } from "../antigravity-contract.mjs";

const WORKSPACE = resolve("test-workspace");
const GEMINI_DIR = resolve("test-profile", "gemini-private");
const FAKE_EXECUTABLE = process.platform === "win32"
  ? "C:\\Trusted\\agy.exe"
  : "/trusted/agy";

class FakeChild extends EventEmitter {
  constructor(onMessage) {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.messages = [];
    this.killed = false;
    this.exited = false;
    this._onMessage = onMessage;
    this._input = "";
    this._waiters = [];
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk) => {
      this._input += chunk;
      let newline = this._input.indexOf("\n");
      while (newline >= 0) {
        const line = this._input.slice(0, newline).trim();
        this._input = this._input.slice(newline + 1);
        if (line) {
          const message = JSON.parse(line);
          this.messages.push(message);
          this.emit("client-message", message);
          this._onMessage?.(message, this);
        }
        newline = this._input.indexOf("\n");
      }
    });
    this.stdin.on("finish", () => setImmediate(() => this.exit(0, null)));
  }

  respond(id, result) {
    this.send({ jsonrpc: "2.0", id, result });
  }

  request(id, method, params) {
    this.send({ jsonrpc: "2.0", id, method, params });
  }

  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  send(message) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  async waitForClientMessage(predicate, timeoutMs = 500) {
    const existing = this.messages.find(predicate);
    if (existing) return existing;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("client-message", onMessage);
        reject(new Error("Timed out waiting for client message"));
      }, timeoutMs);
      const onMessage = (message) => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        this.off("client-message", onMessage);
        resolve(message);
      };
      this.on("client-message", onMessage);
    });
  }

  kill(signal = "SIGTERM") {
    this.killed = true;
    setImmediate(() => this.exit(0, signal));
    return true;
  }

  exit(code = 0, signal = null) {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
    this.stdout.end();
    this.stderr.end();
  }
}

const defaultOptions = () => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "gemini-4-carbon",
    options: [
      { value: "gemini-4-argon", name: "Gemini 4 Argon" },
      { value: "gemini-4-carbon", name: "Gemini 4 Carbon" },
    ],
  },
  {
    id: "thinking_level",
    name: "Thinking level",
    category: "thought_level",
    type: "select",
    currentValue: "low",
    options: [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
    ],
  },
];

function makeSpawner({
  configOptions = defaultOptions(),
  systemPromptAppend = true,
  onPrompt,
  onMessage,
} = {}) {
  const children = [];
  const spawnCalls = [];
  const spawn = (command, args, spawnOptions) => {
    spawnCalls.push({ command, args, spawnOptions });
    let currentOptions = structuredClone(configOptions);
    const child = new FakeChild((message, currentChild) => {
      onMessage?.(message, currentChild);
      if (message.method === "initialize") {
        currentChild.respond(message.id, {
          protocolVersion: 1,
          agentCapabilities: {
            _meta: {
              antigravity: {
                ...(systemPromptAppend ? { systemPrompt: { append: true } } : {}),
              },
            },
          },
        });
      } else if (message.method === "session/new") {
        currentChild.respond(message.id, {
          sessionId: "session-1",
          configOptions: structuredClone(currentOptions),
        });
      } else if (message.method === "session/set_config_option") {
        currentOptions = currentOptions.map((option) => option.id === message.params.configId
          ? { ...option, currentValue: message.params.value }
          : option);
        currentChild.respond(message.id, {
          configOptions: structuredClone(currentOptions),
        });
      } else if (message.method === "session/prompt") {
        onPrompt?.(message, currentChild);
      }
    });
    children.push(child);
    return child;
  };
  return { spawn, children, spawnCalls };
}

test("opens a sandboxed ACP session with exact model, thinking level, appended instructions, and fixed stdio MCP", async () => {
  const fake = makeSpawner();
  const client = createAntigravityAcpClient({ spawn: fake.spawn, executablePath: FAKE_EXECUTABLE });
  const session = await client.open({
    cwd: WORKSPACE,
    model: "gemini-4-argon-high",
    geminiDir: GEMINI_DIR,
    systemInstructions: "Keep Codex as the tool executor.",
    toolServerUrl: "http://127.0.0.1:43123/mcp/0123456789abcdef0123456789abcdef",
    agentName: "codex-bridge",
  });

  try {
    assert.equal(session.sessionId, "session-1");
    assert.equal(fake.spawnCalls[0].command, FAKE_EXECUTABLE);
    assert.deepEqual(fake.spawnCalls[0].args, [
      "acp",
      "--gemini-dir",
      GEMINI_DIR,
      "--sandbox",
      "--agent",
      "codex-bridge",
    ]);
    const initialize = fake.children[0].messages.find((message) => message.method === "initialize");
    assert.deepEqual(initialize.params.clientCapabilities, {});
    const sessionNew = fake.children[0].messages.find((message) => message.method === "session/new");
    assert.deepEqual(sessionNew.params._meta, {
      antigravity: {
        systemPrompt: { append: "Keep Codex as the tool executor." },
        eagerMcpServers: ["anticodex"],
      },
    });
    assert.deepEqual(sessionNew.params.mcpServers, [{
      name: "anticodex",
      command: process.execPath,
      args: [fileURLToPath(new URL("../provider/antigravity-acp-mcp-stdio.mjs", import.meta.url))],
      env: [{
        name: "ANTICODEX_ACP_MCP_URL",
        value: "http://127.0.0.1:43123/mcp/0123456789abcdef0123456789abcdef",
      }],
      _meta: { antigravity: { forceAllToolsEager: true } },
    }]);
    assert.deepEqual(fake.children[0].messages
      .filter((message) => message.method === "session/set_config_option")
      .map(({ params }) => [params.configId, params.value]), [
      ["model", "gemini-4-argon"],
      ["thinking_level", "high"],
    ]);
  } finally {
    await session.close();
  }
});

test("uses an advertised legacy exact model value without silently switching models", async () => {
  const configOptions = [{
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "gemini-4-argon-low",
    options: [
      { value: "gemini-4-argon-low", name: "Gemini 4 Argon Low" },
      { value: "gemini-4-argon-high", name: "Gemini 4 Argon High" },
    ],
  }];
  const fake = makeSpawner({ configOptions });
  const client = createAntigravityAcpClient({ spawn: fake.spawn, executablePath: FAKE_EXECUTABLE });
  const session = await client.open({ cwd: WORKSPACE, model: "gemini-4-argon-high" });
  try {
    assert.deepEqual(fake.children[0].messages
      .filter((message) => message.method === "session/set_config_option")
      .map(({ params }) => [params.configId, params.value]), [
      ["model", "gemini-4-argon-high"],
    ]);
  } finally {
    await session.close();
  }
});

test("rejects unsupported instructions and models instead of falling back", async () => {
  const noPromptCapability = makeSpawner({ systemPromptAppend: false });
  const first = createAntigravityAcpClient({ spawn: noPromptCapability.spawn, executablePath: FAKE_EXECUTABLE });
  await assert.rejects(
    first.open({ cwd: WORKSPACE, model: "gemini-4-argon-high", systemInstructions: "Required." }),
    /systemPrompt\.append/i,
  );
  assert.equal(noPromptCapability.children[0].messages.some((message) => message.method === "session/new"), false);
  assert.equal(noPromptCapability.children[0].exited, true);

  const noHighEffort = makeSpawner({
    configOptions: [{
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "gemini-4-argon",
      options: [{ value: "gemini-4-argon", name: "Gemini 4 Argon" }],
    }],
  });
  const second = createAntigravityAcpClient({ spawn: noHighEffort.spawn, executablePath: FAKE_EXECUTABLE });
  await assert.rejects(
    second.open({ cwd: WORKSPACE, model: "gemini-4-argon-high" }),
    /exact.*model|thinking level/i,
  );
  assert.equal(noHighEffort.children[0].exited, true);
});

test("preserves text/image prompt blocks and denies permission requests by default", async () => {
  let promptId;
  const fake = makeSpawner({
    onPrompt(message, child) {
      promptId = message.id;
      child.request("permission-1", "session/request_permission", {
        sessionId: "session-1",
        toolCall: { toolCallId: "tool-1", kind: "execute", title: "Run a command" },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
        ],
      });
      child.notify("session/update", {
        sessionId: "session-1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } },
      });
    },
  });
  const client = createAntigravityAcpClient({ spawn: fake.spawn, executablePath: FAKE_EXECUTABLE });
  const session = await client.open({ cwd: WORKSPACE, model: "gemini-4-argon" });
  const textParts = [
    { type: "text", text: "Describe this image." },
    { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
  ];
  const receivedText = [];
  try {
    const prompt = session.prompt({ text: textParts, onText: (text) => receivedText.push(text) });
    const permissionResponse = await fake.children[0].waitForClientMessage((message) => message.id === "permission-1");
    assert.deepEqual(permissionResponse.result.outcome, { outcome: "selected", optionId: "reject-once" });
    const promptRequest = fake.children[0].messages.find((message) => message.id === promptId);
    assert.deepEqual(promptRequest.params.prompt, textParts);
    fake.children[0].respond(promptId, { stopReason: "end_turn" });
    assert.deepEqual(await prompt, { stopReason: "end_turn" });
    assert.deepEqual(receivedText, ["Hello"]);
  } finally {
    await session.close();
  }
});

test("permission callback receives the full request and can approve only allow-once", async () => {
  const permission = {
    sessionId: "session-1",
    toolCall: { toolCallId: "tool-2", kind: "read", title: "Read a file", rawInput: { path: "README.md" } },
    options: [
      { optionId: "trusted-read-once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
  };
  let callbackRequest;
  let promptId;
  const fake = makeSpawner({
    onPrompt(message, child) {
      promptId = message.id;
      child.request("permission-2", "session/request_permission", permission);
    },
  });
  const client = createAntigravityAcpClient({ spawn: fake.spawn, executablePath: FAKE_EXECUTABLE });
  const session = await client.open({
    cwd: WORKSPACE,
    model: "gemini-4-argon",
    onPermissionRequest: (request) => {
      callbackRequest = request;
      return permission.options[0].optionId;
    },
  });

  try {
    const prompt = session.prompt({ text: "Please read the README." });
    const permissionResponse = await fake.children[0].waitForClientMessage((message) => message.id === "permission-2");
    assert.equal(callbackRequest.method, "session/request_permission");
    assert.deepEqual(callbackRequest.params, permission);
    assert.deepEqual(permissionResponse.result.outcome, { outcome: "selected", optionId: "trusted-read-once" });
    fake.children[0].respond(promptId, { stopReason: "end_turn" });
    await prompt;
  } finally {
    await session.close();
  }
});

test("cancels a prompt through ACP and rejects pending requests when the process exits", async () => {
  let promptId;
  const fake = makeSpawner({
    onPrompt(message) { promptId = message.id; },
  });
  const client = createAntigravityAcpClient({ spawn: fake.spawn, executablePath: FAKE_EXECUTABLE });
  const session = await client.open({ cwd: WORKSPACE, model: "gemini-4-argon" });
  const controller = new AbortController();
  const prompt = session.prompt({ text: "Cancel me.", signal: controller.signal });
  try {
    await fake.children[0].waitForClientMessage((message) => message.method === "session/prompt");
    controller.abort();
    await assert.rejects(prompt, { name: "AbortError" });
    assert.ok(fake.children[0].messages.some((message) => message.method === "session/cancel"));
    fake.children[0].respond(promptId, { stopReason: "cancelled" });

    const pending = session.prompt({ text: "Will fail on process exit." });
    await fake.children[0].waitForClientMessage((message) => message.method === "session/prompt");
    fake.children[0].exit(2, null);
    await assert.rejects(pending, /process exited/i);
  } finally {
    await session.close();
  }
});

test("prompt timeout sends ACP cancellation and terminates the owned process", async () => {
  const fake = makeSpawner({ onPrompt() {} });
  const client = createAntigravityAcpClient({
    spawn: fake.spawn,
    executablePath: FAKE_EXECUTABLE,
    promptTimeoutMs: 20,
    closeTimeoutMs: 20,
    cancelGraceMs: 20,
  });
  const session = await client.open({ cwd: WORKSPACE, model: "gemini-4-argon" });

  try {
    await assert.rejects(session.prompt({ text: "This prompt never finishes." }), /timed out after 20ms/);
    assert.ok(fake.children[0].messages.some((message) => message.method === "session/cancel"));
    assert.equal(fake.children[0].killed, true);
  } finally {
    await session.close();
  }
});

test("a long prompt that keeps showing progress is not cut off by the idle limit", async () => {
  const fake = makeSpawner({
    onPrompt(message, child) {
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
        child.notify("session/update", {
          sessionId: "session-1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "." } },
        });
        if (ticks === 6) {
          clearInterval(timer);
          child.respond(message.id, { stopReason: "end_turn" });
        }
      }, 15);
    },
  });
  const client = createAntigravityAcpClient({ spawn: fake.spawn, executablePath: FAKE_EXECUTABLE, promptTimeoutMs: 40 });
  const session = await client.open({ cwd: WORKSPACE, model: "gemini-4-argon" });
  try {
    const result = await session.prompt({ text: "Work for a while.", onText() {} });
    assert.equal(result.stopReason, "end_turn");
  } finally {
    await session.close();
  }
});

test("rejects remote MCP URLs outside the fixed loopback secret route", async () => {
  const fake = makeSpawner();
  const client = createAntigravityAcpClient({ spawn: fake.spawn, executablePath: FAKE_EXECUTABLE });
  await assert.rejects(
    client.open({ cwd: WORKSPACE, model: "gemini-4-argon", toolServerUrl: "http://example.com/mcp/secret" }),
    /127\.0\.0\.1.*mcp/i,
  );
  assert.equal(fake.spawnCalls.length, 0);
});

test("strips model-provider credentials from the ACP child environment while retaining runtime PATH", async () => {
  const names = [
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "AGY_ADC_AUTH",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "DEEPSEEK_API_KEY",
  ];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  const pathBefore = process.env.PATH;
  for (const name of names) process.env[name] = `test-${name.toLowerCase()}`;
  try {
    const fake = makeSpawner();
    const client = createAntigravityAcpClient({ spawn: fake.spawn, executablePath: FAKE_EXECUTABLE });
    const session = await client.open({ cwd: WORKSPACE, model: "gemini-4-argon" });
    try {
      const childEnv = fake.spawnCalls[0].spawnOptions.env;
      for (const name of names) assert.equal(childEnv[name], undefined, `${name} must not reach agy`);
      assert.equal(
        Object.entries(childEnv).find(([name]) => name.toUpperCase() === "PATH")?.[1],
        pathBefore,
      );
    } finally {
      await session.close();
    }
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("requires an absolute product-provided geminiDir", async () => {
  const fake = makeSpawner();
  const client = createAntigravityAcpClient({ spawn: fake.spawn, executablePath: FAKE_EXECUTABLE });
  await assert.rejects(
    client.open({ cwd: WORKSPACE, model: "gemini-4-argon", geminiDir: "relative\\gemini" }),
    /geminiDir must be an absolute path/i,
  );
  assert.equal(fake.spawnCalls.length, 0);
});

test("preserves only explicit HTTP statuses from ACP JSON-RPC error data", async () => {
  const cases = [
    { status: 429, data: { httpStatus: 429 }, message: "upstream request failed" },
    { status: 502, data: { response: { statusCode: 502 } }, message: "quota backend returned a proxy error" },
    { status: 503, data: { status: 503 }, message: "upstream request failed" },
    { status: 504, data: { upstream: { http_status_code: 504 } }, message: "rate limit gateway timed out" },
  ];
  const fake = makeSpawner({
    onPrompt(message, child) {
      const item = cases.shift();
      child.send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: item.message, data: item.data },
      });
    },
  });
  const client = createAntigravityAcpClient({ spawn: fake.spawn, executablePath: FAKE_EXECUTABLE });
  const session = await client.open({ cwd: WORKSPACE, model: "gemini-4-argon" });
  try {
    for (const item of [
      { status: 429, data: { httpStatus: 429 }, message: "upstream request failed" },
      { status: 502, data: { response: { statusCode: 502 } }, message: "quota backend returned a proxy error" },
      { status: 503, data: { status: 503 }, message: "upstream request failed" },
      { status: 504, data: { upstream: { http_status_code: 504 } }, message: "rate limit gateway timed out" },
    ]) {
      await assert.rejects(session.prompt({ text: `status ${item.status}` }), (error) => {
        assert.equal(error.code, -32000, "JSON-RPC code remains a JSON-RPC code");
        assert.equal(error.acpHttpStatus, item.status);
        const mapped = mapAntigravityProviderError(error, TestAdapterError);
        assert.equal(mapped.statusCode, item.status);
        return true;
      });
    }
  } finally {
    await session.close();
  }
});

test("does not infer ACP HTTP status from a negative JSON-RPC code or unmarked native errors", async () => {
  const fake = makeSpawner({
    onPrompt(message, child) {
      child.send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: "upstream request failed", data: { code: -32000 } },
      });
    },
  });
  const client = createAntigravityAcpClient({ spawn: fake.spawn, executablePath: FAKE_EXECUTABLE });
  const session = await client.open({ cwd: WORKSPACE, model: "gemini-4-argon" });
  try {
    await assert.rejects(session.prompt({ text: "No explicit HTTP status." }), (error) => {
      assert.equal(error.acpHttpStatus, undefined);
      assert.equal(mapAntigravityProviderError(error, TestAdapterError).statusCode, 502);
      return true;
    });
  } finally {
    await session.close();
  }

  for (const status of [429, 503, 504]) {
    const nativeError = Object.assign(new Error("native upstream error"), { statusCode: status });
    assert.equal(mapAntigravityProviderError(nativeError, TestAdapterError).statusCode, status);
  }
});

class TestAdapterError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    Object.assign(this, options);
  }
}

test("official executable resolver returns null without a configured install root", () => {
  assert.equal(resolveAntigravityAcpExecutable({}), null);
});
