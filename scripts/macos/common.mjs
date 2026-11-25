import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync,
  renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const launcherId = "local.anticodex.launcher";
export const hostId = "local.anticodex.desktop";

export function macPaths(home = realpathSync(homedir())) {
  const state = join(home, "Library", "Application Support", "Anti-Codex");
  return {
    state, app: join(home, "Applications", "Anti-Codex.app"), releases: join(state, "releases"),
    cache: join(home, "Library", "Caches", "Anti-Codex"), home: join(state, "codex-home"),
    electron: join(state, "electron"), plus: join(state, "codexplusplus"),
    userHome: join(state, "user-home"), temp: join(state, "tmp"), profile: join(state, "provider.json"),
  };
}

export function privateDirectory(path) {
  let ancestor = path;
  while (!lstatSync(ancestor, { throwIfNoEntry: false })) ancestor = dirname(ancestor);
  if (realpathSync(ancestor) !== ancestor) throw new Error(`隔离目录包含符号链接：${ancestor}`);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (realpathSync(path) !== path) throw new Error(`隔离目录包含符号链接：${path}`);
}

// lockf's fd mode locks the inherited open file description until our fd closes, including on crash.
export function lockSession(paths) {
  privateDirectory(paths.state);
  const fd = openSync(join(paths.state, "session.lock"), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  const result = spawnSync("/usr/bin/lockf", ["-s", "-t", "0", "3"], { stdio: ["ignore", "ignore", "inherit", fd] });
  if (result.status === 0) return fd;
  closeSync(fd);
  if (result.status === 75) return null;
  throw result.error ?? new Error("无法锁定 Anti-Codex 数据目录。");
}

export function atomicWrite(path, value) {
  const pending = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(pending, value, { mode: 0o600, flag: "wx" });
    renameSync(pending, path);
  } finally {
    rmSync(pending, { force: true });
  }
}

export function readPlist(path) {
  return JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], { encoding: "utf8" }));
}

export function inspectHost(bundle, expectedId) {
  const contents = join(bundle, "Contents");
  const info = readPlist(join(contents, "Info.plist"));
  const name = info.CFBundleExecutable;
  if (info.CFBundleIdentifier !== expectedId || !name || basename(name) !== name) {
    throw new Error(`应用标识或可执行文件不匹配：${bundle}（需要 ${expectedId}）`);
  }
  const executable = join(contents, "MacOS", name);
  const resources = join(contents, "Resources");
  const cli = ["codex-cli/bin/codex", "codex", "codex-cli/CodexCLI.app/Contents/MacOS/codex"]
    .map((file) => join(resources, file)).find((file) => statSync(file, { throwIfNoEntry: false })?.isFile());
  if (!cli || !existsSync(join(resources, "app.asar")) || !existsSync(executable)) {
    throw new Error(`此应用缺少 Codex Desktop 或其内置 CLI：${bundle}`);
  }
  return { bundle, executable, cli, resources, version: info.CFBundleShortVersionString };
}

export function findSource(override = process.env.ANTICODEX_SOURCE_APP) {
  const candidates = override ? [override] : ["/Applications", join(homedir(), "Applications")]
    .flatMap((dir) => ["Codex.app", "ChatGPT.app"].map((name) => join(dir, name)));
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try { return inspectHost(realpathSync(candidate), "com.openai.codex"); }
    catch (error) { if (override) throw error; }
  }
  throw new Error("未找到官方 Codex Desktop。可以通过 ANTICODEX_SOURCE_APP 指定已安装的 .app 路径。");
}

export function readProfile(paths) {
  const stat = lstatSync(paths.profile, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile()) throw new Error("provider.json 必须是隔离目录内的普通文件。");
  return JSON.parse(readFileSync(paths.profile, "utf8"));
}

// A launch from a Codex terminal can carry a reference to the official app server or its credentials.
// Start the copy with the same baseline as a Finder launch and its own local app server.
export function clientEnvironment(paths, source = process.env) {
  const env = {};
  for (const key of [
    "USER", "LOGNAME", "SHELL", "LANG", "TERM",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "__CF_USER_TEXT_ENCODING",
  ]) {
    if (source[key]) env[key] = source[key];
  }
  return {
    ...env, HOME: paths.userHome, CFFIXED_USER_HOME: paths.userHome, TMPDIR: paths.temp,
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    CODEX_HOME: paths.home, CODEX_SQLITE_HOME: paths.home, CODEX_ELECTRON_USER_DATA_PATH: paths.electron,
    CODEX_APP_SERVER_FORCE_CLI: "1", CODEX_SPARKLE_ENABLED: "false",
    CODEX_ELECTRON_SKIP_COMPUTER_USE_CANONICAL_REFRESH: "1",
    ...(source.CODEX_ELECTRON_START_IN_BACKGROUND === "1" ? { CODEX_ELECTRON_START_IN_BACKGROUND: "1" } : {}),
  };
}
