import test from "node:test";
import assert from "node:assert/strict";

import {
  selectDefaultCodexPlusPlusModel,
  testCodexPlusPlusUpstreamConnection,
} from "../provider/codexplusplus-upstream-probe.mjs";

test("blank auto-discovery skips image models and selects text model", async () => {
  const calls = [];
  const stages = await testCodexPlusPlusUpstreamConnection({
    protocol: "openai-compatible",
    baseUrl: "http://127.0.0.1:8090/v1",
    model: "",
    apiKey: "AUTO_SECRET",
  }, {
    discoverModels: true,
    fetchImpl: async (url, init) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "gpt-image-1" }, { id: "gpt-5.2" }] }), { status: 200 });
      }
      if (init?.body && JSON.parse(init.body).model === "gpt-image-1") {
        return new Response(JSON.stringify({ error: { message: "image model not chat-capable" } }), { status: 400 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }), { status: 200 });
    },
  });
  assert.equal(calls[1].body.model, "gpt-5.2");
  assert.equal(stages.every((stage) => stage.status !== "fail"), true);
});

test("all non-chat model list yields no selectable text model", () => {
  assert.equal(selectDefaultCodexPlusPlusModel(["gpt-image-1", "gpt-image-2"]), "");
});

test("HTTP 200 body with error object is not ready", async () => {
  const stages = await testCodexPlusPlusUpstreamConnection({
    protocol: "openai-compatible",
    baseUrl: "https://api.example.test/v1",
    model: "chat-model",
    apiKey: "secret",
  }, {
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: "boom" } }), { status: 200 }),
  });
  assert.equal(stages.at(-1).status, "fail");
});
