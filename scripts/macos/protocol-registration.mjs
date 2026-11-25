import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readSync, realpathSync, writeSync } from "node:fs";
import { join, sep } from "node:path";
import { buildAsarIntegrity } from "../brand-patch-compat.mjs";
import { readAsarHeader, readEntryPayload, verifyAsarFile, walkFiles } from "../verify-anticodex-asar-integrity.mjs";

export function omitProtocolRegistration(source) {
  if (!source.includes("setAsDefaultProtocolClient")) return null;
  // The desktop explicitly claims codex:// on startup, even without CFBundleURLTypes in its plist.
  const registration = /[\w$]+\.setAsDefaultProtocolClient\([\w$]+\)(?=\s*\|\|\s*[\w$]+\.warning\(["'`]Failed to register protocol handler["'`])/g;
  const matches = [...source.matchAll(registration)];
  if (matches.length !== 1 || source.split("setAsDefaultProtocolClient").length !== 2) {
    throw new Error("无法识别宿主的 URL 注册代码，已停止安装以保护原版链接关联。");
  }
  return source.replace(registration, call => "true".padEnd(call.length));
}

function openCandidate(original, copy) {
  const src = lstatSync(original);
  const dst = lstatSync(copy);
  if (realpathSync(copy) !== copy || !dst.isFile() || (dst.dev === src.dev && dst.ino === src.ino)) {
    throw new Error("URL 隔离补丁需要独立的候选应用文件。");
  }
  return openSync(copy, "r+");
}

export function isolateProtocolRegistration(sourceResources, copiedResources, seal) {
  const copy = join(copiedResources, "app.asar");
  const fd = openCandidate(join(sourceResources, "app.asar"), copy);
  let newHash;
  try {
    const { header, headerStringSize, dataOffset, headerSha256 } = readAsarHeader(fd);
    if (seal && (seal.algorithm !== "SHA256" || seal.hash !== headerSha256)) throw new Error("宿主 ASAR 头部校验失败。");
    let changed = 0;
    for (const [name, entry] of walkFiles(header)) {
      if (!/\.[cm]?js$/.test(name)) continue;
      const payload = readEntryPayload(fd, dataOffset, entry);
      if (!payload.includes("setAsDefaultProtocolClient")) continue;
      const updated = Buffer.from(omitProtocolRegistration(payload.toString("utf8")));
      if (++changed !== 1 || updated.length !== payload.length) throw new Error("URL 注册代码超出预期范围。");
      writeSync(fd, updated, 0, updated.length, dataOffset + Number(entry.offset));
      if (entry.integrity) Object.assign(entry.integrity, buildAsarIntegrity(updated, entry.integrity.blockSize));
    }
    if (!changed) throw new Error("未识别此宿主的 URL 注册方式，已保留当前版本。");
    const serialized = Buffer.from(JSON.stringify(header));
    if (serialized.length > headerStringSize) throw new Error("候选应用 ASAR 头部大小异常。");
    const bytes = Buffer.alloc(headerStringSize, " ");
    serialized.copy(bytes);
    writeSync(fd, bytes, 0, bytes.length, 16);
    newHash = createHash("sha256").update(bytes).digest("hex");
  } finally { closeSync(fd); }
  if (!verifyAsarFile(copy).ok) throw new Error("候选应用 ASAR 文件校验失败。");
  return { algorithm: "SHA256", hash: newHash };
}

// Electron Packager's macOS integrity digest covers sorted (path, algorithm, hash) tuples.
// https://github.com/electron/packager/blob/main/src/mac.ts
const digestMarker = Buffer.from("AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A");

function dictionaryDigest(integrity) {
  const digest = createHash("sha256");
  for (const path of Object.keys(integrity).sort()) digest.update(path).update(integrity[path].algorithm).update(integrity[path].hash);
  return digest.digest();
}

export function sealCopiedFramework(original, copy, before, after) {
  const dir = join(copy, "Contents/Frameworks");
  const name = ["Codex Framework", "Electron Framework"].find(n => existsSync(join(dir, n + ".framework", n)));
  if (!name) throw new Error("找不到桌面宿主的 Electron Framework。");
  const framework = join(dir, name + ".framework");
  const binary = realpathSync(join(framework, name));
  if (!binary.startsWith(framework + sep)) throw new Error("应用框架位于候选副本之外。");
  const source = realpathSync(join(original, "Contents/Frameworks", name + ".framework", name));
  const fd = openCandidate(source, binary);
  try {
    const previous = dictionaryDigest(before);
    const next = dictionaryDigest(after);
    const step = 4 * 1024 * 1024;
    const buffer = Buffer.allocUnsafe(step + digestMarker.length - 1);
    const slot = Buffer.alloc(34);
    const offsets = [];
    for (let offset = 0; ; offset += step) {
      const count = readSync(fd, buffer, 0, buffer.length, offset);
      const chunk = buffer.subarray(0, count);
      for (let index = chunk.indexOf(digestMarker); index !== -1 && index < step; index = chunk.indexOf(digestMarker, index + 1)) {
        const start = offset + index + digestMarker.length;
        if (readSync(fd, slot, 0, slot.length, start) !== slot.length || slot[0] !== 1 || slot[1] !== 1 || !slot.subarray(2).equals(previous)) {
          throw new Error("宿主 Electron Framework 的完整性摘要与应用清单不符。");
        }
        offsets.push(start + 2);
      }
      if (count < buffer.length) break;
    }
    // Older Electron builds validate the plist directly. Newer builds also seal it in each architecture slice.
    for (const offset of offsets) {
      if (writeSync(fd, next, 0, next.length, offset) !== next.length) throw new Error("无法写入候选框架摘要。");
    }
    return framework;
  } finally { closeSync(fd); }
}
