#!/bin/sh
set -eu
resources=$(CDPATH= cd -- "$(dirname -- "$0")/../Resources" && pwd -P)
IFS= read -r node_bin < "$resources/node-path"
if [ -x "$resources/Desktop.app/Contents/Resources/node" ]; then
    bundled="$resources/Desktop.app/Contents/Resources/node"
    if "$bundled" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then node_bin="$bundled"; fi
fi
if [ ! -x "$node_bin" ]; then
    /usr/bin/osascript -e 'display alert "Anti-Codex" message "找不到 Node.js。请重新运行 install-macos.command。"'
    exit 1
fi
# Return control to Launch Services so opening the Finder icon again reaches the running desktop.
"$node_bin" "$resources/runtime/scripts/macos/runtime.mjs" start --finder </dev/null >/dev/null 2>&1 &
