import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createOfficialAcpRoute,
  getOfficialModelCatalog,
  parseOfficialModelList,
} from "../provider/antigravity-official-route.mjs";
import { bridgeToolDecision } from "../provider/antigravity-acp-tool-policy.mjs";
import { buildFixedRoutePlan, buildUnifiedModelCatalog, refreshAntigravityRelayModelList } from "../../scripts/start-anticodex-fixed-route.mjs";

const officialModel = "anticodex/official/gemini-4-argon-high";
const entry = { slug: "gemini-4-argon-high", display_name: "Gemini 4 Argon (High)", visibility: "list", context_window: 100000, shell_type: "shell_command" };

test("restarting with an official selection keeps that model and the separate saved desktop model", () => {
  const plan = buildFixedRoutePlan([], {
    LOCALAPPDATA: "C:\\AntiCodex-Test\\Local", APPDATA: "C:\\AntiCodex-Test\\Roaming",
    ANTICODEX_PROVIDER: "antigravity", ANTICODEX_MODEL: officialModel,
    ANTICODEX_ANTIGRAVITY_MODEL: "gemini-4-carbon-high",
  });
  assert.equal(plan.model, officialModel);
  assert.equal(plan.route.clientModel, officialModel);
  assert.equal(plan.route.model, "gemini-4-carbon-high");
  assert.ok(plan.route.relayModelList.includes(officialModel));
});

test("only advertised official models appear in the existing composer and route to the local adapter", () => {
  const listed = parseOfficialModelList("Fetching available models...\n\u001b[32mgemini-4-argon-high\tGemini 4 Argon (High)\u001b[0m\ngemini-4-argon-high\tDuplicate\ninvalid model\tBogus\n");
  const official = getOfficialModelCatalog(listed, { models: [entry] });
  const catalog = buildUnifiedModelCatalog({ models: [entry] }, { antigravityCatalog: { models: [entry] }, officialModels: official });
  const current = catalog.models.find(model => model.slug === officialModel);
  assert.equal(current.display_name, "Antigravity 官方 · Gemini 4 Argon (High)");
  assert.equal(current.context_window, entry.context_window);
  assert.equal(catalog.models.filter(model => model.slug.startsWith("anticodex/official/")).length, 1);
  assert.equal(catalog.models.find(model => model.slug === entry.slug).display_name, "Antigravity · Gemini 4 Argon (High)");
  const third = { id: "anticodex-third-party", modelList: "existing/api-model" };
  const settings = refreshAntigravityRelayModelList({relayProfiles:[{id:"anticodex-antigravity"},third]}, {models:[entry]}, official);
  assert.ok(settings.relayProfiles[0].modelList.split("\n").includes(officialModel));
  assert.deepEqual(settings.relayProfiles[1],third);
});

