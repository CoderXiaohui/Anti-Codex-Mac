// Refuses a `git push` when the commits being pushed add account data, login tokens or keys.
// Git runs it through scripts/git-hooks/pre-push (enable once with: git config core.hooksPath scripts/git-hooks).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Git's well-known id for an empty tree: diffing against it lists every file in a commit.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const ZERO_SHA = /^0+$/;

// Files that only ever exist in the local Anti-Codex data folder. They must never be committed.
const FORBIDDEN_FILE_NAMES = [
  /(^|\/)auth\.json$/i,
  /(^|\/)antigravity-accounts[^/]*\.json$/i,
  /(^|\/)account-identities[^/]*\.json$/i,
  /(^|\/)codexplusplus\/settings\.json$/i,
  /(^|\/)request-log[^/]*\.jsonl$/i,
  /(^|\/)session_index\.jsonl$/i,
  /(^|\/)rollout-[^/]*\.jsonl(\.zst)?$/i,
  /(^|\/)\.codex-global-state\.json/i,
  /\.(sqlite|db)(-wal|-shm)?$/i,
];

// Credential shapes. The fake keys used by this repo's tests deliberately do not match them.
const SECRET_PATTERNS = [
  ["personal email address", /[A-Za-z0-9._%+-]+@(?:gmail|googlemail|qq|163|126|outlook|hotmail|icloud|yahoo)\.com/i],
  ["Google API key", /AIza[0-9A-Za-z_-]{35}/],
  ["Google login token", /ya29\.[0-9A-Za-z_-]{20,}/],
  ["Google refresh token", /\b1\/\/0[0-9A-Za-z_-]{30,}/],
  ["signed login token (JWT)", /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["OpenAI or Anthropic key", /\bsk-(?:proj-|ant-api)[A-Za-z0-9_-]{30,}|\bsk-[A-Za-z0-9]{40,}/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
}

function pushBase(localSha, remoteSha) {
  if (!ZERO_SHA.test(remoteSha)) return remoteSha;
  // A brand-new remote branch: only check the commits that are not on main yet.
  try {
    return git(["merge-base", localSha, "origin/main"]).trim();
  } catch {
    return EMPTY_TREE;
  }
}

function findProblems(base, localSha) {
  const problems = [];
  const changedFiles = git(["diff", "--name-only", "--diff-filter=AMR", "-z", base, localSha]).split("\0").filter(Boolean);
  for (const file of changedFiles) {
    if (FORBIDDEN_FILE_NAMES.some((pattern) => pattern.test(file.replaceAll("\\", "/")))) {
      problems.push(`${file}: this file holds local account or chat data`);
    }
  }
  let currentFile = "";
  for (const line of git(["diff", "--unified=0", "--no-color", "--no-ext-diff", base, localSha]).split("\n")) {
    if (line.startsWith("+++ ")) {
      currentFile = line.replace(/^\+\+\+ (b\/)?/, "");
      continue;
    }
    if (!line.startsWith("+")) continue;
    for (const [label, pattern] of SECRET_PATTERNS) {
      if (pattern.test(line)) problems.push(`${currentFile}: looks like a ${label}`);
    }
  }
  return problems;
}

// Git passes one line per pushed ref: <local ref> <local sha> <remote ref> <remote sha>
const problems = [];
for (const line of readFileSync(0, "utf8").split("\n")) {
  const [, localSha, , remoteSha] = line.trim().split(/\s+/);
  if (!localSha || !remoteSha || ZERO_SHA.test(localSha)) continue; // deleting a remote branch uploads nothing
  problems.push(...findProblems(pushBase(localSha, remoteSha), localSha));
}

if (problems.length > 0) {
  console.error("Push blocked: the commits being pushed contain account data or credentials.");
  for (const problem of new Set(problems)) console.error("  - " + problem);
  console.error("Remove them from the commits, then push again.");
  process.exit(1);
}
