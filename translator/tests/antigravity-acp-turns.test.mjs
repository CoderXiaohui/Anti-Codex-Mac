import test from "node:test";
import assert from "node:assert/strict";
import { createAntigravityChatAdapter } from "../provider/antigravity-chat-adapter.mjs";

import { createAntigravityAcpTurns, officialServiceError } from "../provider/antigravity-acp-turns.mjs";

let currentTurns;
let currentAdapter;

test.after(async () => {
  await currentAdapter?.close();
  await currentTurns?.close();
});

test("keeps trusted instructions separate, resumes the original MCP prompt, preserves images, and follows up", async () => {
  const observed = { open: null, prompts: [], closed: 0, callRequests: 0 };
  let sessionOptions;
  const client = {
    async open(options) {
      observed.open = options;
      sessionOptions = options;
      return {
        sessionId: "acp-session-1",
        async prompt(promptOptions) {
          observed.prompts.push(promptOptions);
          if (observed.prompts.length === 1) {
            const permission = (params) => options.onPermissionRequest({
              jsonrpc: "2.0",
              id: "permission-request",
              method: "session/request_permission",
              params,
            });
            const choices = [
              { optionId: "allow-once", kind: "allow_once" },
              { optionId: "reject-once", kind: "reject_once" },
            ];
            const allowed = await permission({
              sessionId: "acp-session-1",
              toolCall: { name: "mcp_anticodex_read_file", kind: "other", title: "untrusted display title", rawInput: { path: "a.txt" } },
              options: choices,
            });
            const sessionFilteredByClient = await permission({
              toolCall: { name: "mcp_anticodex_read_file", kind: "other" },
              options: choices,
            });
            const forged = await permission({
              sessionId: "acp-session-1",
              toolCall: { name: "mcp_anticodex_delete_everything", kind: "other", title: "mcp_anticodex_read_file", rawInput: { command: "delete everything" } },
              options: choices,
            });
            const staleSession = await permission({
              sessionId: "another-session",
              toolCall: { name: "mcp_anticodex_read_file", kind: "other" },
              options: choices,
            });
            const wrongMethod = await options.onPermissionRequest({
              jsonrpc: "2.0",
              id: "wrong-method",
              method: "session/other",
              params: { sessionId: "acp-session-1", toolCall: { name: "mcp_anticodex_read_file", kind: "other" }, options: choices },
            });
            assert.equal(allowed, "allow-once");
            assert.equal(sessionFilteredByClient, "reject-once");
            assert.equal(forged, "reject-once");
            assert.equal(staleSession, "reject-once");
            assert.equal(wrongMethod, null);

            const callTool = async (id, path) => {
              observed.callRequests += 1;
              const response = await fetch(options.toolServerUrl, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id,
                  method: "tools/call",
                  params: { name: "read_file", arguments: { path } },
                }),
              });
              return response.json();
            };
            await callTool("acp-tool-1", "a.txt");
            const secondResult = await callTool("acp-tool-2", "b.txt");
            promptOptions.onText(secondResult.result.content[0].text);
            return { output: secondResult.result.content };
          }
          promptOptions.onText("follow-up answer");
          return {};
        },
        async close() { observed.closed += 1; },
      };
    },
  };
  const turns = createAntigravityAcpTurns({
    client,
    workspace: "C:\\workspace",
    geminiDir: "C:\\state\\acp-session",
    agentName: "codex-turn",
  });
  currentTurns = turns;
  const requestAbort = new AbortController();
  let completedContinuation = null;
  const tools = [{
    type: "function",
    function: { name: "read_file", parameters: { type: "object" } },
  }];
  const startEvents = await collect(turns.start({
    model: "official-acp-model",
    userText: "Inspect this image and read a file.",
    userItems: [
      { text: "Inspect this image and read a file." },
      { inlineData: "iVBORw0KGgo=", mimeType: "image/png" },
    ],
    systemSections: [
      { kind: "instructions", role: "system", title: "System", content: "trusted system rule" },
      { kind: "instructions", role: "developer", title: "Developer", content: "trusted developer rule" },
      { kind: "native_custom_instructions", role: "user", title: "Managed", content: "trusted managed rule" },
      { kind: "tool_restart_continuation", role: "internal", title: "Managed recovery", content: "Do not repeat completed tool calls." },
      {
        kind: "chat_history",
        title: "History",
        contentTrust: "untrusted_transcript",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "untrusted prior message" },
            { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
          ],
        }],
      },
      { kind: "structured_output", title: "JSON schema", content: "Return JSON matching {\\\"ok\\\":true}." },
    ],
    tools,
    signal: requestAbort.signal,
    retainConversation: true,
    onTurnCompleted(continuation) { completedContinuation = continuation; },
  }));

  const toolEvent = startEvents.find((event) => event.type === "tool_calls");
  assert.ok(toolEvent);
  assert.equal(toolEvent.calls.length, 1);
  assert.equal(toolEvent.calls[0].name, "read_file");
  assert.equal(toolEvent.calls[0].arguments.path, "a.txt");
  assert.equal(toolEvent.continuation.sessionId, "acp-session-1");
  assert.equal(observed.open.cwd, "C:\\workspace");
  assert.equal(observed.open.geminiDir, "C:\\state\\acp-session");
  assert.equal(observed.open.model, "official-acp-model");
  assert.equal(observed.open.agentName, "codex-turn");
  assert.equal(observed.open.toolServerName, "anticodex");
  assert.equal(observed.open.signal instanceof AbortSignal, true);
  assert.match(observed.open.toolServerUrl, /^http:\/\/127\.0\.0\.1:\d+\/mcp\//u);
  assert.match(observed.open.systemInstructions, /trusted system rule/u);
  assert.match(observed.open.systemInstructions, /trusted developer rule/u);
  assert.match(observed.open.systemInstructions, /trusted managed rule/u);
  assert.match(observed.open.systemInstructions, /Do not repeat completed tool calls\./u);
  assert.doesNotMatch(observed.open.systemInstructions, /untrusted prior message|Return JSON matching/u);
  assert.equal(Array.isArray(observed.prompts[0].text), true);
  const promptText = observed.prompts[0].text
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  assert.match(promptText, /Inspect this image and read a file\./u);
  assert.match(promptText, /untrusted prior message/u);
  assert.match(promptText, /Return JSON matching/u);
  assert.equal(observed.prompts[0].text.filter((part) => part.type === "image").length, 2);

  requestAbort.abort(new Error("HTTP response closed after tool calls"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(observed.prompts[0].signal.aborted, false);

  const resumed = await collect(turns.resume(toolEvent.continuation, [{
    callId: toolEvent.calls[0].callId,
    output: "approved Codex tool result",
    isError: false,
  }], {
    model: "official-acp-model",
    tools,
    signal: new AbortController().signal,
    retainConversation: true,
    onTurnCompleted(continuation) { completedContinuation = continuation; },
  }));
  const secondToolEvent = resumed.find((event) => event.type === "tool_calls");
  assert.ok(secondToolEvent, "the original ACP prompt can request another Codex tool after the first result");
  assert.equal(observed.prompts.length, 1, "resume must continue the pending ACP prompt, not restart it");
  assert.equal(observed.callRequests, 2, "tool execution must not be replayed");

  const finalResume = await collect(turns.resume(secondToolEvent.continuation, [{
    callId: secondToolEvent.calls[0].callId,
    output: "second approved result",
    isError: false,
  }], {
    model: "official-acp-model",
    tools,
    signal: new AbortController().signal,
    retainConversation: true,
    onTurnCompleted(continuation) { completedContinuation = continuation; },
  }));
  assert.equal(observed.prompts.length, 1, "each resume must finish the same ACP prompt");
  assert.equal(observed.callRequests, 2, "completed MCP requests must never be repeated");
  assert.equal(finalResume.some((event) => event.type === "done"), true);
  assert.equal(completedContinuation, toolEvent.continuation);

  const followUp = await collect(turns.followUp(toolEvent.continuation, {
    model: "official-acp-model",
    userText: "continue",
    userItems: [{ text: "continue" }],
    tools,
    signal: new AbortController().signal,
    retainConversation: true,
    onTurnCompleted(continuation) { completedContinuation = continuation; },
  }));
  assert.equal(observed.prompts.length, 2);
  assert.equal(followUp.some((event) => event.type === "text_delta" && event.delta === "follow-up answer"), true);
  assert.equal(followUp.some((event) => event.type === "done"), true);

  await turns.cancel(toolEvent.continuation);
  assert.equal(observed.closed, 1);
});

test("route close aborts an ACP session that is still opening", async () => {
  let openingSignal;
  const turns = createAntigravityAcpTurns({
    client: {
      open({ signal }) {
        openingSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    },
    workspace: "C:\\workspace",
  });
  currentTurns = turns;
  const startResult = collect(turns.start({ model: "official-acp-model", userText: "hello" }))
    .then(() => null, (error) => error);
  await waitUntil(() => openingSignal instanceof AbortSignal);
  await turns.close();
  assert.equal(openingSignal.aborted, true);
  assert.ok(await startResult);
});

test("Chat adapter tool handoff retains ACP session for resume and follow-up", async () => {
  const observed = { opens: 0, prompts: 0, mcpCalls: 0, closes: 0 };
  const acpClient = {
    async open(options) {
      observed.opens += 1;
      return {
        sessionId: "adapter-session-1",
        async prompt(prompt) {
          observed.prompts += 1;
          if (observed.prompts === 1) {
            const permission = await options.onPermissionRequest({
              jsonrpc: "2.0",
              id: "permission-1",
              method: "session/request_permission",
              params: {
                sessionId: "adapter-session-1",
                toolCall: { name: "mcp_anticodex_read_file", kind: "other" },
                options: [{ optionId: "allow-once", kind: "allow_once" }, { optionId: "reject-once", kind: "reject_once" }],
              },
            });
            assert.equal(permission, "allow-once");
            observed.mcpCalls += 1;
            const response = await fetch(options.toolServerUrl, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: "adapter-tool-1",
                method: "tools/call",
                params: { name: "read_file", arguments: { path: "notes.txt" } },
              }),
            });
            const result = await response.json();
            prompt.onText(`Read result: ${result.result.content[0].text}`);
            return {};
          }
          prompt.onText("follow-up answer");
          return {};
        },
        async close() { observed.closes += 1; },
      };
    },
  };
  const turns = createAntigravityAcpTurns({
    client: acpClient,
    workspace: "C:\\workspace",
    geminiDir: "C:\\state\\acp-session",
  });
  currentTurns = turns;
  const adapter = createAntigravityChatAdapter({ client: turns });
  currentAdapter = adapter;
  const options = { conversationKey: "thread-acp-adapter" };
  const tools = [{
    type: "function",
    function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } },
  }];

  const first = await adapter.complete({
    model: "official-acp-model",
    messages: [{ role: "user", content: "Read notes.txt." }],
    tools,
  }, options);
  assert.equal(first.choices[0].finish_reason, "tool_calls");
  const [call] = first.choices[0].message.tool_calls;

  const second = await adapter.complete({
    model: "official-acp-model",
    messages: [
      { role: "user", content: "Read notes.txt." },
      { role: "assistant", content: null, tool_calls: first.choices[0].message.tool_calls },
      { role: "tool", tool_call_id: call.id, content: "Codex read the file." },
    ],
    tools,
  }, options);
  assert.equal(second.choices[0].message.content, "Read result: Codex read the file.");

  const third = await adapter.complete({
    model: "official-acp-model",
    messages: [
      { role: "user", content: "Read notes.txt." },
      { role: "assistant", content: null, tool_calls: first.choices[0].message.tool_calls },
      { role: "tool", tool_call_id: call.id, content: "Codex read the file." },
      { role: "assistant", content: second.choices[0].message.content },
      { role: "user", content: "Summarize it." },
    ],
    tools,
  }, options);
  assert.equal(third.choices[0].message.content, "follow-up answer");
  assert.deepEqual(observed, { opens: 1, prompts: 2, mcpCalls: 1, closes: 0 });
  await adapter.close();
  currentAdapter = null;
  assert.equal(observed.closes, 1);
});

