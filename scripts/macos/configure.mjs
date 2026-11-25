import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { atomicWrite, clientEnvironment, privateDirectory } from "./common.mjs";
import { listOfficialAcpModels, OFFICIAL_MODEL_PREFIX } from "../../translator/provider/antigravity-official-route.mjs";
import { discoverCodexPlusPlusUpstreamModels, normalizeCodexPlusPlusProbeEndpoint, selectDefaultCodexPlusPlusModel } from "../../translator/provider/codexplusplus-upstream-probe.mjs";

export class Cancelled extends Error {}

function dialog(body, args) {
  const script = `on run argv\n${body}\nend run`;
  const result = spawnSync("/usr/bin/osascript", ["-e", script, "--", ...args], { encoding: "utf8" });
  if (result.status === 0) return result.stdout.trim();
  if (result.stderr?.includes("(-128)")) throw new Cancelled();
  throw new Error("无法显示 macOS 设置对话框。可在终端使用环境变量配置模型服务。");
}

function choose(title, items, selected = items[0]) {
  return dialog(`activate
    set itemsList to items 3 thru -1 of argv
    set answer to choose from list itemsList with title "Anti-Codex" with prompt (item 1 of argv) default items {item 2 of argv}
    if answer is false then error number -128
    return item 1 of answer`, [title, selected, ...items]);
}

function prompt(title, initial = "", secret = false) {
  return dialog(`activate
    return text returned of (display dialog (item 1 of argv) with title "Anti-Codex" default answer (item 2 of argv)${secret ? " with hidden answer" : ""})`, [title, initial]);
}

export function showError(message) {
  try { dialog('activate\ndisplay alert "Anti-Codex" message (item 1 of argv) as warning', [message]); } catch {}
}

export function agyEnvironment(paths) {
  const env = clientEnvironment(paths);
  // agy handles its own Google login. Its child processes still get our private CODEX_HOME.
  return { ...env, HOME: homedir(), CFFIXED_USER_HOME: homedir(), PATH: `${dirname(process.execPath)}:${env.PATH}` };
}

export async function officialModels(paths) {
  privateDirectory(paths.temp);
  const list = await listOfficialAcpModels(agyEnvironment(paths));
  if (!list.length) throw new Error("未取得 Antigravity 模型。请先安装 agy、登录并确认 agy models 能列出模型。");
  return list;
}

function modelId(value) {
  const id = String(value ?? "").trim();
  if (!id || id.length > 250 || /[\u0000-\u001f\u007f]/u.test(id)) throw new Error("模型 ID 无效。");
  return id;
}

export async function configure(paths, saved = null, env = process.env) {
  const unattended = Boolean(env.ANTICODEX_PROVIDER);
  const choices = { "第三方 API": "third-party", "Antigravity 官方（agy）": "antigravity" };
  const activeChoice = Object.keys(choices).find(key => choices[key] === saved?.provider);
  const provider = env.ANTICODEX_PROVIDER || choices[choose("选择模型服务", Object.keys(choices), activeChoice)];
  let profile;
  if (provider === "antigravity") {
    const list = await officialModels(paths);
    const ids = list.map(entry => entry.id);
    const requested = env.ANTICODEX_MODEL?.replace(OFFICIAL_MODEL_PREFIX, "");
    const model = unattended ? requested || ids[0] : choose("选择 Antigravity 默认模型", ids, ids.includes(saved?.model) ? saved.model : ids[0]);
    if (!ids.includes(model)) throw new Error("所选型号未出现在 agy models 中。");
    profile = { provider, model };
  } else if (provider === "third-party") {
    const protocols = { "Chat Completions": "chat", Responses: "responses" };
    const protocol = unattended ? env.UPSTREAM_PROTOCOL || "chat" : protocols[choose("选择服务商协议", Object.keys(protocols))];
    const baseUrl = unattended ? env.UPSTREAM_URL : prompt("输入服务商的 API Base URL（含 /v1 等路径）", saved?.baseUrl);
    const apiKey = unattended ? env.UPSTREAM_API_KEY : prompt("输入该服务商的 API Key", "", true);
    const endpoint = normalizeCodexPlusPlusProbeEndpoint({ protocol, baseUrl, apiKey });
    const models = (await discoverCodexPlusPlusUpstreamModels(endpoint)).slice(0, 200).map(modelId);
    const suggested = models.includes(saved?.model) ? saved.model : selectDefaultCodexPlusPlusModel(models) || models[0];
    const model = modelId(unattended ? env.UPSTREAM_MODEL || suggested : models.length
      ? choose("选择默认模型", models, suggested) : prompt("此服务商未返回模型目录，请输入完整模型 ID", saved?.model));
    if (models.length && !models.includes(model)) throw new Error("所选型号未出现在服务商模型目录中。");
    profile = { provider, protocol: endpoint.protocol, baseUrl: endpoint.baseUrl.href.replace(/\/$/, ""), apiKey, model, models: models.length ? models : [model] };
  } else throw new Error("ANTICODEX_PROVIDER 应为 third-party 或 antigravity。");
  atomicWrite(paths.profile, JSON.stringify(profile, null, 2) + "\n");
  return profile;
}
