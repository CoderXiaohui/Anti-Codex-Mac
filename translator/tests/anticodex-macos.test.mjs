import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { clientEnvironment, inspectHost, lockSession, macPaths, privateDirectory, readProfile } from "../../scripts/macos/common.mjs";
import { configure } from "../../scripts/macos/configure.mjs";
import { isolateProtocolRegistration, omitProtocolRegistration, sealCopiedFramework } from "../../scripts/macos/protocol-registration.mjs";
import { generateRouteConfig, mergeCodexRouteConfig } from "../../scripts/lib/anticodex-fixed-route.mjs";
import { createOfficialAcpRoute } from "../provider/antigravity-official-route.mjs";

function fixture(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "Anti-Codex Mac ")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, paths: macPaths(home) };
}

test("the copy has its own home, SQLite, Electron profile, temp and app server even inside a Codex task", (t) => {
  const { home, paths } = fixture(t);
  const env = clientEnvironment(paths, {
    HOME: home, CFFIXED_USER_HOME: home, CODEX_HOME: join(home, ".codex"), CODEX_SQLITE_HOME: join(home, ".codex"),
    CODEX_APP_SERVER_WS_URL: "ws://official", CODEX_CLI_PATH: "/Applications/ChatGPT.app/cli",
    CODEX_APP_RUNTIME_CLI_PATH: "/official/cli", CODEX_APP_TOOLS_PIPE_PATH: "/official/pipe",
    CODEX_ELECTRON_USER_DATA_PATH: join(home, "Library/Application Support/Codex"), CODEX_THREAD_ID: "official-thread",
    CODEX_APP_SERVER_USE_LOCAL_DAEMON: "1", OPENAI_API_KEY: "official-key", UPSTREAM_API_KEY: "provider-key",
  });
  for (const key of ["HOME", "CFFIXED_USER_HOME", "TMPDIR", "CODEX_HOME", "CODEX_SQLITE_HOME", "CODEX_ELECTRON_USER_DATA_PATH"]) {
    assert.ok(env[key] && !relative(paths.state, env[key]).startsWith(".."), key);
  }
  assert.equal(env.CODEX_SPARKLE_ENABLED, "false");
  assert.equal(env.CODEX_APP_SERVER_FORCE_CLI, "1");
  for (const name of ["OPENAI_API_KEY", "UPSTREAM_API_KEY", "CODEX_THREAD_ID", "CODEX_CLI_PATH", "CODEX_APP_RUNTIME_CLI_PATH", "CODEX_APP_TOOLS_PIPE_PATH", "CODEX_APP_SERVER_WS_URL", "CODEX_APP_SERVER_USE_LOCAL_DAEMON"]) {
    assert.equal(env[name], undefined, name);
  }
  assert.equal(existsSync(join(home, ".codex")), false);
});

test("macOS provider updates retain native user permissions and keep login data in the copy", () => {
  const route = generateRouteConfig({ provider: "antigravity", proxyPort: 18484, adapterPort: 18488, useNativeExecutionSettings: true, fileCredentials: true });
  const config = mergeCodexRouteConfig('approval_policy = "on-request"\nsandbox_mode = "read-only"\ncli_auth_credentials_store = "keyring"\n', route);
  assert.match(config, /approval_policy = "on-request"/);
  assert.match(config, /sandbox_mode = "read-only"/);
  assert.doesNotMatch(config, /danger-full-access|approval_policy = "never"|keyring/);
  assert.equal(config.match(/cli_auth_credentials_store = "file"/g).length, 1);
  assert.equal(mergeCodexRouteConfig(config, route), config);
});

test("a linked isolation root is refused before any lock or setting can land in an official profile", { skip: process.platform === "win32" }, (t) => {
  const { home, paths } = fixture(t);
  const original = join(home, ".codex");
  mkdirSync(original);
  mkdirSync(dirname(paths.state), { recursive: true });
  symlinkSync(original, paths.state);
  assert.throws(() => lockSession(paths), /符号链接/);
  assert.equal(existsSync(join(original, "session.lock")), false);
});

test("the macOS session lock excludes concurrent configuration, relaunch and update", { skip: process.platform !== "darwin" }, (t) => {
  const { paths } = fixture(t);
  const fd = lockSession(paths);
  assert.notEqual(fd, null);
  try { assert.equal(lockSession(paths), null); } finally { closeSync(fd); }
  closeSync(lockSession(paths));
});

test("the copy skips the known system URL registration and preserves the surrounding startup code", () => {
  const call = "app.setAsDefaultProtocolClient(scheme)";
  const tail = '||log.warning("Failed to register protocol handler",context);startDesktop()';
  const source = "ready();" + call + tail;
  assert.equal(omitProtocolRegistration(source), "ready();" + "true".padEnd(call.length) + tail);
  assert.equal(omitProtocolRegistration("startDesktop()"), null);
  assert.throws(() => omitProtocolRegistration(call), /URL/);
  assert.throws(() => omitProtocolRegistration(source + ";" + call), /URL/);
});

