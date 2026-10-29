# BastionPilot

[![CI](https://github.com/yueseqaz/bastion-pilot/actions/workflows/ci.yml/badge.svg)](./.github/workflows/ci.yml)
[English](./README.md)

**把 AI Agent 带进堡垒机 Web 终端。**

在很多公司，访问生产服务器的唯一途径是堡垒机（JumpServer、齐治、阿里云堡垒机……），而它只在
浏览器里提供一个 **Web 终端**。没有 SSH 直连，Claude Code、Codex 这类 CLI Agent 就够不到你的
服务器。BastionPilot 就是来解决这个问题的：一个浏览器插件挂接 Web 终端，充当 Agent 的
“手和眼”；一个本地 bridge 把干净、可审计的工具暴露给你选用的任意 AI 大脑。

```
Claude Code / Codex            侧边栏聊天
   (MCP stdio)                       │
        │                            │ HTTPS → 你的 AI Provider
        ▼                            ▼
┌─────────────────────────────────────────────┐
│            本地 bridge（守护进程）             │
│  MCP Server │ 内置 Agent 循环 │ 审批 │ 审计日志  │
└──────────────┬──────────────────────────────┘
               │ ws://127.0.0.1 + 配对 token
               ▼
┌─────────────────────────────────────────────┐
│           浏览器插件（Manifest V3）            │
│  主世界注入：WebSocket 拦截（读 + 写）          │
│  内容控制器：会话 + 输出缓冲                    │
│  Service Worker：工具路由、审批                │
└──────────────┬──────────────────────────────┘
               │ 页面自己的 WebSocket
               ▼
     堡垒机 Web 终端（JumpServer / 任意 xterm.js 产品）
```

## 工作原理

- **插件是终端 I/O 的唯一持有者。** 一段主世界脚本在 `document_start` 注入，替换
  `window.WebSocket`：把每一帧下行数据（PTY 字节流）镜像出来，并可以按需向终端写入。不管堡垒
  机产品怎么渲染——canvas 上的 xterm.js、WebGL、随便什么——原始流在绘制之前就已被捕获。
- **其他所有大脑都连到它。** Claude Code / Codex 走 daemon 的 MCP Server；侧边栏聊天走 daemon
  里内置的 Agent 循环（用你自己的 OpenAI 兼容 Provider）。两种大脑汇入同一套工具执行器、同一
  份审批策略、同一份审计日志。
- **输出被加工成模型友好的形态。** PTY 字节流被解码（UTF-8、跨块安全），ANSI/OSC 转义序列被
  剥离，`\r`/`\b` 的覆盖语义被正确应用（进度条塌缩成最终一行）；超长输出落盘到本地文件并把路
  径返回给 Agent——Claude Code 可以用自己的文件工具精读全文。
- **命令完成判定可靠。** 输入命令后追加一条 `echo __BP_<nonce>_$?__` 哨兵。回显里的字面 `$?`
  永远匹配不上结果模式，所以哨兵恰好触发一次，并带回退出码。交互场景由静默检测和超时兜底。
- **产品差异被压进很薄的 profile。** WebSocket 传输层是通用的；分帧方式（raw / JSON /
  base64）和 DOM 线索放在声明式的站点 profile 里。JumpServer 内置支持；任何 xterm.js 系的产
  品用通用 profile 即可。

## 你会得到什么

| 大脑                                  | 接入方式                                |
| ------------------------------------- | --------------------------------------- |
| Claude Code / Codex / 任何 MCP 客户端 | `bastion-pilot mcp`（stdio）— 推荐      |
| 内置侧边栏聊天                        | 任意 OpenAI 兼容端点（云端或自建/内网） |

暴露给 Agent 的工具：`list_sessions`、`send_command`、`read_output`、`wait_output`、
`send_key`、`get_screen` —— 完整契约见 [docs/tools.md](./docs/tools.md)。

安全机制：

- **审批三档**（`auto` / `confirm` / `readonly` + 白名单），在 bridge 层对*所有*大脑强制生
  效。默认 `confirm`：每条会改状态的命令都等你在侧边栏或系统通知里点一下。
- **本地审计日志**：每次工具调用一行 JSONL，写在 `~/.bastion-pilot/audit/`。
- **只读工具分类**：`list_sessions`、`read_output`、`wait_output`、`get_screen` 永远不需要审
  批。
- **站点访问完全 opt-in**：插件只在你明确授权的 origin 上运行。
- 堡垒机自己的会话录像照常工作——BastionPilot 像人一样打字，你的合规状况不变。

## 快速开始

### 1. Bridge（本地守护进程 + MCP Server）

需要 Node.js ≥ 20。

```bash
git clone https://github.com/yueseqaz/bastion-pilot.git
cd bastion-pilot
pnpm install && pnpm build

# 生成配置 + 配对 token，打印接入说明
node packages/bridge/dist/cli.js init

# 启动守护进程（保持运行；MCP Server 也能自动拉起它）
node packages/bridge/dist/cli.js daemon

# 随时体检
node packages/bridge/dist/cli.js doctor
```

`init` 会创建 `~/.bastion-pilot/config.json`（chmod 600），内含配对 token，并打印 token 以及
Claude Code / Codex 的接入片段。

### 2. 浏览器插件

Chrome / Edge（Chromium ≥ 116）：

1. 构建一次：`pnpm --filter @bastion-pilot/extension build`（或从 GitHub Releases / CI 产物下
   载 zip 解压）。
2. 打开 `chrome://extensions`，开启**开发者模式**，点**加载已解压的扩展程序**，选择
   `packages/extension/dist`。
3. 点工具栏图标打开 BastionPilot 侧边栏 → **⚙ 设置** → 填 daemon URL 和配对 token →
   **Save** → **Test connection**。
4. 在 **Bastion sites** 里授权你的堡垒机 origin，例如 `https://bastion.example.com`。

### 3. 接上大脑

**Claude Code**

```bash
claude mcp add bastion-pilot -- node /绝对路径/bastion-pilot/packages/bridge/dist/cli.js mcp
```

**Codex CLI** — 在 `~/.codex/config.toml` 里加：

```toml
[mcp_servers.bastion-pilot]
command = "node"
args = ["/绝对路径/bastion-pilot/packages/bridge/dist/cli.js", "mcp"]
```

然后就可以在 Agent 里说：_“列出堡垒机会话，然后在 web-01 上看看磁盘占用。”_ Agent 会先调
`list_sessions`，再 `send_command df -h`，读输出、给结论——全程受你的审批模式约束。

**内置侧边栏聊天**（可选）— 在 `~/.bastion-pilot/config.json` 里加一个 OpenAI 兼容
Provider：

```json
{
  "providers": [
    {
      "id": "default",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-...",
      "model": "gpt-4o"
    }
  ],
  "activeProviderId": "default"
}
```

自建/内网网关（vLLM、Ollama 的 OpenAI 适配、公司内部 LLM 网关）配置结构相同——只要你不愿
意，终端输出可以完全不出内网。侧边栏历史可跨重启恢复：重新打开面板会自动载入最近一次对话。

## 配置

`~/.bastion-pilot/config.json`（由 `bastion-pilot init` 创建）：

| 键                           | 默认值    | 说明                                                 |
| ---------------------------- | --------- | ---------------------------------------------------- |
| `server.port`                | `8765`    | daemon 监听端口（始终只绑 `127.0.0.1`）              |
| `security.token`             | 自动生成  | 插件与 MCP Server 的配对 token                       |
| `approval.mode`              | `confirm` | `auto` / `confirm` / `readonly`                      |
| `approval.confirmTimeoutMs`  | `120000`  | 审批超时即拒绝                                       |
| `approval.readonlyAllowlist` | `[]`      | 正则列表；`readonly` 模式下命中的命令放行            |
| `providers[]`                | `[]`      | 内置聊天用的 OpenAI 兼容 Provider                    |
| `activeProviderId`           | `null`    | 侧边栏聊天使用的 Provider                            |
| `agent.maxIterations`        | `30`      | 内置 Agent 循环上限                                  |
| `agent.systemPrompt`         | 内置      | 替换默认的安全优先提示词                             |
| `output.maxInlineChars`      | `6000`    | 超过则截断 + 落盘                                    |
| `transcripts.enabled`        | `true`    | 按会话记录终端转录到 `~/.bastion-pilot/transcripts/` |

插件侧设置（选项页）：daemon URL、配对 token、已授权 origin 及每个 origin 的站点 profile
（`generic-xterm` / `jumpserver`）。

## 常见问题

| 现象                             | 处理                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------- |
| `doctor` 显示 extension 未连接   | daemon 在跑吗？token 填了吗？点一下工具栏图标唤醒 service worker。                                |
| 工具调用报 "no terminal session" | 授权站点**之后**再打开（或刷新）堡垒机终端标签页；确认 options 里授权过该 origin。                |
| 输出乱码                         | 你的产品用 JSON/base64 分帧 PTY——复制一个 profile 改 `framer.type`，然后在选项页选用。            |
| Agent 打字但没反应               | 有些产品在客户端拦截按键；在自定义 profile 里改 `inputMode: "dom"`。                              |
| 长命令“超时”                     | 不是失败——传更大的 `waitMs`，或让 Agent 拿着返回的 cursor 用 `read_output`/`wait_output` 继续收。 |
| 审批一直不出现                   | 审批会推给插件；检查侧边栏和系统通知，并确认只配对了一个浏览器 profile。                          |

## 开发

```bash
pnpm install
pnpm all        # build + typecheck + test + lint
pnpm test       # protocol / bridge / extension 共 86 个测试
pnpm --filter @bastion-pilot/extension zip   # 插件发布 zip
node scripts/gen-icons.mjs                   # 重新生成图标
```

仓库结构：

```
packages/protocol   通信协议、工具契约、终端文本渲染
packages/bridge     daemon、MCP Server、内置 Agent 循环、审批、审计
packages/extension  MV3 插件（拦截器、控制器、worker、侧边栏、选项页）
profiles            适配更多堡垒机产品的说明
```

面向 Agent 的工具契约见 [docs/tools.md](./docs/tools.md)；适配新堡垒机产品见
[profiles/README.md](./profiles/README.md)。

## 安全说明

见 [SECURITY.md](./SECURITY.md)。简版：本地服务只绑 `127.0.0.1` 且需 token；配置/审计/输出文
件 `chmod 600`；审批策略集中强制执行；堡垒机自身的审计轨迹完全不受影响。**遵守公司政策是你
的责任**——包括终端输出是否允许发给云端 LLM。

## 路线图

- [x] 通过终端传文件（`upload_file` / `download_file`，base64 分块）
- [x] iframe 型终端（每个终端 iframe 一个会话）
- [x] 更多站点 profile —— Teleport、齐治、阿里云堡垒机（实验性，欢迎实测反馈）
- [x] 会话转录回放（`bastion-pilot transcripts`）
- [x] bridge 包已就绪可发布 npm（`pnpm --filter bastion-pilot publish`）
- [ ] 正式发布 npm + `npx bastion-pilot mcp`（需要维护者的 npm 账号）
- [ ] 非 xterm 终端的视觉兜底（Guacamole 类 canvas 流）
- [ ] 单个浏览器 frame 内的多终端

## 许可证

[MIT](./LICENSE)
