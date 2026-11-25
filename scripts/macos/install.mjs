import { execFileSync } from "node:child_process";
import {
  chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { buildComponent } from "./build-component.mjs";
import { isolateProtocolRegistration, sealCopiedFramework } from "./protocol-registration.mjs";
import { atomicWrite, findSource, hostId, inspectHost, launcherId, lockSession, macPaths, privateDirectory, readPlist } from "./common.mjs";

const repo = resolve(import.meta.dirname, "../..");
const paths = macPaths();
const isolationVersion = 2;
const plist = (app) => join(app, "Contents", "Info.plist");
const resources = (app) => join(app, "Contents", "Resources");
const verify = (app) => execFileSync("/usr/bin/codesign", ["--verify", "--strict", app]);
const sign = (app) => execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", app], { stdio: "inherit" });

function releaseApp(name) {
  if (typeof name !== "string" || !/^release-[a-zA-Z0-9]+$/.test(name)) throw new Error("隔离版本目录无效。");
  const dir = join(paths.releases, name);
  const app = join(dir, "Anti-Codex.app");
  if (!lstatSync(dir).isDirectory() || !lstatSync(app).isDirectory() || readPlist(plist(app)).CFBundleIdentifier !== launcherId) {
    throw new Error(`无法识别已有的 Anti-Codex 版本：${dir}`);
  }
  return app;
}

function activeRelease() {
  const link = lstatSync(paths.app, { throwIfNoEntry: false });
  if (!link) return null;
  if (link.isSymbolicLink()) {
    const target = readlinkSync(paths.app);
    if (dirname(dirname(target)) === paths.releases && releaseApp(basename(dirname(target))) === target) return target;
  }
  throw new Error(`已有同名应用，请先移至其他位置：${paths.app}`);
}

function activate(app) {
  const link = join(dirname(paths.app), `.anticodex-${randomUUID()}`);
  symlinkSync(app, link);
  try { renameSync(link, paths.app); } finally { rmSync(link, { force: true }); }
}

function previousRelease(app) {
  const previous = join(dirname(app), "previous");
  if (!existsSync(previous)) return null;
  const name = readFileSync(previous, "utf8").trim();
  return name ? releaseApp(name) : null;
}

function makeIcon(work, destination) {
  const iconset = join(work, "Anti-Codex.iconset");
  mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = String(size * scale);
      const name = `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`;
      execFileSync("/usr/bin/sips", ["-z", pixels, pixels, join(repo, "assets/anticodex-desktop-icon.png"), "--out", join(iconset, name)]);
    }
  }
  execFileSync("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", destination]);
  rmSync(iconset, { recursive: true });
}

function writePlist(path, value) {
  execFileSync("/usr/bin/plutil", ["-convert", "xml1", "-o", path, "--", "-"], { input: JSON.stringify(value) });
}

function signDesktopHelpers(host, framework) {
  for (const dir of [join(host, "Contents/Frameworks"), join(framework, "Versions/Current/Helpers")]) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith(".app")) continue;
      const helper = realpathSync(join(dir, entry.name));
      if (!helper.startsWith(host + sep)) throw new Error("桌面助手位于候选副本之外。");
      const info = readPlist(plist(helper));
      if (!info.CFBundleIdentifier?.startsWith("com.openai.codex.")) continue;
      info.CFBundleIdentifier = hostId + info.CFBundleIdentifier.slice("com.openai.codex".length);
      writePlist(plist(helper), info);
      sign(helper);
    }
  }
}

