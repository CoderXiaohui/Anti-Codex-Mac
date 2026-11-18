import { createInterface } from "node:readline";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { MAX_NATIVE_MCP_BODY_BYTES } from "../antigravity-contract.mjs";

const EXPECTED_ENDPOINT_ERROR = "ANTICODEX_ACP_MCP_URL must be a 127.0.0.1 loopback HTTP MCP endpoint.";
const BRIDGE_ERROR = "Local Codex tool bridge request failed.";

export async function runAntigravityAcpMcpStdio(options = {}) {
  const env = options.env ?? process.env;
  const endpoint = validateBridgeUrl(env.ANTICODEX_ACP_MCP_URL);
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const fetchImpl = options.fetchImpl ?? fetch;
  const pending = new Set();
  const failures = [];
  const lines = createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    const work = forwardLine(line, { endpoint, output, fetchImpl });
    pending.add(work);
    work.then(
      () => pending.delete(work),
      (error) => {
        failures.push(error);
        pending.delete(work);
      },
    );
  }
  await Promise.all(pending);
  if (failures.length > 0) throw failures[0];
}

async function forwardLine(line, { endpoint, output, fetchImpl }) {
  if (Buffer.byteLength(line, "utf8") > MAX_NATIVE_MCP_BODY_BYTES) {
    await writeJson(output, rpcError(null, -32600, "Request exceeds the local bridge limit."));
    return;
  }

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    await writeJson(output, rpcError(null, -32700, "Invalid JSON-RPC message."));
    return;
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    await writeJson(output, rpcError(null, -32600, "Invalid JSON-RPC request."));
    return;
  }
  const hasId = Object.hasOwn(message, "id");

  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(message),
      redirect: "error",
    });
    if (response.status === 202 && !hasId) return;
    if (!response.ok) {
      if (hasId) await writeJson(output, rpcError(message.id, -32000, `Local Codex tool bridge returned HTTP ${response.status}.`));
      return;
    }
    const body = await response.text();
    if (!body) {
      if (hasId) await writeJson(output, rpcError(message.id, -32000, BRIDGE_ERROR));
      return;
    }
    const parsed = JSON.parse(body);
    if (!hasId) return;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
        || parsed.jsonrpc !== "2.0" || !sameJsonRpcId(parsed.id, message.id)) {
      await writeJson(output, rpcError(message.id, -32000, BRIDGE_ERROR));
      return;
    }
    await writeJson(output, parsed);
  } catch {
    if (hasId) await writeJson(output, rpcError(message.id, -32000, BRIDGE_ERROR));
  }
}

export function validateBridgeUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    const port = Number(url.port);
    if (url.protocol !== "http:"
        || url.hostname !== "127.0.0.1"
        || !Number.isInteger(port) || port < 1 || port > 65535
        || url.username || url.password || url.search || url.hash
        || !/^\/mcp\/[A-Za-z0-9_-]{32,128}$/u.test(url.pathname)) {
      throw new Error(EXPECTED_ENDPOINT_ERROR);
    }
    return url.href;
  } catch {
    throw new Error(EXPECTED_ENDPOINT_ERROR);
  }
}

function sameJsonRpcId(left, right) {
  return Object.is(left, right);
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function writeJson(output, value) {
  if (!output.write(`${JSON.stringify(value)}\n`)) await once(output, "drain");
}

function isDirectRun() {
  return Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  runAntigravityAcpMcpStdio().catch(() => {
    process.stderr.write("Anti-Codex ACP MCP bridge failed.\n");
    process.exitCode = 1;
  });
}
