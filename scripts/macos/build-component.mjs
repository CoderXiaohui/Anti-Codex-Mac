import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, privateDirectory } from "./common.mjs";

const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

function cargoEnvironment(cache, work, target) {
  const env = { ...process.env, CARGO_NET_GIT_FETCH_WITH_CLI: "true" };
  if (spawnSync("cargo", ["--version"], { env }).status === 0) return env;

  const cargoHome = join(cache, "cargo");
  const rustupHome = join(cache, "rustup");
  const local = { ...env, CARGO_HOME: cargoHome, RUSTUP_HOME: rustupHome, PATH: `${cargoHome}/bin:${env.PATH}` };
  if (spawnSync("cargo", ["--version"], { env: local }).status === 0) return local;
  console.log("正在为 Anti-Codex 准备本地 Rust 工具链…");
  const installer = join(work, "rustup-init");
  const url = `https://static.rust-lang.org/rustup/dist/${target}/rustup-init`;
  const curl = ["--proto", "=https", "--fail", "--silent", "--show-error", "--location", "--retry", "2"];
  execFileSync("/usr/bin/curl", [...curl, "-o", installer, url], { stdio: "inherit" });
  const expected = execFileSync("/usr/bin/curl", [...curl, url + ".sha256"], { encoding: "utf8" }).trim().split(/\s+/)[0];
  if (digest(installer) !== expected) throw new Error("rustup-init 的 SHA-256 校验失败。");
  execFileSync("/bin/chmod", ["700", installer]);
  execFileSync(installer, ["-y", "--no-modify-path", "--profile", "minimal", "--default-toolchain", "stable"], { env: local, stdio: "inherit" });
  return local;
}

export function buildComponent(repo, cache) {
  const target = { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" }[process.arch];
  if (!target) throw new Error(`不支持的 Mac 架构：${process.arch}`);
  const component = join(repo, "third_party", "codexplusplus");
  const manifestPath = join(component, "upstream.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const patch of manifest.patches) {
    if (digest(join(component, patch.file)) !== patch.sha256) throw new Error(`补丁校验失败：${patch.file}`);
  }
  privateDirectory(cache);
  const binary = join(cache, `codex-plus-plus-${target}-${digest(manifestPath)}`);
  const checksum = binary + ".sha256";
  if (existsSync(binary) && existsSync(checksum) && digest(binary) === readFileSync(checksum, "utf8").trim()) {
    return { binary, version: manifest.version };
  }
  if (spawnSync("/usr/bin/xcrun", ["--find", "clang"]).status !== 0) {
    throw new Error("构建本机路由需要 Xcode 命令行工具。请运行 xcode-select --install 后重试。");
  }
  const work = mkdtempSync(join(cache, "build-"));
  try {
    const env = cargoEnvironment(cache, work, target);
    const source = join(work, "source");
    console.log(`正在构建 CodexPlusPlus ${manifest.version}（${target}）…`);
    execFileSync("git", ["-c", "core.autocrlf=false", "clone", "--depth", "1", "--branch", manifest.tag, manifest.repository, source], { stdio: "inherit" });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
    if (commit !== manifest.upstreamCommit) throw new Error("CodexPlusPlus 上游提交与仓库锁定版本不符。");
    for (const patch of manifest.patches) {
      execFileSync("git", ["apply", "--index", "--whitespace=nowarn", join(component, patch.file)], { cwd: source, stdio: "inherit" });
    }
    execFileSync("cargo", ["build", "--locked", "--release", "--target", target, "-p", "codex-plus-launcher", "--bin", "codex-plus-plus"], {
      cwd: source, env: { ...env, CARGO_TARGET_DIR: join(work, "target") }, stdio: "inherit",
    });
    const built = join(work, "target", target, "release", "codex-plus-plus");
    if (execFileSync(built, ["--version"], { encoding: "utf8" }).trim() !== `codex-plus-plus ${manifest.version}`) {
      throw new Error("本机构建的 CodexPlusPlus 版本不匹配。");
    }
    // Run the copied binary away from Cargo's target directory to catch missing native libraries.
    const ready = join(work, "codex-plus-plus");
    copyFileSync(built, ready);
    execFileSync(ready, ["--version"]);
    renameSync(ready, binary);
    atomicWrite(checksum, digest(binary));
    return { binary, version: manifest.version };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