function packageApp(work, app, source, component) {
  const res = resources(app);
  mkdirSync(res, { recursive: true });
  mkdirSync(join(app, "Contents/MacOS"));
  const entry = join(app, "Contents/MacOS/Anti-Codex");
  copyFileSync(join(import.meta.dirname, "launcher.sh"), entry);
  chmodSync(entry, 0o755);
  writePlist(plist(app), {
    CFBundleIdentifier: launcherId, CFBundleName: "Anti-Codex", CFBundleDisplayName: "Anti-Codex",
    CFBundleExecutable: "Anti-Codex", CFBundlePackageType: "APPL", CFBundleIconFile: "Anti-Codex.icns",
    CFBundleInfoDictionaryVersion: "6.0", CFBundleVersion: "1", LSUIElement: true,
    CFBundleShortVersionString: source.version, AntiCodexIsolationVersion: isolationVersion,
  });
  makeIcon(work, join(res, "Anti-Codex.icns"));
  const host = join(res, "Desktop.app");
  execFileSync("/usr/bin/ditto", [source.bundle, host]);
  const info = readPlist(plist(host));
  const originalIntegrity = info.ElectronAsarIntegrity ?? {};
  info.ElectronAsarIntegrity = {
    ...originalIntegrity,
    "Resources/app.asar": isolateProtocolRegistration(source.resources, resources(host), originalIntegrity["Resources/app.asar"]),
  };
  const framework = sealCopiedFramework(source.bundle, host, originalIntegrity, info.ElectronAsarIntegrity);
  signDesktopHelpers(host, framework);
  sign(framework);
  verify(framework);
  Object.assign(info, { CFBundleIdentifier: hostId, CFBundleName: "Anti-Codex", CFBundleDisplayName: "Anti-Codex", CFBundleIconFile: "Anti-Codex.icns" });
  for (const key of [
    "CFBundleAlternateNames", "CFBundleIconName", "CFBundleURLTypes", "CFBundleDocumentTypes", "CFBundleSignature",
    "UTExportedTypeDeclarations", "UTImportedTypeDeclarations", "NSUserActivityTypes", "ASWebAuthenticationSessionWebBrowserSupportCapabilities",
  ]) delete info[key];
  writePlist(plist(host), info);
  copyFileSync(join(res, "Anti-Codex.icns"), join(resources(host), "Anti-Codex.icns"));
  sign(host);
  verify(host);
  inspectHost(host, hostId);

  const runtime = join(res, "runtime");
  const files = [
    "scripts/macos/common.mjs", "scripts/macos/runtime.mjs", "scripts/macos/configure.mjs",
    "scripts/lib/anticodex-fixed-route.mjs",
    "translator/antigravity-contract.mjs", "translator/antigravity-model-catalog.mjs", "translator/antigravity-native-mcp-bridge.mjs",
    "translator/provider/antigravity-acp-client.mjs", "translator/provider/antigravity-acp-turns.mjs",
    "translator/provider/antigravity-acp-mcp-stdio.mjs", "translator/provider/antigravity-acp-tool-policy.mjs",
    "translator/provider/antigravity-chat-adapter.mjs", "translator/provider/antigravity-chat-server.mjs",
    "translator/provider/antigravity-official-route.mjs", "translator/provider/codexplusplus-upstream-probe.mjs",
  ];
  for (const file of files) {
    mkdirSync(dirname(join(runtime, file)), { recursive: true });
    copyFileSync(join(repo, file), join(runtime, file));
  }
  copyFileSync(component.binary, join(res, "codex-plus-plus"));
  copyFileSync(join(repo, "THIRD_PARTY_NOTICES.md"), join(res, "THIRD_PARTY_NOTICES.md"));
  writeFileSync(join(res, "node-path"), process.execPath + "\n");
  execFileSync(process.execPath, [join(runtime, "scripts/macos/runtime.mjs"), "check"], { stdio: "inherit" });
  sign(app);
  verify(app);
}

function install(active) {
  const source = findSource();
  verify(source.bundle);
  const older = active && previousRelease(active);
  const canRestore = active && readPlist(plist(active)).AntiCodexIsolationVersion === isolationVersion;
  const component = buildComponent(repo, paths.cache);
  privateDirectory(paths.releases);
  mkdirSync(dirname(paths.app), { recursive: true });
  const work = mkdtempSync(join(paths.releases, "release-"));
  const app = join(work, "Anti-Codex.app");
  try {
    console.log(`正在复制 ${source.bundle}（${source.version}）…`);
    packageApp(work, app, source, component);
    if (canRestore) atomicWrite(join(work, "previous"), basename(dirname(active)));
    activate(app);
  } catch (error) {
    rmSync(work, { recursive: true, force: true });
    throw error;
  }
  if (older && older !== active) rmSync(dirname(older), { recursive: true, force: true });
  if (active && !canRestore) rmSync(dirname(active), { recursive: true, force: true });
  console.log(`安装完成：${paths.app}\n首次打开时可选择模型服务。`);
}

function main() {
  const command = process.argv[2] ?? "--install";
  if (process.argv.length > 3 || !["--install", "--check", "--rollback", "--configure", "--help"].includes(command)) {
    throw new Error("用法：./install-macos.command [--check | --configure | --rollback | --help]");
  }
  if (command === "--help") {
    console.log("默认安装或更新。--check 检查宿主和安装版本，--configure 设置模型服务，--rollback 恢复上个版本。");
    return;
  }
  const active = activeRelease();
  if (command === "--check") {
    const source = findSource();
    console.log(`官方宿主：${source.bundle}（${source.version}）\n安装入口：${paths.app}\n配置目录：${paths.state}`);
    if (active) {
      verify(active);
      execFileSync(process.execPath, [join(resources(active), "runtime/scripts/macos/runtime.mjs"), "check"], { stdio: "inherit" });
    } else console.log("尚未安装 Anti-Codex。");
    return;
  }
  if (command === "--configure") {
    if (!active) throw new Error("请先运行 ./install-macos.command 安装。");
    execFileSync(process.execPath, [join(resources(active), "runtime/scripts/macos/runtime.mjs"), "configure"], { stdio: "inherit" });
    return;
  }
  const fd = lockSession(paths);
  if (fd === null) throw new Error("Anti-Codex 正在运行或更新。请退出隔离副本后重试。");
  try {
    const current = activeRelease();
    if (command === "--install") return install(current);
    const previous = current && previousRelease(current);
    if (!previous) throw new Error("当前没有可回滚的安装版本。");
    if (readPlist(plist(previous)).AntiCodexIsolationVersion !== isolationVersion) throw new Error("旧版本无法隔离系统链接关联。");
    verify(previous);
    atomicWrite(join(dirname(previous), "previous"), basename(dirname(current)));
    activate(previous);
    console.log(`已恢复上个版本：${paths.app}`);
  } finally { closeSync(fd); }
}

try { main(); } catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
