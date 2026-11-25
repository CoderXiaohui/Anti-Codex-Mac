import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  buildCodexPlusPlusSettings, buildUnifiedModelCatalog, generateRouteConfig, getLauncherArgs,
  mergeCodexRouteConfig, selectNativeToolCatalogTemplate, thirdPartyNativeModel,
} from "../lib/anticodex-fixed-route.mjs";
import { createAntigravityChatServer } from "../../translator/provider/antigravity-chat-server.mjs";
import { createAntigravityAcpClient } from "../../translator/provider/antigravity-acp-client.mjs";
import { createOfficialAcpRoute, getOfficialModelCatalog, OFFICIAL_MODEL_PREFIX } from "../../translator/provider/antigravity-official-route.mjs";
import { normalizeCodexPlusPlusProbeProfile } from "../../translator/provider/codexplusplus-upstream-probe.mjs";
import { atomicWrite, clientEnvironment, hostId, inspectHost, lockSession, macPaths, privateDirectory, readProfile } from "./common.mjs";
import { agyEnvironment, Cancelled, configure, officialModels, showError } from "./configure.mjs";

const proxyPort = 18484;
const adapterPort = 18488;

function inspectRuntime() {
  const resources = resolve(import.meta.dirname, "../../..");
  const host = inspectHost(join(resources, "Desktop.app"), hostId);
  return { ...host, helper: join(resources, "codex-plus-plus") };
}

function focusCopy(host) {
  // NSRunningApplication activates only the already-running copy at this exact bundle URL.
  const script = `ObjC.import("AppKit");
    function run(args) {
      const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(args[0]);
      for (let i = 0; i < apps.count; i++) {
        const app = apps.objectAtIndex(i);
        if (ObjC.unwrap(app.bundleURL.path) === args[1]) return Boolean(app.activateWithOptions(3));
      }
      return false;
    }`;
  return execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, "--", hostId, host.bundle], { encoding: "utf8" }).trim() === "true";
}

async function requireFreePort(port) {
  const server = createServer();
  await new Promise((resolveReady, reject) => {
    server.once("error", () => reject(new Error(`本机端口 ${port} 已被占用，无法启动隔离路由。`)));
    server.listen(port, "127.0.0.1", () => server.close(resolveReady));
  });
}

function startChild(file, args, options) {
  const child = spawn(file, args, options);
  const exited = new Promise((done) => {
    child.once("error", (error) => done({ error }));
    child.once("exit", (code, signal) => done({ code, signal }));
  });
  return { child, exited };
}

async function stopChild(owned) {
  if (!owned?.child.pid || owned.child.exitCode !== null || owned.child.signalCode !== null) return;
  owned.child.kill("SIGTERM");
  const exited = await Promise.race([owned.exited, delay(4000, null, { ref: false })]);
  if (!exited) { owned.child.kill("SIGKILL"); await owned.exited; }
}

async function waitForProxy(pid, signal) {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    signal.throwIfAborted();
    const owner = spawnSync("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), `-iTCP@127.0.0.1:${proxyPort}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
    if (owner.stdout?.trim() === String(pid)) return;
    await delay(120, undefined, { signal });
  }
  throw new Error("等待 CodexPlusPlus 监听本机端口超时。");
}