test("closes a retained ACP session when a later prompt fails", async () => {
  let promptCount = 0;
  let closeCount = 0;
  let continuation;
  const turns = createAntigravityAcpTurns({
    workspace: "C:\\workspace",
    client: {
      async open() {
        return {
          sessionId: "failing-follow-up-session",
          async prompt(prompt) {
            promptCount += 1;
            if (promptCount > 1) throw new Error("ACP follow-up failed");
            prompt.onText("first answer");
            return {};
          },
          async close() { closeCount += 1; },
        };
      },
    },
  });
  currentTurns = turns;

  const first = await collect(turns.start({
    model: "official-acp-model",
    userText: "first turn",
    retainConversation: true,
    onTurnCompleted(value) { continuation = value; },
  }));
  assert.equal(first.some((event) => event.type === "done"), true);

  await assert.rejects(collect(turns.followUp(continuation, {
    model: "official-acp-model",
    userText: "second turn",
    userItems: [{ text: "second turn" }],
    retainConversation: true,
    onTurnCompleted(value) { continuation = value; },
  })), /ACP follow-up failed/u);
  assert.equal(closeCount, 1);
});

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

async function waitUntil(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition did not become true before timeout");
}

test("official CLI service failures become HTTP errors instead of chat answers", async () => {
  assert.equal(officialServiceError("\n\u26a0 RESOURCE_EXHAUSTED (code 429): quota\n").statusCode, 429);
  assert.equal(officialServiceError("\u26a0 UNAVAILABLE (code 503): No capacity available for model x").statusCode, 503);
  assert.equal(officialServiceError("\u26a0 This service has been disabled in this account for violation of Terms of Service.").statusCode, 403);
  assert.equal(officialServiceError("\u26a0 INVALID_ARGUMENT (code 400): bad tool name").statusCode, 400);
  assert.equal(officialServiceError("A normal answer"), null);

  const client = {
    async open() {
      return {
        sessionId: "acp-service-error",
        async prompt({ onText }) { onText("\n\u26a0 RESOURCE_EXHAUSTED (code 429): Resource has been exhausted.\n"); return { stopReason: "end_turn" }; },
        async close() {},
      };
    },
  };
  const turns = createAntigravityAcpTurns({ client, workspace: process.cwd() });
  const adapter = createAntigravityChatAdapter({ client: turns });
  try {
    await assert.rejects(
      adapter.complete({ model: "gemini-4-argon-high", messages: [{ role: "user", content: "Hi." }] }, { conversationKey: "service-error" }),
      (error) => error.statusCode === 429 && error.code === "quota_exceeded",
    );
  } finally {
    await adapter.close();
    await turns.close();
  }
});

test("a model the signed-in account cannot use is a clear 400 instead of a gateway failure", async () => {
  const client = { async open() { const error = new Error("The signed-in Antigravity account cannot use gemini-4-neon-high."); error.statusCode = 400; error.code = "model_not_available"; throw error; } };
  const turns = createAntigravityAcpTurns({ client, workspace: process.cwd() });
  const adapter = createAntigravityChatAdapter({ client: turns });
  try {
    await assert.rejects(
      adapter.complete({ model: "gemini-4-neon-high", messages: [{ role: "user", content: "Hi." }] }, { conversationKey: "model-unavailable" }),
      (error) => error.statusCode === 400 && error.code === "model_not_available",
    );
  } finally {
    await adapter.close();
    await turns.close();
  }
});