test("URL isolation rejects the official archive and any hard link to it before opening it for writing", (t) => {
  const { home } = fixture(t);
  const file = join(home, "app.asar");
  const copy = join(home, "candidate");
  mkdirSync(copy);
  writeFileSync(file, "original fixture");
  linkSync(file, join(copy, "app.asar"));
  assert.throws(() => isolateProtocolRegistration(home, home), /独立/);
  assert.throws(() => isolateProtocolRegistration(home, copy), /独立/);
  assert.equal(readFileSync(file, "utf8"), "original fixture");
});

test("packaging reseals every framework slice in the copy and rejects unexpected source digests", (t) => {
  const { home } = fixture(t);
  const original = join(home, "Official.app"), copy = join(home, "Copy.app");
  const framework = "Contents/Frameworks/Codex Framework.framework";
  const archive = "Resources/app.asar";
  const marker = Buffer.from("AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A");
  const entry = hash => ({ [archive]: { algorithm: "SHA256", hash } });
  const slot = hash => Buffer.concat([marker, Buffer.from([1, 1]), createHash("sha256").update(archive + "SHA256" + hash).digest()]);
  const padding = Buffer.alloc(4 * 1024 * 1024 - 8);
  const old = "a".repeat(64), next = "b".repeat(64);
  const packed = hash => Buffer.concat([padding, slot(hash), slot(hash)]);
  const binary = app => join(app, framework, "Codex Framework");
  for (const app of [original, copy]) {
    mkdirSync(join(app, framework), { recursive: true });
    writeFileSync(binary(app), packed(old));
  }
  assert.throws(() => sealCopiedFramework(original, copy, entry(next), entry(old)), /完整性摘要/);
  sealCopiedFramework(original, copy, entry(old), entry(next));
  assert.deepEqual(readFileSync(binary(copy)), packed(next));
  assert.deepEqual(readFileSync(binary(original)), packed(old));
});

test("the host is identified by its bundle ID and bundled CLI across macOS layouts", { skip: process.platform !== "darwin" }, (t) => {
  const { home } = fixture(t);
  const bundle = join(home, "Renamed Desktop.app");
  const contents = join(bundle, "Contents");
  for (const file of ["MacOS/ChatGPT", "Resources/app.asar", "Resources/codex-cli/bin/codex"]) {
    mkdirSync(dirname(join(contents, file)), { recursive: true });
    writeFileSync(join(contents, file), "");
  }
  writeFileSync(join(contents, "Info.plist"), JSON.stringify({ CFBundleIdentifier: "com.openai.codex", CFBundleExecutable: "ChatGPT" }));
  assert.equal(inspectHost(bundle, "com.openai.codex").cli, join(contents, "Resources/codex-cli/bin/codex"));
  rmSync(join(contents, "Resources/codex-cli/bin/codex"));
  writeFileSync(join(contents, "Resources/codex"), "");
  assert.equal(inspectHost(bundle, "com.openai.codex").cli, join(contents, "Resources/codex"));
  assert.throws(() => inspectHost(bundle, "local.anticodex.desktop"), /标识/);
});

test("provider discovery stores only the chosen profile in private state and an invalid edit preserves it", { skip: process.platform === "win32" }, async (t) => {
  const { paths } = fixture(t);
  privateDirectory(paths.state);
  const server = createServer((req, res) => {
    assert.equal(req.url, "/v1/models");
    assert.equal(req.headers.authorization, "Bearer fixture");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "text-a" }, { id: "text-b" }] }));
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const env = { ANTICODEX_PROVIDER: "third-party", UPSTREAM_URL: `http://127.0.0.1:${server.address().port}/v1`, UPSTREAM_API_KEY: "fixture", UPSTREAM_MODEL: "text-b" };
  await configure(paths, null, env);
  assert.deepEqual(readProfile(paths).models, ["text-a", "text-b"]);
  assert.equal(readProfile(paths).model, "text-b");
  assert.equal(statSync(paths.profile).mode & 0o777, 0o600);
  const before = readFileSync(paths.profile);
  await assert.rejects(configure(paths, null, { ...env, UPSTREAM_MODEL: "other-provider" }), /模型目录/);
  assert.deepEqual(readFileSync(paths.profile), before);
});

test("the official-only ACP route lists official models and rejects an unknown model before opening a session", async () => {
  const slug = "anticodex/official/test-model";
  const route = createOfficialAcpRoute({ officialModels: () => [{ slug, visibility: "list" }] });
  assert.deepEqual((await route.models()).data.map(entry => entry.id), [slug]);
  await assert.rejects(route.complete({ model: "wrong-model" }), /官方模型/);
  await route.close();
});
