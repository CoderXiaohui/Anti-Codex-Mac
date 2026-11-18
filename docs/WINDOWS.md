# Anti-Codex Windows

Anti-Codex installs a guarded, isolated copy of the official Codex Desktop host
under `%LOCALAPPDATA%\Anti-Codex`. It does not modify the official installation.

## Requirements

- Official Codex Desktop for Windows
- Node.js available as `node.exe`
- Git and Python for installation
- A signed-in Antigravity CLI (`agy`) for the official models, or a running, signed-in Antigravity Desktop app for legacy Desktop models
- A provider URL and API key for a third-party API

Third-party providers are handled directly by CodexPlusPlus and bypass
Antigravity. Saving the provider discovers its models for the chat menu. For
Antigravity, choose an entry labeled **Antigravity 官方** in the same composer.
The official connection stays open while Codex runs a tool under its existing
approval rules. The legacy thin Chat-to-Cascade route requires the Desktop app.

## Install

From the repository or release package root, double-click:

```text
install-windows.bat
```

The installer creates:

```text
%LOCALAPPDATA%\Anti-Codex\runtime
%LOCALAPPDATA%\Anti-Codex\codex-patched-app
%APPDATA%\anticodex
```

It also creates the `Anti-Codex` desktop shortcut and Start Menu folder. The
copied executable, state, taskbar/tray icons, and Electron user-data directory
remain isolated from official Codex.

## Run From Source

For development:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\scripts\start-anticodex.ps1
```

The launcher owns a single fixed-route supervisor and reuses the existing
Anti-Codex window when the provider/model route matches. It must not open
duplicate visible clients or enter a relaunch loop.

Optional development overrides:

```powershell
$env:CODEX_BIN = "C:\Path\To\Codex.exe"
$env:NODE_BIN = "C:\Path\To\node.exe"
$env:DEEPCODEX_WORKSPACE = "C:\Path\To\Project"
```

`DEEPCODEX_*` names that remain are internal compatibility names, not product
branding or a separate architecture.

## Update And Rollback

After official Codex updates, use:

```text
Start Menu > Anti-Codex > Sync Anti-Codex with Codex
```

Sync builds a candidate copy, audits the approved patch delta, validates it,
and activates it only after the checks pass. A failure leaves the active client
and rollback point unchanged.

## Runtime Notes

- PowerShell 5.1 is supported.
- Anti-Codex uses `%APPDATA%\anticodex` and a separate Electron user-data path.
- Skills, MCP configuration, plugin metadata, and connector metadata are copied
  into isolated state. Metadata does not authorize connector-backed app tools.
- Official models use the signed-in Antigravity CLI account. The legacy Desktop
  route uses the account that is active in the Desktop app.
- Provider mismatches fail closed instead of silently switching upstreams.

## Windows npm / npx

Use the `.cmd` launchers from Windows processes:

```powershell
npx.cmd --version
npm.cmd --version
Start-Process -FilePath "npx.cmd" -ArgumentList "remotion","studio"
```

Launching bare `npx` can select `npx.ps1` and open it as a document instead of
running the package command.
