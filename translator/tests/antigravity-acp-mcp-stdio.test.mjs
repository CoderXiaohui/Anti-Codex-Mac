import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";

import { createAntigravityNativeMcpBridge } from "../antigravity-native-mcp-bridge.mjs";

import { runAntigravityAcpMcpStdio as runStdio } from "../provider/antigravity-acp-mcp-stdio.mjs";

test("rejects non-loopback URLs without echoing the secret", async () => {
  const secret = "sensitive-acp-bridge-secret-0123456789";
  const output = new PassThrough();
  await assert.rejects(
    runStdio({
      env: { ANTICODEX_ACP_MCP_URL: `http://localhost:12345/mcp/${secret}` },
      input: Readable.from([]),
      output,
    }),
    (error) => !error.message.includes(secret),
  );
});

test("forwards concurrent MCP requests and suppresses redirected bridge errors", async () => {
  const bridge = await createAntigravityNativeMcpBridge({
    tools: [{ name: "read_file", parameters: { type: "object" } }],
  });
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let captured = "";
  output.on("data", (chunk) => { captured += chunk; });

  try {
    const running = runStdio({
      env: { ANTICODEX_ACP_MCP_URL: bridge.url },
      input,
      output,
    });
    input.write([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: "first", method: "tools/call", params: { name: "read_file", arguments: { path: "first.txt" } } }),
      JSON.stringify({ jsonrpc: "2.0", id: "second", method: "tools/call", params: { name: "read_file", arguments: { path: "second.txt" } } }),
    ].join("\n") + "\n");

    const calls = await Promise.all([
      bridge.waitForCall({ timeoutMs: 1000 }),
      bridge.waitForCall({ timeoutMs: 1000 }),
    ]);
    for (const call of calls) {
      assert.equal(bridge.completeCall(call.callId, `read:${call.arguments.path}`), true);
    }
    input.end();
    await running;

    const responses = captured.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(responses.some((response) => response.id === 1 && response.result.protocolVersion), true);
    assert.deepEqual(new Set(responses.filter((response) => response.id === "first" || response.id === "second").map((response) => response.id)), new Set(["first", "second"]));
    assert.equal(responses.find((response) => response.id === "first").result.content[0].text, "read:first.txt");
    assert.equal(responses.find((response) => response.id === "second").result.content[0].text, "read:second.txt");
    assert.equal(captured.includes(bridge.secret), false);
  } finally {
    input.destroy();
    output.destroy();
    await bridge.close();
  }
});

test("uses redirect:error and returns a sanitized bridge failure", async () => {
  const secret = "sensitive-acp-bridge-secret-0123456789";
  const output = new PassThrough();
  output.setEncoding("utf8");
  let captured = "";
  output.on("data", (chunk) => { captured += chunk; });
  const input = Readable.from([
    `${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "initialize", params: {} })}\n`,
  ]);

  await runStdio({
    env: { ANTICODEX_ACP_MCP_URL: `http://127.0.0.1:12345/mcp/${secret}` },
    input,
    output,
    fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, "error");
      throw new TypeError(`redirect target contained ${secret}`);
    },
  });

  const response = JSON.parse(captured.trim());
  assert.equal(response.id, 4);
  assert.equal(response.error.code, -32000);
  assert.equal(response.error.message.includes(secret), false);
  assert.equal(captured.includes(secret), false);
  output.destroy();
});
