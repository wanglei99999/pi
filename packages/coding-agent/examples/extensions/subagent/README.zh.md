# Subagent 示例

将任务委托给拥有隔离上下文窗口的专用 subagent。

## 特性

- **隔离上下文**：每个 subagent 运行在独立的 `pi` 进程中
- **流式输出**：实时看到工具调用和进度
- **并行流式**：所有并行任务同时流式更新
- **Markdown 渲染**：最终输出以正确的格式渲染（展开视图）
- **用量跟踪**：显示每个 agent 的 turn 数、token 数、费用和上下文用量
- **中止支持**：Ctrl+C 会传播并杀死 subagent 进程

## 结构

```
subagent/
├── README.md            # 本文件
├── index.ts             # extension（入口点）
├── agents.ts            # agent 发现逻辑
├── agents/              # 示例 agent 定义
│   ├── scout.md         # 快速侦察，返回压缩后的上下文
│   ├── planner.md       # 创建实现计划
│   ├── reviewer.md      # 代码审查
│   └── worker.md        # 通用（完整能力）
└── prompts/             # 工作流预设（prompt templates）
    ├── implement.md     # scout -> planner -> worker
    ├── scout-and-plan.md    # scout -> planner（不做实现）
    └── implement-and-review.md  # worker -> reviewer -> worker
```

## 安装

在仓库根目录，创建文件的符号链接：

```bash
# 链接 extension（必须放在带 index.ts 的子目录中）
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/index.ts" ~/.pi/agent/extensions/subagent/index.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/agents.ts" ~/.pi/agent/extensions/subagent/agents.ts

# 链接 agents
mkdir -p ~/.pi/agent/agents
for f in packages/coding-agent/examples/extensions/subagent/agents/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/agents/$(basename "$f")
done

# 链接工作流 prompts
mkdir -p ~/.pi/agent/prompts
for f in packages/coding-agent/examples/extensions/subagent/prompts/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/prompts/$(basename "$f")
done
```

## 安全模型

此工具会执行一个独立的 `pi` 子进程，带有委托的 system prompt 以及工具/模型配置。

**项目级 agents**（`.pi/agents/*.md`）是由仓库控制的 prompt，可以指示模型读取文件、运行 bash 命令等。

**默认行为：** 只加载 `~/.pi/agent/agents` 中的**用户级 agents**。

要启用项目级 agents，传入 `agentScope: "both"`（或 `"project"`）。仅对你信任的仓库这样做。

在交互式运行时，该工具会在运行项目级 agent 前提示确认。设置 `confirmProjectAgents: false` 可以禁用此确认。

## 用法

### 单个 agent
```
Use scout to find all authentication code
```

### 并行执行
```
Run 2 scouts in parallel: one to find models, one to find providers
```

### 链式工作流
```
Use a chain: first have scout find the read tool, then have planner suggest improvements
```

### 工作流 prompts
```
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## 工具模式

| 模式 | 参数 | 描述 |
|------|-----------|-------------|
| Single | `{ agent, task }` | 一个 agent，一个任务 |
| Parallel | `{ tasks: [...] }` | 多个 agent 并发运行（最多 8 个，4 个并发） |
| Chain | `{ chain: [...] }` | 顺序执行，支持 `{previous}` 占位符 |

## 输出展示

**折叠视图**（默认）：
- 状态图标（✓/✗/⏳）和 agent 名称
- 最后 5-10 条内容（工具调用和文本）
- 用量统计：`3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**展开视图**（Ctrl+O）：
- 完整的任务文本
- 所有工具调用及其格式化参数
- 最终输出以 Markdown 渲染
- 每个任务的用量（chain/parallel 模式）

**并行模式流式显示**：
- 显示所有任务的实时状态（⏳ 运行中、✓ 完成、✗ 失败）
- 随每个任务的进展实时更新
- 显示 "2/3 done, 1 running" 之类的状态
- 将每个已完成任务的最终输出返回给父模型，每个任务上限 50 KB
- 当子进程在产出结果前退出时，返回来自 stderr/错误消息的失败诊断信息

**工具调用格式化**（模仿内置工具）：
- bash 显示为 `$ command`
- read 显示为 `read ~/path:1-10`
- grep 显示为 `grep /pattern/ in ~/path`
- 等等

## Agent 定义

Agent 是带 YAML frontmatter 的 markdown 文件：

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: claude-haiku-4-5
---

System prompt for the agent goes here.
```

**位置：**
- `~/.pi/agent/agents/*.md` —— 用户级（总是加载）
- `.pi/agents/*.md` —— 项目级（仅在 `agentScope: "project"` 或 `"both"` 时加载）

当 `agentScope: "both"` 时，同名的项目级 agent 会覆盖用户级 agent。

## 示例 Agents

| Agent | 用途 | 模型 | 工具 |
|-------|---------|-------|-------|
| `scout` | 快速代码库侦察 | Haiku | read, grep, find, ls, bash |
| `planner` | 实现计划 | Sonnet | read, grep, find, ls |
| `reviewer` | 代码审查 | Sonnet | read, grep, find, ls, bash |
| `worker` | 通用 | Sonnet | （全部默认工具） |

## 工作流 Prompts

| Prompt | 流程 |
|--------|------|
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |

## 错误处理

- **退出码 != 0**：工具返回错误，附带 stderr/输出
- **stopReason "error"**：LLM 错误连同错误消息一起传播
- **stopReason "aborted"**：用户中止（Ctrl+C）杀死子进程并抛出错误
- **Chain 模式**：在第一个失败的步骤停止，并报告哪一步失败

## 限制

- 折叠视图中输出截断为最后 10 条（展开可查看全部）
- 并行模式下模型可见的输出每个任务上限 50 KB；完整结果保留在工具的 details 中
- 每次调用时重新发现 agents（允许在会话中途编辑）
- 并行模式限制为 8 个任务、4 个并发
