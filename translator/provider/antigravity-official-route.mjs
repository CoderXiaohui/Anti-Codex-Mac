import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify, stripVTControlCharacters } from "node:util";
import { createAntigravityChatAdapter, ChatAdapterError } from "./antigravity-chat-adapter.mjs";
import { createAcpEnvironment, createAntigravityAcpClient, resolveAntigravityAcpExecutable } from "./antigravity-acp-client.mjs";
import { createAntigravityAcpTurns } from "./antigravity-acp-turns.mjs";
import { OFFICIAL_MODEL_PREFIX } from "../antigravity-contract.mjs";
import { antigravityReasoningEffortFor } from "../antigravity-model-catalog.mjs";

const runFile = promisify(execFile);
export { OFFICIAL_MODEL_PREFIX };

export function parseOfficialModelList(output) {
  const entries = new Map();
  for (const line of stripVTControlCharacters(String(output)).split(/\r?\n/)) {
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\t+([^\t\p{Cc}]{1,180})$/u.exec(line.trim());
    if (match && !entries.has(match[1])) entries.set(match[1], { id: match[1], label: match[2] });
  }
  return [...entries.values()];
}

export async function listOfficialAcpModels(env = process.env) {
  const executable = resolveAntigravityAcpExecutable(env);
  if (!executable) return [];
  const { stdout } = await runFile(executable, ["models"], {
    env: createAcpEnvironment(env),
    cwd: dirname(executable),
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 512 * 1024,
  });
  return parseOfficialModelList(stdout);
}

export function getOfficialModelCatalog(listed, nativeCatalog, template = null) {
  const models = new Map((nativeCatalog?.models ?? []).map(entry => [entry.slug, entry]));
  return listed.flatMap(({id, label}) => {
    // The official CLI list is authoritative. Desktop may hide or never list a model the CLI serves,
    // so build those entries from the bundled host template instead of dropping them.
    const model = models.get(id) ?? modelFromTemplate(template, id, label);
    if (!model) return [];
    const official = {...model, slug: OFFICIAL_MODEL_PREFIX + id, display_name: "Antigravity 官方 · " + label, visibility: "list"};
    // The bundled host template names its own GPT model. Only adapt that identity
    // declaration for the external agent. Keep policy and user instructions intact.
    const correctIdentity = value => value.replace(
      /^You are Codex, an agent based on GPT-6\./u,
      "You are the Google Antigravity agent working in the Codex editor.",
    );
    if (typeof model.base_instructions === "string") official.base_instructions = correctIdentity(model.base_instructions);
    if (typeof model.model_messages?.instructions_template === "string") {
      official.model_messages = { ...model.model_messages, instructions_template: correctIdentity(model.model_messages.instructions_template) };
    }
    return [official];
  });
}

function prepareProfile(temp) {
  const parent = resolve(temp);
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "official-acp-"));
  const workspace = join(root, "workspace");
  const geminiDir = join(root, "gemini");
  try {
    mkdirSync(workspace);
    mkdirSync(join(geminiDir, "config"), { recursive: true });
    mkdirSync(join(geminiDir, "antigravity-cli"));
    const hookName = "editor-tool-policy.mjs";
    // ACP resolves a relative hook command from the directory containing hooks.json.
    copyFileSync(fileURLToPath(new URL("./antigravity-acp-tool-policy.mjs", import.meta.url)), join(geminiDir, "config", hookName));
    writeFileSync(join(geminiDir, "config", "hooks.json"), JSON.stringify({
      "codex-editor-tools": {
        enabled: true,
        PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: "node ./" + hookName }] }],
      },
    }));
    writeFileSync(join(geminiDir, "antigravity-cli", "settings.json"), JSON.stringify({
      toolPermission: "request-review",
      permissions: {
        deny: ["command(*)", "write_file(*)", "read_file(*)", "read_url(*)", "execute_url(*)"],
        ask: ["mcp(*)"],
      },
    }));
    return { root, workspace, geminiDir };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function createOfficialAcpRoute({desktop, temp, officialModels, cachedDesktopModels, adapterOptions, client = createAntigravityAcpClient()}) {
  let profile;
  const routes = new Map();
  // Desktop entries the official CLI also serves run on the official route, so they share its
  // working quota path instead of the desktop Cascade bridge.
  function officialSlug(model) {
    if (typeof model !== "string") return "";
    if (model.startsWith(OFFICIAL_MODEL_PREFIX)) return model;
    return officialModels().some(entry => entry.slug === OFFICIAL_MODEL_PREFIX + model) ? OFFICIAL_MODEL_PREFIX + model : "";
  }
  function dispatch(body) {
    const model = officialSlug(body?.model);
    if (!model) return desktop;
    if (!officialModels().some(entry => entry.slug === model && entry.visibility !== "hide")) {
      throw new ChatAdapterError("所选官方模型当前不可用，请刷新模型列表。", { statusCode: 400, code: "model_not_available" });
    }
    if (!routes.has(model)) {
      profile ??= prepareProfile(temp);
      const turns = createAntigravityAcpTurns({ client, workspace: profile.workspace, geminiDir: profile.geminiDir });
      const adapter = createAntigravityChatAdapter({ ...adapterOptions, client: turns, maxSessions: 8 });
      routes.set(model, { adapter, turns });
    }
    return routes.get(model).adapter;
  }
  function input(body) {
    const model = officialSlug(body?.model);
    return model ? { ...body, model: model.slice(OFFICIAL_MODEL_PREFIX.length) } : body;
  }
  return {
    account(options = {}) {
      if (!options.model?.startsWith(OFFICIAL_MODEL_PREFIX)) return desktop.account(options);
      return { object: "antigravity.account", provider: "antigravity-official", signedIn: null, identityAvailable: null };
    },
    async models(options) {
      const catalog = cachedDesktopModels
        ? { object: "list", data: cachedDesktopModels().map(listEntry) }
        : await desktop.models(options);
      return { ...catalog, data: [...catalog.data, ...officialModels().map(listEntry)] };
    },
    async *stream(body, options) {
      const adapter = dispatch(body);
      for await (const chunk of adapter.stream(input(body), options)) {
        yield adapter === desktop ? chunk : { ...chunk, model: body.model };
      }
    },
    async complete(body, options) {
      const adapter = dispatch(body);
      const result = await adapter.complete(input(body), options);
      return adapter === desktop ? result : { ...result, model: body.model };
    },
    getDiagnostics: () => desktop.getDiagnostics?.(),
    async close() {
      try {
        const shutdowns = [...routes.values()].map(async ({ adapter, turns }) => {
          try { await turns.close(); } finally { await adapter.close(); }
        });
        const results = await Promise.allSettled([...shutdowns, desktop.close()]);
        const failed = results.find(result => result.status === "rejected");
        if (failed) throw failed.reason;
      } finally {
        routes.clear();
        if (profile && dirname(profile.root) === resolve(temp)) {
          rmSync(profile.root, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
        }
        profile = null;
      }
    },
  };
}

function listEntry(model) {
  return { object: "model", id: model.slug, display_name: model.display_name, owned_by: "antigravity" };
}

function modelFromTemplate(template, id, label) {
  if (!template) return null;
  const effort = antigravityReasoningEffortFor(id, label);
  return {
    ...template,
    slug: id,
    description: `Antigravity official model ${label}`,
    default_reasoning_level: effort,
    supported_reasoning_levels: [{ effort, description: `Antigravity ${effort} reasoning` }],
  };
}
