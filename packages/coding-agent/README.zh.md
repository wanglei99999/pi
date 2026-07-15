<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@earendil-works/pi-coding-agent?style=flat-square" /></a>
</p>

> 新贡献者提交的 issue 和 PR 默认会被自动关闭。维护者每天会审阅被自动关闭的 issue。参见 [CONTRIBUTING.md](../../CONTRIBUTING.md)。

---

Pi 是一个极简的终端 coding harness。让 pi 适配你的工作流，而不是反过来——你无需 fork 和修改 pi 的内部实现。通过 TypeScript [Extensions](#extensions)、[Skills](#skills)、[Prompt Templates](#prompt-templates) 和 [Themes](#themes) 扩展它。把你的 extensions、skills、prompt templates 和 themes 打包成 [Pi Packages](#pi-packages)，通过 npm 或 git 分享给他人。

Pi 自带强大的默认配置，但省略了 sub agent 和 plan mode 之类的功能。你可以让 pi 帮你构建想要的功能，或者安装一个符合你工作流的第三方 pi package。

Pi 有四种运行模式：交互式、print 或 JSON、用于进程集成的 RPC，以及用于嵌入到你自己应用中的 SDK。真实世界的 SDK 集成案例参见 [openclaw/openclaw](https://github.com/openclaw/openclaw)。

## 分享你的 OSS coding agent 会话

如果你在开源工作中使用 pi，请分享你的 coding agent 会话。

公开的 OSS 会话数据能利用真实的开发工作流帮助改进模型、prompt、工具和评估。

完整说明参见 [这篇 X 上的帖子](https://x.com/badlogicgames/status/2037811643774652911)。

要发布会话，请使用 [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf)。阅读它的 README.md 了解设置步骤。你只需要一个 Hugging Face 账号、Hugging Face CLI 和 `pi-share-hf`。

你也可以观看 [这个视频](https://x.com/badlogicgames/status/2041151967695634619)，其中展示了作者如何发布自己的 `pi-mono` 会话。

作者定期在这里发布自己的 `pi-mono` 工作会话：

- [Hugging Face 上的 badlogicgames/pi-mono](https://huggingface.co/datasets/badlogicgames/pi-mono)

## 目录

- [快速开始](#快速开始)
- [Providers 与模型](#providers-与模型)
- [交互模式](#交互模式)
  - [编辑器](#编辑器)
  - [命令](#命令)
  - [键盘快捷键](#键盘快捷键)
  - [消息队列](#消息队列)
- [会话](#会话)
  - [分支](#分支)
  - [Compaction](#compaction)
- [设置](#设置)
- [上下文文件](#上下文文件)
- [自定义](#自定义)
  - [Prompt Templates](#prompt-templates)
  - [Skills](#skills)
  - [Extensions](#extensions)
  - [Themes](#themes)
  - [Pi Packages](#pi-packages)
- [编程式使用](#编程式使用)
- [理念](#理念)
- [CLI 参考](#cli-参考)

---

## 快速开始

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

`--ignore-scripts` 会在安装期间禁用依赖的 lifecycle scripts。普通 npm 安装时 Pi 不需要 install scripts。

安装器方式（备选）：

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

使用 API key 认证：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pi
```

或使用你现有的订阅：

```bash
pi
/login  # 然后选择 provider
```

然后直接跟 pi 对话即可。默认情况下，pi 给模型提供四个工具：`read`、`write`、`edit` 和 `bash`。模型使用这些工具来完成你的请求。可以通过 [skills](#skills)、[prompt templates](#prompt-templates)、[extensions](#extensions) 或 [pi packages](#pi-packages) 添加能力。

**平台说明：** [Windows](docs/windows.md) | [Termux (Android)](docs/termux.md) | [tmux](docs/tmux.md) | [终端设置](docs/terminal-setup.md) | [Shell 别名](docs/shell-aliases.md)

---

## Providers 与模型

对每个内置 provider，pi 维护一份支持工具调用的模型列表，每个发布版本都会更新。通过订阅（`/login`）或 API key 认证后，即可通过 `/model`（或 Ctrl+L）选择该 provider 的任意模型。

**订阅：**
- Anthropic Claude Pro/Max
- OpenAI ChatGPT Plus/Pro (Codex)
- GitHub Copilot

**API key：**
- Anthropic
- Ant Ling
- OpenAI
- Azure OpenAI
- DeepSeek
- NVIDIA NIM
- Google Gemini
- Google Vertex
- Amazon Bedrock
- Mistral
- Groq
- Cerebras
- Cloudflare AI Gateway
- Cloudflare Workers AI
- xAI
- OpenRouter
- Vercel AI Gateway
- ZAI Coding Plan (Global)
- ZAI Coding Plan (China)
- OpenCode Zen
- OpenCode Go
- Hugging Face
- Fireworks
- Together AI
- Kimi For Coding
- MiniMax
- Xiaomi MiMo
- Xiaomi MiMo Token Plan (China)
- Xiaomi MiMo Token Plan (Amsterdam)
- Xiaomi MiMo Token Plan (Singapore)

详细设置说明参见 [docs/providers.md](docs/providers.md)。

**自定义 provider 与模型：** 如果 provider 使用受支持的 API（OpenAI、Anthropic、Google），可通过 `~/.pi/agent/models.json` 添加。对于自定义 API 或 OAuth，请使用 extensions。参见 [docs/models.md](docs/models.md) 和 [docs/custom-provider.md](docs/custom-provider.md)。

---

## 交互模式

<p align="center"><img src="docs/images/interactive-mode.png" alt="Interactive Mode" width="600"></p>

界面从上到下：

- **启动 header** —— 显示快捷键（`/hotkeys` 查看全部）、已加载的 AGENTS.md 文件、prompt templates、skills 和 extensions
- **消息** —— 你的消息、assistant 回复、工具调用和结果、通知、错误以及 extension UI
- **编辑器** —— 输入的地方；边框颜色指示 thinking 级别
- **Footer** —— 工作目录、会话名、总 token/缓存用量（`↑` 输入、`↓` 输出、`R` 缓存读取、`W` 缓存写入、`CH` 最近的缓存命中率）、费用、上下文用量、当前模型

编辑器可以被其他 UI 临时替换，比如内置的 `/settings` 或来自 extension 的自定义 UI（例如一个让用户以结构化方式回答模型提问的 Q&A 工具）。[Extensions](#extensions) 还可以替换编辑器，在其上方/下方添加 widget、状态栏、自定义 footer 或 overlay。

### 编辑器

| 功能 | 方法 |
|---------|-----|
| 文件引用 | 输入 `@` 模糊搜索项目文件 |
| 路径补全 | Tab 补全路径 |
| 多行输入 | Shift+Enter（Windows Terminal 上为 Ctrl+Enter） |
| 外部编辑器 | Ctrl+G 打开 `externalEditor`、`$VISUAL`、`$EDITOR`，Windows 上为 Notepad，其他平台为 `nano` |
| 图片 | Ctrl+V 粘贴（Windows 上为 Alt+V），或拖拽到终端 |
| Bash 命令 | `!command` 运行并把输出发送给 LLM，`!!command` 运行但不发送 |

标准编辑快捷键如删除单词、撤销等，参见 [docs/keybindings.md](docs/keybindings.md)。

### 命令

在编辑器中输入 `/` 触发命令。[Extensions](#extensions) 可以注册自定义命令，[skills](#skills) 以 `/skill:name` 形式可用，[prompt templates](#prompt-templates) 通过 `/templatename` 展开。

| 命令 | 描述 |
|---------|-------------|
| `/login`、`/logout` | OAuth 认证 |
| `/model` | 切换模型 |
| `/scoped-models` | 启用/禁用 Ctrl+P 循环切换的模型 |
| `/settings` | Thinking 级别、主题、消息投递、transport |
| `/resume` | 从过往会话中选择 |
| `/new` | 开始新会话 |
| `/name <name>` | 设置会话显示名 |
| `/session` | 显示会话信息（文件、ID、消息、token、费用） |
| `/tree` | 跳转到会话中的任意位置并从那里继续 |
| `/trust` | 为未来的会话保存项目信任决定（需要重启） |
| `/fork` | 从之前的某条用户消息创建新会话 |
| `/clone` | 将当前活动分支复制为一个新会话 |
| `/compact [prompt]` | 手动 compact 上下文，可附加自定义指令 |
| `/copy` | 复制最后一条 assistant 消息到剪贴板 |
| `/export [file]` | 导出会话为 HTML 或 JSONL 文件 |
| `/import <file>` | 从 JSONL 文件导入并恢复会话 |
| `/share` | 上传为私有 GitHub gist，附带可分享的 HTML 链接 |
| `/reload` | 重新加载 keybindings、extensions、skills、prompts、themes 和上下文文件 |
| `/hotkeys` | 显示所有键盘快捷键 |
| `/changelog` | 显示版本历史 |
| `/quit` | 退出 pi |

### 键盘快捷键

完整列表见 `/hotkeys`。通过 `~/.pi/agent/keybindings.json` 自定义。参见 [docs/keybindings.md](docs/keybindings.md)。

**常用：**

| 按键 | 动作 |
|-----|--------|
| Ctrl+C | 清空编辑器 |
| Ctrl+C 两次 | 退出 |
| Escape | 取消/中止 |
| Escape 两次 | 打开 `/tree` |
| Ctrl+L | 打开模型选择器 |
| Ctrl+P / Shift+Ctrl+P | 向前/向后循环切换 scoped models |
| Shift+Tab | 循环切换 thinking 级别 |
| Ctrl+O | 折叠/展开工具输出 |
| Ctrl+T | 折叠/展开 thinking 块 |

### 消息队列

在 agent 工作时也可以提交消息：

- **Enter** 将消息作为 *steering* 消息入队，在当前 assistant turn 执行完其工具调用后投递
- **Alt+Enter** 将消息作为 *follow-up* 消息入队，仅在 agent 完成所有工作后投递
- **Escape** 中止并把已入队的消息恢复到编辑器
- **Alt+Up** 把已入队的消息取回到编辑器

在 Windows Terminal 上，`Alt+Enter` 默认是全屏。请按 [docs/terminal-setup.md](docs/terminal-setup.md) 重新映射，使 pi 能接收到 follow-up 快捷键。

在 [settings](docs/settings.md) 中配置投递方式：`steeringMode` 和 `followUpMode` 可以是 `"one-at-a-time"`（默认，等待响应）或 `"all"`（一次投递所有排队消息）。`transport` 为支持多种 transport 的 provider 选择传输偏好（`"sse"`、`"websocket"` 或 `"auto"`）。

---

## 会话

会话以带树结构的 JSONL 文件存储。每个条目都有 `id` 和 `parentId`，支持就地分支而无需创建新文件。文件格式参见 [docs/session-format.md](docs/session-format.md)。

### 管理

会话自动保存到 `~/.pi/agent/sessions/`，按工作目录组织。

```bash
pi -c                  # 继续最近的会话
pi -r                  # 浏览并选择过往会话
pi --no-session        # 临时模式（不保存）
pi --name "my task"    # 启动时设置会话显示名
pi --session <path|id> # 使用指定的会话文件或 ID
pi --fork <path|id>    # 将指定的会话文件或 ID fork 为新会话
```

在交互模式中使用 `/session` 查看当前会话 ID，之后可配合 `--session <id>` 或 `--fork <id>` 复用。

### 分支

**`/tree`** —— 就地浏览会话树。选择任意历史节点、从那里继续，并在分支之间切换。所有历史都保存在同一个文件里。

<p align="center"><img src="docs/images/tree-view.png" alt="Tree View" width="600"></p>

- 输入即可搜索，用 Ctrl+←/Ctrl+→ 或 Alt+←/Alt+→ 折叠/展开并在分支间跳转，用 ←/→ 翻页
- 过滤模式（Ctrl+O）：default → no-tools → user-only → labeled-only → all
- 按 Shift+L 为条目添加标签作为书签，按 Shift+T 切换标签时间戳显示

**`/fork`** —— 从活动分支上之前的某条用户消息创建新的会话文件。打开一个选择器，复制到该点为止的活动路径，并把选中的 prompt 放入编辑器供修改。

**`/clone`** —— 在当前位置把当前活动分支复制为一个新的会话文件。新会话保留完整的活动路径历史，并以空编辑器打开。

**`--fork <path|id>`** —— 直接从 CLI fork 一个已有的会话文件或部分会话 UUID。这会把完整的源会话复制为当前项目中的新会话文件。

### Compaction

长会话可能耗尽上下文窗口。Compaction 会总结较早的消息，同时保留较近的消息。

**手动：** `/compact` 或 `/compact <自定义指令>`

**自动：** 默认启用。在上下文溢出时触发（恢复并重试），或接近上限时触发（主动）。通过 `/settings` 或 `settings.json` 配置。

Compaction 是有损的。完整历史仍保留在 JSONL 文件中；用 `/tree` 可以回顾。可通过 [extensions](#extensions) 自定义 compaction 行为。内部机制参见 [docs/compaction.md](docs/compaction.md)。

---

## 设置

使用 `/settings` 修改常用选项，或直接编辑 JSON 文件：

| 位置 | 作用域 |
|----------|-------|
| `~/.pi/agent/settings.json` | 全局（所有项目） |
| `.pi/settings.json` | 项目（覆盖全局） |

所有选项参见 [docs/settings.md](docs/settings.md)。

### 项目信任

在交互式启动时，如果项目文件夹包含项目级设置、资源或项目 `.agents/skills`，且该文件夹或其父文件夹在 `~/.pi/agent/trust.json` 中没有已保存的决定，pi 会先询问是否信任。信任一个项目允许 pi 加载 `.pi/settings.json` 和 `.pi` 资源、安装缺失的项目 packages，并执行项目 extensions。

在做出信任决定之前，pi 只加载上下文文件、用户级/全局 extensions 以及 CLI `-e` extensions，以便它们能处理 `project_trust` 事件。项目级 extensions、项目 package 管理的 extensions 和项目设置仅在项目被信任后才加载。当切换到来自不同 cwd 且其信任在当前进程中尚未解析的会话时，同样适用这一拆分。

非交互模式（`-p`、`--mode json` 和 `--mode rpc`）不显示信任提示。在没有适用的已保存信任决定时，它们使用全局设置中的 `defaultProjectTrust`：`ask`（默认）和 `never` 会忽略那些项目资源，而 `always` 会信任它们。传入 `--approve`/`-a` 或 `--no-approve`/`-na` 可以为单次运行覆盖项目信任。

如果没有 extension 或已保存的决定适用，`defaultProjectTrust` 控制回退行为。在 `~/.pi/agent/settings.json` 中设置为 `"ask"`、`"always"` 或 `"never"`，或通过 `/settings` 修改。

`pi config` 和 package 命令使用相同的项目信任流程，只是 `pi update` 从不提示。传入 `--approve` 为单条命令信任项目级设置，或传 `--no-approve` 忽略它们。

在交互模式中使用 `/trust` 为未来的会话保存项目信任决定，包括对直接父文件夹的信任。它只写入 `~/.pi/agent/trust.json`；当前会话不会重新加载，需重启 pi 使更改生效。

### 遥测与更新检查

Pi 有两个独立的启动功能：

- **更新检查：** 请求 `https://pi.dev/api/latest-version` 检查是否有更新的 Pi 版本。用 `PI_SKIP_VERSION_CHECK=1` 禁用。禁用更新检查只关闭这一项检查。
- **安装/更新遥测：** 首次安装或检测到 changelog 更新后，向 `https://pi.dev/api/report-install` 发送匿名版本 ping。该设置还控制针对 OpenRouter、Cloudflare 和直接 NVIDIA NIM 请求的可选 provider 归属 headers。在 `settings.json` 中把 `enableInstallTelemetry` 设为 `false`，或设置 `PI_TELEMETRY=0` 即可退出。这不会禁用更新检查；除非禁用了更新检查或启用了离线模式，Pi 仍可能联系 `pi.dev` 获取最新版本。

使用 `--offline` 或 `PI_OFFLINE=1` 禁用这里描述的所有启动网络操作，包括更新检查、package 更新检查和安装/更新遥测。

---

## 上下文文件

Pi 在启动时从以下位置加载 `AGENTS.md`（或 `CLAUDE.md`）：
- `~/.pi/agent/AGENTS.md`（全局）
- 父目录（从 cwd 向上遍历）
- 当前目录

用于项目指令（`AGENTS.md`/`CLAUDE.md`）、约定、常用命令。所有匹配的文件会被拼接。

使用 `--no-context-files`（或 `-nc`）禁用上下文文件加载。

### System Prompt

用 `.pi/SYSTEM.md`（项目）或 `~/.pi/agent/SYSTEM.md`（全局）替换默认的 system prompt。通过 `APPEND_SYSTEM.md` 追加而不替换。

---

## 自定义

### Prompt Templates

以 Markdown 文件形式存在的可复用 prompt。输入 `/name` 展开。

```markdown
<!-- ~/.pi/agent/prompts/review.md -->
Review this code for bugs, security issues, and performance problems.
Focus on: {{focus}}
```

放在 `~/.pi/agent/prompts/`、`.pi/prompts/` 或一个 [pi package](#pi-packages) 中即可分享给他人。参见 [docs/prompt-templates.md](docs/prompt-templates.md)。

### Skills

遵循 [Agent Skills 标准](https://agentskills.io) 的按需能力包。通过 `/skill:name` 调用，或让 agent 自动加载。

```markdown
<!-- ~/.pi/agent/skills/my-skill/SKILL.md -->
# My Skill
Use this skill when the user asks about X.

## Steps
1. Do this
2. Then that
```

放在 `~/.pi/agent/skills/`、`~/.agents/skills/`、`.pi/skills/` 或 `.agents/skills/`（从 `cwd` 向上到各父目录）或一个 [pi package](#pi-packages) 中即可分享给他人。参见 [docs/skills.md](docs/skills.md)。

### Extensions

<p align="center"><img src="docs/images/doom-extension.png" alt="Doom Extension" width="600"></p>

用自定义工具、命令、键盘快捷键、事件处理器和 UI 组件扩展 pi 的 TypeScript 模块。

```typescript
export default function (pi: ExtensionAPI) {
  pi.registerTool({ name: "deploy", ... });
  pi.registerCommand("stats", { ... });
  pi.on("tool_call", async (event, ctx) => { ... });
}
```

默认导出也可以是 `async` 的。pi 会在启动继续之前等待异步的 extension 工厂函数，这对一次性初始化很有用，比如在调用 `pi.registerProvider()` 之前获取远程模型列表。

**能做什么：**
- 自定义工具（或完全替换内置工具）
- Sub-agent 和 plan mode
- 自定义 compaction 和总结
- 权限门控和路径保护
- 自定义编辑器和 UI 组件
- 状态栏、header、footer
- Git checkpoint 和自动提交
- SSH 和沙箱执行
- MCP server 集成
- 让 pi 看起来像 Claude Code
- 等待时玩游戏（是的，能跑 Doom）
- ……任何你能想到的东西

放在 `~/.pi/agent/extensions/`、`.pi/extensions/` 或一个 [pi package](#pi-packages) 中即可分享给他人。参见 [docs/extensions.md](docs/extensions.md) 和 [examples/extensions/](examples/extensions/)。

### Themes

内置：`dark`、`light`。主题支持热重载：修改活动主题文件，pi 会立即应用更改。

放在 `~/.pi/agent/themes/`、`.pi/themes/` 或一个 [pi package](#pi-packages) 中即可分享给他人。参见 [docs/themes.md](docs/themes.md)。

### Pi Packages

通过 npm 或 git 打包并分享 extensions、skills、prompts 和 themes。在 [npmjs.com](https://www.npmjs.com/search?q=keywords%3Api-package) 或 [Discord](https://discord.com/channels/1456806362351669492/1457744485428629628) 上查找 packages。

> **安全：** Pi packages 以完整系统权限运行。Extensions 会执行任意代码，skills 可以指示模型执行任何操作，包括运行可执行文件。安装第三方 packages 前请审查源代码。

```bash
pi install npm:@foo/pi-tools
pi install npm:@foo/pi-tools@1.2.3      # 锁定版本
pi install git:github.com/user/repo
pi install git:github.com/user/repo@v1  # tag 或 commit
pi install git:git@github.com:user/repo
pi install git:git@github.com:user/repo@v1  # tag 或 commit
pi install https://github.com/user/repo
pi install https://github.com/user/repo@v1      # tag 或 commit
pi install ssh://git@github.com/user/repo
pi install ssh://git@github.com/user/repo@v1    # tag 或 commit
pi remove npm:@foo/pi-tools
pi uninstall npm:@foo/pi-tools          # remove 的别名
pi list
pi update                               # 仅更新 pi
pi update --all                         # 更新 pi 和 packages
pi update --extensions                  # 仅更新 packages
pi update --self                        # 仅更新 pi
pi update --self --force                # 即使已是最新也重装 pi
pi update npm:@foo/pi-tools             # 更新单个 package
pi config                               # 启用/禁用 extensions、skills、prompts、themes
```

Packages 安装到 `~/.pi/agent/git/`（git）或 `~/.pi/agent/npm/`（npm）。使用 `-l` 进行项目本地安装（`.pi/git/`、`.pi/npm/`）。Git 的 `@ref` 值是锁定的 tag 或 commit；被锁定的 packages 会被 `pi update --extensions` 和 `pi update --all` 跳过，因此要把已有 package 移到新的 ref，使用 `pi install git:host/user/repo@new-ref`。Git packages 默认用 `npm install --omit=dev` 安装依赖，所以运行时依赖必须列在 `dependencies` 下；配置了 `npmCommand` 时，git packages 会使用普通的 `install` 以兼容包装器。如果你使用 Node 版本管理器并希望 package 安装复用稳定的 npm 上下文，请在 `settings.json` 中设置 `npmCommand`，例如 `["mise", "exec", "node@20", "--", "npm"]`。

在 `package.json` 中添加 `pi` 字段即可创建一个 package：

```json
{
  "name": "my-pi-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

没有 `pi` manifest 时，pi 会从约定目录（`extensions/`、`skills/`、`prompts/`、`themes/`）自动发现。

参见 [docs/packages.md](docs/packages.md)。

---

## 编程式使用

### SDK

```typescript
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});

await session.prompt("What files are in the current directory?");
```

对于高级的多会话 runtime 替换，使用 `createAgentSessionRuntime()` 和 `AgentSessionRuntime`。

参见 [docs/sdk.md](docs/sdk.md) 和 [examples/sdk/](examples/sdk/)。

### RPC 模式

对于非 Node.js 集成，使用基于 stdin/stdout 的 RPC 模式：

```bash
pi --mode rpc
```

RPC 模式使用严格的 LF 分隔 JSONL 帧。客户端必须只按 `\n` 分割记录。不要使用像 Node `readline` 这样的通用行读取器，它们还会按 JSON 负载内部的 Unicode 分隔符分割。

协议参见 [docs/rpc.md](docs/rpc.md)。

---

## 理念

Pi 具有激进的可扩展性，因此它不必主宰你的工作流。其他工具内置的功能都可以用 [extensions](#extensions)、[skills](#skills) 构建，或从第三方 [pi packages](#pi-packages) 安装。这让核心保持极简，同时让你把 pi 塑造成适合你工作方式的样子。

**没有 MCP。** 构建带 README 的 CLI 工具（参见 [Skills](#skills)），或者构建一个添加 MCP 支持的 extension。[为什么？](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/)

**没有 sub-agent。** 有很多方式可以实现。通过 tmux 生成 pi 实例，或用 [extensions](#extensions) 自建，或安装一个按你的方式实现的 package。

**没有权限弹窗。** 在容器中运行，或用 [extensions](#extensions) 构建符合你环境和安全要求的确认流程。

**没有 plan mode。** 把计划写进文件，或用 [extensions](#extensions) 构建，或安装一个 package。

**没有内置 to-do。** 它们会让模型困惑。使用 TODO.md 文件，或用 [extensions](#extensions) 自建。

**没有后台 bash。** 用 tmux。完整的可观测性、直接交互。

完整理由请阅读 [这篇博客](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)。

---

## CLI 参考

```bash
pi [options] [@files...] [messages...]
```

### Package 命令

```bash
pi install <source> [-l]     # 安装 package，-l 为项目本地安装
pi remove <source> [-l]      # 移除 package
pi uninstall <source> [-l]   # remove 的别名
pi update [source|self|pi]   # 仅更新 pi，或更新某个 package source
pi update --all              # 更新 pi 和 packages
pi update --extensions       # 仅更新 packages
pi update --self             # 仅更新 pi
pi update --self --force     # 即使已是最新也重装 pi
pi update --extension <src>  # 更新单个 package
pi list                      # 列出已安装的 packages
pi config                    # 启用/禁用 package 资源
```

`pi config` 和项目 package 命令接受 `--approve`/`--no-approve`，为单条命令信任或忽略项目级设置。`pi update` 从不提示项目信任。

### 模式

| 标志 | 描述 |
|------|-------------|
| （默认） | 交互模式 |
| `-p`、`--print` | 打印响应后退出 |
| `--mode json` | 将所有事件输出为 JSON lines（参见 [docs/json.md](docs/json.md)） |
| `--mode rpc` | 用于进程集成的 RPC 模式（参见 [docs/rpc.md](docs/rpc.md)） |
| `--export <in> [out]` | 导出会话为 HTML |

在 print 模式下，pi 还会读取管道输入的 stdin 并合并到初始 prompt 中：

```bash
cat README.md | pi -p "Summarize this text"
```

### 模型选项

| 选项 | 描述 |
|--------|-------------|
| `--provider <name>` | Provider（anthropic、openai、google 等） |
| `--model <pattern>` | 模型 pattern 或 ID（支持 `provider/id` 和可选的 `:<thinking>`） |
| `--api-key <key>` | API key（覆盖环境变量） |
| `--thinking <level>` | `off`、`minimal`、`low`、`medium`、`high`、`xhigh` |
| `--models <patterns>` | 用于 Ctrl+P 循环切换的逗号分隔 pattern |
| `--list-models [search]` | 列出可用模型 |

### 会话选项

| 选项 | 描述 |
|--------|-------------|
| `-c`、`--continue` | 继续最近的会话 |
| `-r`、`--resume` | 浏览并选择会话 |
| `--session <path\|id>` | 使用指定的会话文件或部分 UUID |
| `--fork <path\|id>` | 将指定的会话文件或部分 UUID fork 为新会话 |
| `--session-dir <dir>` | 自定义会话存储目录 |
| `--no-session` | 临时模式（不保存） |
| `--name <name>`、`-n <name>` | 启动时设置会话显示名 |

### 工具选项

| 选项 | 描述 |
|--------|-------------|
| `--tools <list>`、`-t <list>` | 跨内置、extension 和自定义工具的工具名 allowlist |
| `--exclude-tools <list>`、`-xt <list>` | 跨内置、extension 和自定义工具禁用指定工具名 |
| `--no-builtin-tools`、`-nbt` | 默认禁用内置工具，但保持 extension/自定义工具启用 |
| `--no-tools`、`-nt` | 默认禁用所有工具 |

可用的内置工具：`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`

### 资源选项

| 选项 | 描述 |
|--------|-------------|
| `-e`、`--extension <source>` | 从路径、npm 或 git 加载 extension（可重复） |
| `--no-extensions` | 禁用 extension 发现 |
| `--skill <path>` | 加载 skill（可重复） |
| `--no-skills` | 禁用 skill 发现 |
| `--prompt-template <path>` | 加载 prompt template（可重复） |
| `--no-prompt-templates` | 禁用 prompt template 发现 |
| `--theme <path>` | 加载 theme（可重复） |
| `--no-themes` | 禁用 theme 发现 |
| `--no-context-files`、`-nc` | 禁用 AGENTS.md 和 CLAUDE.md 上下文文件发现 |

将 `--no-*` 与显式标志组合，可以精确加载你需要的内容并忽略 settings.json（例如 `--no-extensions -e ./my-ext.ts`）。

### 其他选项

| 选项 | 描述 |
|--------|-------------|
| `--system-prompt <text>` | 替换默认 prompt（上下文文件和 skills 仍会追加） |
| `--append-system-prompt <text>` | 追加到 system prompt |
| `--verbose` | 强制显示详细启动信息 |
| `-a`、`--approve` | 本次运行信任项目级文件 |
| `-na`、`--no-approve` | 本次运行忽略项目级文件 |
| `-h`、`--help` | 显示帮助 |
| `-v`、`--version` | 显示版本 |

### 文件参数

用 `@` 前缀把文件包含在消息中：

```bash
pi @prompt.md "Answer this"
pi -p @screenshot.png "What's in this image?"
pi @code.ts @test.ts "Review these files"
```

### 示例

```bash
# 带初始 prompt 的交互模式
pi "List all .ts files in src/"

# 非交互
pi -p "Summarize this codebase"

# 非交互 + 管道 stdin
cat README.md | pi -p "Summarize this text"

# 命名的一次性会话
pi --name "release audit" -p "Audit this repository"

# 不同模型
pi --provider openai --model gpt-4o "Help me refactor"

# 带 provider 前缀的模型（无需 --provider）
pi --model openai/gpt-4o "Help me refactor"

# 带 thinking 级别简写的模型
pi --model sonnet:high "Solve this complex problem"

# 限制模型循环切换范围
pi --models "claude-*,gpt-4o"

# 只读模式
pi --tools read,grep,find,ls -p "Review the code"

# 禁用某个 extension 或内置工具，其余保持可用
pi --exclude-tools ask_question

# 高 thinking 级别
pi --thinking high "Solve this complex problem"
```

### 环境变量

| 变量 | 描述 |
|----------|-------------|
| `PI_CODING_AGENT_DIR` | 覆盖配置目录（默认：`~/.pi/agent`） |
| `PI_CODING_AGENT_SESSION_DIR` | 覆盖会话存储目录（会被 `--session-dir` 覆盖） |
| `PI_PACKAGE_DIR` | 覆盖 package 目录（适用于 store 路径不便处理的 Nix/Guix） |
| `PI_OFFLINE` | 禁用启动时的网络操作，包括更新检查、package 更新检查和安装/更新遥测 |
| `PI_SKIP_VERSION_CHECK` | 跳过启动时的 Pi 版本更新检查。这会阻止对 `pi.dev` 的 latest-version 请求 |
| `PI_TELEMETRY` | 覆盖安装/更新遥测和 provider 归属 headers。用 `1`/`true`/`yes` 启用或 `0`/`false`/`no` 禁用。这不会禁用更新检查 |
| `PI_CACHE_RETENTION` | 设为 `long` 启用扩展的 prompt cache（Anthropic：1 小时，OpenAI：24 小时） |
| `VISUAL`、`EDITOR` | `externalEditor` 未设置时 Ctrl+G 的回退外部编辑器；Windows 上默认为 Notepad，其他平台为 `nano` |

---

## 贡献与开发

指南参见 [CONTRIBUTING.md](../../CONTRIBUTING.md)，设置、fork 和调试参见 [docs/development.md](docs/development.md)。

## License

MIT

## 另见

- [@earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai)：核心 LLM 工具包
- [@earendil-works/pi-agent-core](https://www.npmjs.com/package/@earendil-works/pi-agent-core)：Agent 框架
- [@earendil-works/pi-tui](https://www.npmjs.com/package/@earendil-works/pi-tui)：终端 UI 组件

<p align="center">
  <a href="https://pi.dev">pi.dev</a> 域名由以下机构慷慨捐赠
  <br /><br />
  <a href="https://exe.dev"><img src="docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>
