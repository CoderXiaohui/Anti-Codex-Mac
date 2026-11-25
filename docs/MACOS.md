# 在 macOS 上使用 Anti-Codex

## 安装与启动

安装官方 Codex Desktop 和 Xcode 命令行工具。使用 Node.js 22 或更新版本，安装器也会尝试使用官方应用自带的 Node.js。首次构建需要联网获取仓库锁定的 CodexPlusPlus 源码和 Rust 依赖。机器上已有 Cargo 时会直接使用。缺少 Cargo 时，安装器会校验 rustup 下载并将工具链放入 `~/Library/Caches/Anti-Codex`。

```sh
./install-macos.command --check
./install-macos.command
open "$HOME/Applications/Anti-Codex.app"
```

安装也可以通过 Finder 双击 `install-macos.command`。官方应用的标识应为 `com.openai.codex`。若它在自定义位置，可以在安装命令前指定 `ANTICODEX_SOURCE_APP="/路径/到/Codex.app"`。

## 选择模型

首次打开时，选择服务商并按对话框完成设置。第三方 API 支持 **Chat Completions** 和 **Responses**，选择服务商提供的协议，输入包含版本路径的 Base URL 及 API Key。设置时会查询模型列表。若服务商未提供列表，可手动输入模型 ID。使用 Antigravity 官方路线需要先登录 `agy` 并确认 `agy models` 返回目标型号。macOS 使用官方 ACP 路线，旧版 Desktop Cascade 见 Windows 指南。

退出 **Anti-Codex** 后，可重新配置。原版 Codex 可以继续工作。

```sh
./install-macos.command --configure
```

也支持终端配置。第三方路线读取 `ANTICODEX_PROVIDER=third-party`、`UPSTREAM_PROTOCOL`（`chat` 或 `responses`）、`UPSTREAM_URL` 和 `UPSTREAM_API_KEY`，可用 `UPSTREAM_MODEL` 指定默认型号。官方 ACP 路线使用 `ANTICODEX_PROVIDER=antigravity` 及可选的 `ANTICODEX_MODEL`。提供变量后运行同一个 `--configure` 命令。服务商配置保存在当前用户私有的数据目录中。

## 与原版同时使用

从 `~/Applications/Anti-Codex.app` 启动隔离副本。它运行复制的桌面宿主和内置 CLI，使用独立的 macOS 应用标识。副本的主目录、Electron 用户数据、Codex 配置、SQLite 数据库和会话文件均位于 `~/Library/Application Support/Anti-Codex` 下，首次使用从空白历史开始。桌面客户端退出时，随它启动的模型路由也会退出。

系统中的 `codex://` 链接继续交给原有关联的应用。安装器在副本中移除宿主启动时的默认链接注册，并重新校验和签名。若更新后无法识别该注册逻辑，安装器会保留上个可用版本。macOS 副本目前未接入系统级 Computer Use 助手。

| 位置 | 用途 |
| --- | --- |
| `~/Applications/Anti-Codex.app` | Finder 启动入口，指向当前已验证版本 |
| `~/Library/Application Support/Anti-Codex/releases` | 当前及上一个隔离版本 |
| `~/Library/Application Support/Anti-Codex/codex-home` | 副本的会话、配置和数据库 |
| `~/Library/Application Support/Anti-Codex/electron` | 副本的桌面配置和缓存 |
| `~/Library/Application Support/Anti-Codex/desktop.log` | 副本及其模型路由的启动日志 |

CodexPlusPlus 使用本机端口 `18484`。官方 ACP 路线另用 `18488`。端口被占用时，启动器会报错，已有进程继续运行。

运行期间，桌面组件的 Unix 套接字使用 `/private/tmp` 下仅当前用户可访问的短路径，退出后会自动清理。即使用户名或安装路径较长，也能满足 macOS 的套接字路径长度限制。

## 更新与回滚

退出隔离副本，重新运行 `./install-macos.command` 即可从当前官方应用复制新版本。安装器先检查候选应用的签名和本机路由程序，再切换 Finder 入口。运行 `./install-macos.command --rollback` 可恢复上个版本。两个版本共用 Anti-Codex 自己的聊天与配置目录。

## 本机回归测试

在仓库根目录执行以下命令可验证配置隔离、启动锁、模型发现和官方 ACP 路由。测试使用临时目录和本机模拟服务。

```sh
node --test --test-concurrency=2 translator/tests/anticodex-macos.test.mjs translator/tests/antigravity-acp-client.test.mjs translator/tests/antigravity-official-route.test.mjs
```