export async function runDesktop(paths, host, profile) {
  // Darwin limits Unix socket paths to 103 bytes. User names and Application Support paths can exceed that.
  const temp = mkdtempSync("/private/tmp/anticodex-");
  try {
    await runSession({ ...paths, temp }, host, profile);
  } finally {
    rmSync(temp, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function runSession(paths, host, profile) {
  for (const dir of [paths.home, paths.userHome, paths.electron, paths.plus, paths.temp]) privateDirectory(dir);
  const env = clientEnvironment(paths);
  await requireFreePort(proxyPort);
  const isAcp = profile.provider === "antigravity";
  if (isAcp) await requireFreePort(adapterPort);
  else if (profile.provider === "third-party") normalizeCodexPlusPlusProbeProfile(profile);
  else throw new Error("无法识别已保存的模型服务。请重新配置。");

  const bundled = JSON.parse(execFileSync(host.cli, ["debug", "models", "--bundled"], {
    env, cwd: paths.home, encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
  }));
  const listed = isAcp ? getOfficialModelCatalog(await officialModels(paths), {}, selectNativeToolCatalogTemplate(bundled)) : [];
  const clientModel = isAcp ? OFFICIAL_MODEL_PREFIX + profile.model : thirdPartyNativeModel(profile.model);
  const modelList = isAcp ? listed.map(entry => entry.slug) : (profile.models ?? [profile.model]).map(thirdPartyNativeModel);
  if (!modelList.includes(clientModel)) throw new Error("所选型号已不在可用目录中，请重新配置模型服务。");
  const catalog = buildUnifiedModelCatalog(bundled, { officialModels: listed, thirdPartyModels: isAcp ? [] : profile.models ?? [profile.model] });
  catalog.models = catalog.models.filter(entry => modelList.includes(entry.slug));
  const catalogPath = join(paths.home, "anticodex-model-catalog.json");
  const token = randomBytes(32).toString("hex");
  const route = generateRouteConfig({
    provider: profile.provider, model: profile.model, clientModel, thirdPartyConfig: profile,
    localProxyKey: token, proxyPort, adapterPort, relayModelList: modelList, catalogPath,
    useNativeExecutionSettings: true, fileCredentials: true,
  });
  if (isAcp) route.upstreamApiKey = randomBytes(32).toString("hex");
  const configPath = join(paths.home, "config.toml");
  const existingConfig = existsSync(configPath) ? readFileSync(configPath, { encoding: "utf8", flag: constants.O_RDONLY | constants.O_NOFOLLOW }) : "";
  route.config = mergeCodexRouteConfig(existingConfig, route);
  const settings = buildCodexPlusPlusSettings({ route, userDataDir: paths.electron });
  atomicWrite(catalogPath, JSON.stringify(catalog));
  atomicWrite(configPath, route.config);
  atomicWrite(join(paths.home, "auth.json"), route.authContents);
  atomicWrite(join(paths.plus, "settings.json"), JSON.stringify(settings, null, 2) + "\n");

  const log = join(paths.state, "desktop.log");
  if (statSync(log, { throwIfNoEntry: false })?.size > 2 * 1024 * 1024) renameSync(log, log + ".previous");
  const logFd = openSync(log, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  const options = { cwd: paths.userHome, env, stdio: ["ignore", logFd, logFd] };
  const controller = new AbortController();
  const { signal } = controller;
  const interrupt = () => controller.abort();
  process.once("SIGTERM", interrupt);
  process.once("SIGINT", interrupt);
  let provider, helper, desktop;
  try {
    if (isAcp) {
      const client = createAntigravityAcpClient({ env: agyEnvironment(paths) });
      const adapter = createOfficialAcpRoute({ client, temp: paths.temp, officialModels: () => listed });
      provider = await createAntigravityChatServer({ adapter, port: adapterPort, authToken: route.upstreamApiKey });
    }
    helper = startChild(host.helper, getLauncherArgs({ helperPort: proxyPort }), {
      ...options, env: { ...env, ANTICODEX_ISOLATED_INSTANCE: "1", CODEX_PLUS_STATE_DIR: paths.plus, CODEX_PLUS_PROTOCOL_PROXY_PORT: String(proxyPort) },
    });
    helper.exited.then(result => controller.abort(result.error ?? new Error(`CodexPlusPlus 已退出（${result.code ?? result.signal}）。日志：${log}`)));
    await waitForProxy(helper.child.pid, signal);
    signal.throwIfAborted();
    desktop = startChild(host.executable, settings.codexExtraArgs, options);
    const aborted = new Promise(done => signal.addEventListener("abort", () => done(null), { once: true }));
    const result = await Promise.race([desktop.exited, aborted]);
    if (!result) {
      if (signal.reason?.name !== "AbortError") throw signal.reason;
    } else if (result.error || result.code !== 0) {
      throw result.error ?? new Error(`桌面副本已退出（${result.code ?? result.signal}）。日志：${log}`);
    }
  } catch (error) {
    if (!signal.aborted) throw error;
    if (signal.reason?.name !== "AbortError") throw signal.reason;
  } finally {
    await stopChild(desktop);
    await stopChild(helper);
    try { await provider?.close(); } finally {
      closeSync(logFd);
      process.off("SIGTERM", interrupt);
      process.off("SIGINT", interrupt);
    }
  }
}

async function main() {
  process.umask(0o077);
  const host = inspectRuntime();
  const cmd = process.argv[2];
  if (cmd === "check") {
    const version = execFileSync(host.helper, ["--version"], { encoding: "utf8" }).trim();
    console.log(`隔离宿主：${host.version} · ${version} · ${process.arch}`);
    return;
  }
  if (!["start", "configure"].includes(cmd)) throw new Error("需要指定 start、configure 或 check。");
  const paths = macPaths();
  const fd = lockSession(paths);
  if (fd === null) {
    if (cmd === "start" && (process.env.CODEX_ELECTRON_START_IN_BACKGROUND === "1" || focusCopy(host))) return;
    throw new Error("Anti-Codex 正在启动、配置或运行。修改设置前请退出隔离副本。");
  }
  try {
    let profile = readProfile(paths);
    if (cmd === "configure" || !profile) profile = await configure(paths, profile);
    if (cmd === "start") await runDesktop(paths, host, profile);
    else console.log(`已保存模型服务，默认模型为 ${profile.model}。`);
  } finally { closeSync(fd); }
}

if (process.argv[1] && existsSync(process.argv[1]) && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    if (error instanceof Cancelled) return;
    console.error(error.message);
    if (process.argv.includes("--finder")) showError(error.message);
    process.exitCode = 1;
  });
}
