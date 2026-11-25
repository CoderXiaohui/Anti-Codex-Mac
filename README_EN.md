# Anti-Codex Mac

<img src="assets/anticodex-desktop-icon.png" alt="Anti-Codex app icon" width="112" />

Anti-Codex Mac is a modified fork of [Anti-Codex](https://github.com/saerda8/Anti-Codex) that adds a macOS installer and runtime and retains the Windows installer. It builds an isolated copy of the official Codex Desktop app installed on your machine. The copy runs as **Anti-Codex** alongside the original, with separate settings, chat history, and Electron data. It keeps the native Codex interface, tools, approvals, terminal execution, and context compaction.

[简体中文](README.md) · [macOS guide (Chinese)](docs/MACOS.md) · [Windows guide](docs/WINDOWS.md)

## Install and launch on macOS

Install official Codex Desktop, Xcode Command Line Tools, and Node.js 22 or later. The installer can also use a compatible Node.js runtime bundled with the official app. The first build needs internet access to download the pinned CodexPlusPlus source and its Rust dependencies.

Run these commands from the repository root, or double-click `install-macos.command` in Finder to install.

```sh
./install-macos.command --check
./install-macos.command
open "$HOME/Applications/Anti-Codex.app"
```

The installer looks in `/Applications` and `~/Applications` for `Codex.app` or `ChatGPT.app` with the bundle ID `com.openai.codex`. Set `ANTICODEX_SOURCE_APP` to the full app path for a custom location.

### Configure a model

On first launch, choose a provider in the setup dialog. Once configured, you can select available models in the native chat composer.

- **Third-party APIs** can use **Responses** or **Chat Completions**. Choose the protocol your provider supports and enter its Base URL, including any version path such as `/v1`, and API key. Setup fetches the model list. If the provider returns no models, enter the full model ID manually.
- To use **official Antigravity ACP**, install the Antigravity CLI (`agy`), sign in with Google, and confirm the model appears in `agy models`. The composer lists the available models Anti-Codex recognizes.

To change providers or refresh the third-party model list, quit Anti-Codex and run `./install-macos.command --configure`. The [macOS guide](docs/MACOS.md#选择模型) also documents configuration through environment variables.

### Update and roll back

| Action | Command |
| --- | --- |
| Check the official host and current installation | `./install-macos.command --check` |
| Rebuild the copy after official Codex updates | `./install-macos.command` |
| Restore the previous release if available | `./install-macos.command --rollback` |

Quit Anti-Codex before updating or rolling back. The installer checks the candidate app’s signature and runtime before switching the launch entry. Anti-Codex versions share the copy’s chat history and settings.

### Local data and feature availability

- Launch from `~/Applications/Anti-Codex.app`. Chat history, settings, and databases are under `~/Library/Application Support/Anti-Codex/codex-home`. The adjacent `electron` directory holds desktop data and `desktop.log` contains startup logs.
- CodexPlusPlus uses local port `18484`. The official ACP route also uses `18488`. The launcher reports an error if a required port is in use.
- The existing system handler continues to open `codex://` links. System-level Computer Use is currently unavailable in the macOS copy. The legacy Antigravity Desktop Cascade route is available on Windows.

## Install and use on Windows

The Windows installer targets Windows 10 / 11 x64 and requires official Codex Desktop, Node.js, Windows PowerShell 5.1, Git, and Python. Double-click `install-windows.bat` at the repository root, then launch **Anti-Codex** from the desktop or Start Menu.

Open **管理** (Manage) in the bottom-left profile menu, or **Manage Anti-Codex** from the Start Menu, to configure third-party APIs and refresh the model list. Official Antigravity models require a signed-in `agy` CLI. Keep Antigravity Desktop signed in and running when using the legacy Desktop Cascade route.

After official Codex updates, run **Sync Anti-Codex with Codex** from the **Anti-Codex** Start Menu folder. Use **Rollback Anti-Codex** to restore the previous version. The copy is installed under `%LOCALAPPDATA%\Anti-Codex` and stores runtime data under `%APPDATA%\anticodex`. See the [Windows guide](docs/WINDOWS.md) for details.

## Model routing and developer documentation

1. The isolated **Codex Desktop** copy handles planning, tools, approvals, retries, and compaction.
2. **CodexPlusPlus** handles Responses and Chat Completions conversion. Third-party requests bypass Antigravity and go directly to the configured provider.
3. The **Antigravity adapter** connects to official ACP or uses the thin Chat-to-Cascade adapter for the legacy Windows route.

Connector-backed app tools require authorization from the corresponding service.

- [Three-layer architecture](docs/THREE_LAYER_ARCHITECTURE.md) · [Provider protocols and routing](docs/ADAPTIVE_ONE_API_STACK.md)
- [macOS regression tests](docs/MACOS.md#本机回归测试) · [Maintenance](MAINTENANCE.md) · [Known limitations](KNOWN_LIMITATIONS.md)

## License and credits

This fork uses the [project’s non-commercial license](LICENSE). CodexPlusPlus is licensed under AGPL-3.0. The pinned version and patch records are documented in the [CodexPlusPlus component notes](third_party/codexplusplus/README.md). Other attributions are in [Third-Party Notices](THIRD_PARTY_NOTICES.md).

This project is independently maintained and has no affiliation with OpenAI or Antigravity.
