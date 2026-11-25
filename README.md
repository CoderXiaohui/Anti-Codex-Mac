# Anti-Codex Mac

<img src="assets/anticodex-desktop-icon.png" alt="Anti-Codex 应用图标" width="112" />

Anti-Codex Mac 是 [Anti-Codex](https://github.com/saerda8/Anti-Codex) 的修改版，增加了 macOS 安装器和运行环境，并保留 Windows 安装入口。它从本机已安装的官方 Codex Desktop 构建名为 **Anti-Codex** 的隔离副本。两个应用可以同时运行，各自保存配置、会话和 Electron 数据。副本沿用 Codex 的聊天界面、工具调用、审批、终端执行和上下文压缩。

[English](README_EN.md) · [macOS 使用指南](docs/MACOS.md) · [Windows 使用指南](docs/WINDOWS.md)

## macOS 安装与启动

准备官方 Codex Desktop、Xcode 命令行工具和 Node.js 22 或更新版本。安装器也会尝试使用官方应用内置的 Node.js。首次构建需要联网获取锁定版本的 CodexPlusPlus 源码和 Rust 依赖。

在仓库根目录运行以下命令，也可以在 Finder 中双击 `install-macos.command` 安装。

```sh
./install-macos.command --check
./install-macos.command
open "$HOME/Applications/Anti-Codex.app"
```

安装器会在 `/Applications` 和 `~/Applications` 查找标识为 `com.openai.codex` 的 `Codex.app` 或 `ChatGPT.app`。应用在其他位置时，通过 `ANTICODEX_SOURCE_APP` 指定完整路径。

### 配置模型

首次打开 Anti-Codex 时，按对话框选择模型服务。配置完成后，可以在原生聊天输入框中选择可用模型。

- **第三方 API** 支持 **Responses** 和 **Chat Completions**。选择服务商提供的协议，填写 Base URL（含 `/v1` 等版本路径）和 API Key。设置会查询可用模型，服务商未返回模型目录时可以手动输入完整的模型 ID。
- 使用 **Antigravity 官方 ACP** 前，先安装 Antigravity CLI（`agy`）并完成 Google 登录，确认 `agy models` 能列出要用的模型。聊天菜单以 Anti-Codex 能识别的实际模型目录为准。

切换服务商或重新加载第三方模型目录时，先退出 Anti-Codex，再运行 `./install-macos.command --configure`。终端配置方式见 [macOS 使用指南](docs/MACOS.md#选择模型)。

### 更新与回滚

| 操作 | 命令 |
| --- | --- |
| 检查官方宿主及当前安装 | `./install-macos.command --check` |
| 在官方 Codex 更新后重建副本 | `./install-macos.command` |
| 恢复上一可回滚版本 | `./install-macos.command --rollback` |

更新或回滚前先退出 Anti-Codex。安装器会在通过签名和运行组件检查后切换启动入口。不同版本共用 Anti-Codex 自己的会话和配置目录。

### 本地数据与功能边界

- 启动入口位于 `~/Applications/Anti-Codex.app`。会话、配置和数据库位于 `~/Library/Application Support/Anti-Codex/codex-home`，Electron 数据位于同一根目录下的 `electron`。启动失败时可查阅该根目录下的 `desktop.log`。
- CodexPlusPlus 使用本机端口 `18484`，官方 ACP 另用 `18488`。所需端口被占用时，启动器会报错。
- 系统的 `codex://` 链接继续由原有关联的应用处理。macOS 副本目前未接入系统级 Computer Use 助手。旧版 Antigravity Desktop Cascade 入口仅适用于 Windows。

## Windows 安装与使用

Windows 安装器面向 Windows 10 / 11 x64，需要已安装官方 Codex Desktop、Node.js、Windows PowerShell 5.1、Git 和 Python。双击仓库根目录的 `install-windows.bat`，安装后从桌面或开始菜单启动 **Anti-Codex**。

在左下角个人菜单选择 **管理**，或从开始菜单打开 **Manage Anti-Codex**，即可配置第三方 API、刷新模型目录。官方 Antigravity 模型需要已登录的 `agy`。使用旧版 Desktop Cascade 时，需保持 Antigravity Desktop 已登录并运行。

官方 Codex 更新后，在开始菜单的 **Anti-Codex** 程序组运行 **Sync Anti-Codex with Codex**。需要恢复上一版时，运行 **Rollback Anti-Codex**。副本安装在 `%LOCALAPPDATA%\Anti-Codex`，运行数据保存在 `%APPDATA%\anticodex`。更多说明见 [Windows 使用指南](docs/WINDOWS.md)。

## 模型路由与开发文档

1. **Codex Desktop 隔离副本**（isolated official Codex Desktop copy）保留原生任务控制，负责工具调用（tools）、审批、重试和上下文压缩（compaction）。
2. **CodexPlusPlus** 处理 Responses 和 Chat Completions 的协议转换。第三方 API 请求（third-party bypass）由它直接发往所配置的服务商。
3. **Antigravity 适配层**处理官方 ACP 路由和 Windows 上的轻量 Chat-to-Cascade 兼容路由（thin adapter）。

连接器应用工具（connector-backed app tools）需要用对应服务完成授权后才能调用。

- [三层架构](docs/THREE_LAYER_ARCHITECTURE.md) · [协议与路由](docs/ADAPTIVE_ONE_API_STACK.md)
- [macOS 回归测试](docs/MACOS.md#本机回归测试) · [维护手册](MAINTENANCE.md) · [已知限制](KNOWN_LIMITATIONS.md)

## 许可与致谢

本项目采用[非商业许可](LICENSE)。CodexPlusPlus 沿用 AGPL-3.0 许可，锁定版本和补丁记录见 [CodexPlusPlus 组件说明](third_party/codexplusplus/README.md)。其他第三方代码及归属见 [第三方声明](THIRD_PARTY_NOTICES.md)。

本项目独立维护，与 OpenAI 或 Antigravity 无官方关联。
