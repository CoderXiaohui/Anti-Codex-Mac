#!/bin/sh
set -eu

if [ "$(uname -s)" != Darwin ]; then
    echo '此安装器适用于 macOS。Windows 请运行 install-windows.bat。' >&2
    exit 1
fi

repo=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
for node_bin in "$(command -v node || true)" /opt/homebrew/bin/node /usr/local/bin/node \
    "${ANTICODEX_SOURCE_APP:-/Applications/ChatGPT.app}/Contents/Resources/node" \
    "/Applications/Codex.app/Contents/Resources/node" \
    "$HOME/Applications/Codex.app/Contents/Resources/node" "$HOME/Applications/ChatGPT.app/Contents/Resources/node"; do
    if [ -x "$node_bin" ] && "$node_bin" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
        exec "$node_bin" "$repo/scripts/macos/install.mjs" "$@"
    fi
done
echo '需要 Node.js 22 或更新版本。安装后请重新运行。' >&2
exit 1