test("ACP access uses an isolated profile and only forwards editor-owned tools", async () => {
  assert.equal(bridgeToolDecision({ toolCall: { name: "view_file", title: "mcp_anticodex_exec_command" } }), "deny");
  assert.equal(bridgeToolDecision({ toolCall: { name: "run_command" } }), "deny");
  assert.equal(bridgeToolDecision({ toolCall: { name: "mcp_other_exec_command" } }), "deny");
  assert.equal(bridgeToolDecision({ toolCall: { name: "mcp_anticodex_exec_command" } }), "force_ask");
  const temp = mkdtempSync(join(tmpdir(), "anticodex-official-test-"));
  const desktop = { stream() { throw Error("desktop was called"); }, complete() { throw Error("desktop was called"); }, models:async()=>({object:"list",data:[]}), close: async()=>{} };
  let openArgs;
  const fakeClient = {async open(args) {
    openArgs=args;
    return {sessionId:"acp-fixture",async prompt({onText}) {onText("official answer");return {stopReason:"end_turn"};},async close(){}};
  }};
  let route;
  try {
    route=createOfficialAcpRoute({desktop, client:fakeClient, temp, officialModels:()=>[{slug:officialModel,display_name:"official"}]});
    const result=await route.complete({model:officialModel,messages:[{role:"system",content:"Keep the user's permissions."},{role:"user",content:"Hello."}]},{conversationKey:"fixture-thread"});
    assert.equal(result.model,officialModel);
    assert.equal(result.choices[0].message.content,"official answer");
    assert.ok(openArgs.cwd.startsWith(temp));
    const rules=JSON.parse(readFileSync(join(openArgs.geminiDir,"antigravity-cli","settings.json"),"utf8"));
    assert.ok(rules.permissions.deny.includes("command(*)"));
    assert.ok(rules.permissions.deny.includes("write_file(*)"));
    assert.ok(readFileSync(join(openArgs.geminiDir,"config","hooks.json"),"utf8").includes("PreToolUse"));
    assert.ok(readFileSync(join(openArgs.geminiDir,"config","editor-tool-policy.mjs"),"utf8").includes("bridgeToolDecision"));
    assert.match(openArgs.systemInstructions,/Keep the user's permissions/);
    assert.equal(openArgs.model,"gemini-4-argon-high");
    await assert.rejects(route.complete({model:"anticodex/official/unlisted",messages:[]}), /模型|model/i);
  } finally {
    await route?.close();
    rmSync(temp,{recursive:true,force:true});
  }
});

test("an official Antigravity entry identifies the real agent and retains all other host instructions", () => {
  const base = "You are Codex, an agent based on GPT-6. Keep every tool approval and the user's project rules.";
  const policy = {permissions:{read_only:"read-only"},approvals:{ask:"ask before edits"},instructions_template:base};
  const native = {...entry,base_instructions:base,model_messages:policy};
  const [official] = getOfficialModelCatalog([{id:entry.slug,label:entry.display_name}], {models:[native]});
  const expected = "You are the Google Antigravity agent working in the Codex editor. Keep every tool approval and the user's project rules.";
  assert.equal(official.base_instructions, expected);
  assert.deepEqual(official.model_messages, {...policy,instructions_template:expected});
  assert.equal(native.base_instructions,base);
  assert.equal(native.model_messages.instructions_template,base);
});

test("models the official CLI serves get official entries and plain desktop selections use the official route", async () => {
  const hiddenOnDesktop = { ...entry, slug: "claude-opus-5-5-high", display_name: "Claude Opus 5.5 (High)", visibility: "hide" };
  const template = { ...entry, slug: "template", base_instructions: "You are Codex, an agent based on GPT-6. Keep approvals." };
  const official = getOfficialModelCatalog([
    { id: "claude-opus-5-5-high", label: "Claude Opus 5.5 (High)" },
    { id: "gemini-4-neon-low", label: "Gemini 4 Neon (Low)" },
  ], { models: [hiddenOnDesktop] }, template);
  assert.deepEqual(official.map(model => [model.slug, model.visibility]), [
    ["anticodex/official/claude-opus-5-5-high", "list"],
    ["anticodex/official/gemini-4-neon-low", "list"],
  ]);
  assert.equal(official[1].default_reasoning_level, "low");
  assert.match(official[1].base_instructions, /^You are the Google Antigravity agent/);

  const catalog = buildUnifiedModelCatalog({ models: [entry] }, { antigravityCatalog: { models: [entry] }, officialModels: getOfficialModelCatalog([{ id: entry.slug, label: entry.display_name }], { models: [entry] }) });
  assert.equal(catalog.models.find(model => model.slug === entry.slug).visibility, "hide");

  const temp = mkdtempSync(join(tmpdir(), "anticodex-official-test-"));
  const desktop = { stream() { throw Error("desktop was called"); }, complete() { throw Error("desktop was called"); }, close: async () => {} };
  let openedModel;
  const fakeClient = { async open(args) {
    openedModel = args.model;
    return { sessionId: "acp-plain", async prompt({ onText }) { onText("official answer"); return { stopReason: "end_turn" }; }, async close() {} };
  } };
  let route;
  try {
    route = createOfficialAcpRoute({ desktop, client: fakeClient, temp, officialModels: () => [{ slug: officialModel, display_name: "official" }] });
    const result = await route.complete({ model: entry.slug, messages: [{ role: "user", content: "Hello." }] }, { conversationKey: "plain-thread" });
    assert.equal(result.model, entry.slug);
    assert.equal(openedModel, entry.slug);
    await assert.rejects(route.complete({ model: "claude-sonnet-4-6", messages: [] }), /desktop was called/);
  } finally {
    await route?.close();
    rmSync(temp, { recursive: true, force: true });
  }
});
