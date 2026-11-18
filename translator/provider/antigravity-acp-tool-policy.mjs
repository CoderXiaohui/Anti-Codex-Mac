import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// The ACP server may only request an editor tool. The editor checks the actual
// invocation under the thread's current approval and sandbox policy.
export function bridgeToolDecision(input) {
  return /^mcp_anticodex_[A-Za-z0-9_.-]+$/u.test(input?.toolCall?.name ?? "")
    ? "force_ask"
    : "deny";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let decision = "deny";
  try {
    decision = bridgeToolDecision(JSON.parse(readFileSync(0, "utf8")));
  } catch { /* Incomplete input grants no permission. */ }
  process.stdout.write(JSON.stringify({ decision, reason: "Use the tools provided by the Codex editor." }));
}
