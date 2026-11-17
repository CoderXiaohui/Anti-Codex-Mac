import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCodexPlusPlusProbeRequest,
  discoverCodexPlusPlusUpstreamModels,
  normalizeCodexPlusPlusProbeProfile,
  testCodexPlusPlusUpstreamConnection,
} from "../provider/codexplusplus-upstream-probe.mjs";

test("probe profile accepts only Chat Completions and Responses", () => {
  assert.equal(normalizeCodexPlusPlusProbeProfile({
    protocol: "openai-compatible",
    baseUrl: "https://api.example.test/v1",
    model: "chat-model",
    apiKey: "secret",
  }).protocol, "chatCompletions");
  assert.equal(normalizeCodexPlusPlusProbeProfile({
    protocol: "responses",
    baseUrl: "https://api.example.test/v1",
    model: "response-model",
    apiKey: "secret",
  }).protocol, "responses");
  assert.throws(() => normalizeCodexPlusPlusProbeProfile({
    protocol: "anthropic",
    baseUrl: "https://api.example.test/v1",
    model: "model",
    apiKey: "secret",
  }), /Chat Completions or Responses/);
});

test("probe requests use the protocol-native endpoint and body", () => {
  const chat = buildCodexPlusPlusProbeRequest({
    protocol: "openai-compatible",
    baseUrl: "https://api.example.test/v1",
    model: "chat-model",
    apiKey: "secret",
  });
  assert.equal(chat.url, "https://api.example.test/v1/chat/completions");
  assert.equal(chat.body.model, "chat-model");
  assert.deepEqual(chat.body.messages, [{ role: "user", content: "Reply with OK only." }]);

  const responses = buildCodexPlusPlusProbeRequest({
    protocol: "responses",
    baseUrl: "https://api.example.test/v1/responses",
    model: "response-model",
    apiKey: "secret",
  });
  assert.equal(responses.url, "https://api.example.test/v1/responses");
  assert.equal(responses.body.input, "Reply with OK only.");
  assert.equal(responses.body.max_output_tokens, 8);
});

test("connection probe performs one bounded request and never returns the key", async () => {
  const calls = [];
  const stages = await testCodexPlusPlusUpstreamConnection({
    protocol: "responses",
    baseUrl: "https://api.example.test/v1",
    model: "response-model",
    apiKey: "TOP_SECRET_KEY",
  }, {
    timeoutMs: 1000,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "resp_probe", output_text: "OK" }), { status: 200 });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.test/v1/responses");
  assert.equal(calls[0].init.headers.authorization, "Bearer TOP_SECRET_KEY");
  assert.equal(stages.every((stage) => stage.status !== "fail"), true);
  assert.equal(JSON.stringify(stages).includes("TOP_SECRET_KEY"), false);
});

test("connection probe sanitizes provider failures", async () => {
  const stages = await testCodexPlusPlusUpstreamConnection({
    protocol: "openai-compatible",
    baseUrl: "https://api.example.test/v1",
    model: "chat-model",
    apiKey: "FAIL_SECRET_KEY",
  }, {
    fetchImpl: async () => new Response("bad FAIL_SECRET_KEY request", { status: 401 }),
  });
  assert.equal(stages.at(-1).status, "fail");
  assert.equal(JSON.stringify(stages).includes("FAIL_SECRET_KEY"), false);
  assert.match(stages.at(-1).detail, /HTTP 401/);
});

test("connection probe rejects HTTP 200 bodies that do not match the selected protocol", async () => {
  const stages = await testCodexPlusPlusUpstreamConnection({
    protocol: "openai-compatible",
    baseUrl: "https://api.example.test/v1",
    model: "chat-model",
    apiKey: "secret",
  }, {
    fetchImpl: async () => new Response(JSON.stringify({ output_text: "not a chat completion" }), { status: 200 }),
  });
  assert.equal(stages.at(-1).status, "fail");
  assert.match(stages.at(-1).detail, /Chat Completions response/i);
});

test("model discovery reads OpenAI-compatible ids without leaking the key", async () => {
  const calls = [];
  const models = await discoverCodexPlusPlusUpstreamModels({
    protocol: "openai-compatible",
    baseUrl: "http://127.0.0.1:8080/v1",
    model: "selected-model",
    apiKey: "DISCOVERY_SECRET",
  }, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: [
        { id: "selected-model" },
        { id: "another-model" },
        { id: "selected-model" },
      ] }), { status: 200 });
    },
  });
  assert.deepEqual(models, ["selected-model", "another-model"]);
  assert.equal(calls[0].url, "http://127.0.0.1:8080/v1/models");
  assert.equal(calls[0].init.headers.authorization, "Bearer DISCOVERY_SECRET");
});

test("model discovery keeps every valid provider id beyond 200 and skips invalid entries", async () => {
  const expected = Array.from({ length: 250 }, (_, index) => `text-model-${String(index).padStart(3, "0")}`);
  const models = await discoverCodexPlusPlusUpstreamModels({
    protocol: "openai-compatible",
    baseUrl: "http://127.0.0.1:8080/v1",
    apiKey: "DISCOVERY_SECRET",
  }, {
    fetchImpl: async () => new Response(JSON.stringify({ data: [
      ...expected.map((id) => ({ id })),
      { id: "" },
      { id: "invalid-model-id-".repeat(20) },
      { id: expected[0] },
    ] }), { status: 200 }),
  });
  assert.deepEqual(models, expected);
});

test("model discovery enforces an explicit response byte limit", async () => {
  const models = await discoverCodexPlusPlusUpstreamModels({
    protocol: "openai-compatible",
    baseUrl: "https://api.example.test/v1",
    apiKey: "DISCOVERY_SECRET",
  }, {
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: "model" }] }), {
      status: 200,
      headers: { "content-length": String(10 * 1024 * 1024 + 1) },
    }),
  });
  assert.deepEqual(models, []);
});

test("connection probe can attach discovered provider models", async () => {
  const calls = [];
  const stages = await testCodexPlusPlusUpstreamConnection({
    protocol: "openai-compatible",
    baseUrl: "https://api.example.test/v1",
    model: "selected-model",
    apiKey: "secret",
  }, {
    discoverModels: true,
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "selected-model" }, { id: "next-model" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }), { status: 200 });
    },
  });
  assert.deepEqual(calls, [
    "https://api.example.test/v1/chat/completions",
    "https://api.example.test/v1/models",
  ]);
  assert.deepEqual(stages.at(-1).models, ["selected-model", "next-model"]);
});

test("connection probe auto-discovers models and selects a default text model when model is blank", async () => {
  const calls = [];
  const stages = await testCodexPlusPlusUpstreamConnection({
    protocol: "openai-compatible",
    baseUrl: "http://127.0.0.1:8082/v1",
    model: "",
    apiKey: "AUTO_DISCOVER_SECRET",
  }, {
    discoverModels: true,
    fetchImpl: async (url, init) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({
          data: [
            { id: "text-embedding-3-small" },
            { id: "gpt-6-astra" },
            { id: "gpt-6.1-sol" },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }), { status: 200 });
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "http://127.0.0.1:8082/v1/models");
  assert.equal(calls[1].url, "http://127.0.0.1:8082/v1/chat/completions");
  assert.equal(calls[1].body.model, "gpt-6-astra");
  assert.equal(stages.every((stage) => stage.status !== "fail"), true);
  assert.deepEqual(stages.at(-1).models, ["text-embedding-3-small", "gpt-6-astra", "gpt-6.1-sol"]);
});
