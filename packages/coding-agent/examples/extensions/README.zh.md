# Extension 示例

pi-coding-agent 的示例 extensions。

## 用法

```bash
# 使用 --extension 标志加载一个 extension
pi --extension examples/extensions/permission-gate.ts

# 或者复制到 extensions 目录以自动发现
cp permission-gate.ts ~/.pi/agent/extensions/
```

## 示例

### 生命周期与安全

| Extension | 描述 |
|-----------|-------------|
| `permission-gate.ts` | 在执行危险的 bash 命令（rm -rf、sudo 等）之前提示确认 |
| `project-trust.ts` | 演示面向用户级/全局及 CLI extension 的 `project_trust` 事件 |
| `protected-paths.ts` | 阻止对受保护路径（.env、.git/、node_modules/）的写入 |
| `confirm-destructive.ts` | 在破坏性的会话操作（clear、switch、fork）之前进行确认 |
| `dirty-repo-guard.ts` | 存在未提交的 git 变更时阻止会话切换 |
| `sandbox/` | 使用 `@anthropic-ai/sandbox-runtime` 的操作系统级沙箱，支持按项目配置 |
| `gondolin/` | 将内置工具和 `!` 命令路由到 Gondolin micro-VM 中执行 |

### 自定义工具

| Extension | 描述 |
|-----------|-------------|
| `todo.ts` | Todo 列表工具 + `/todos` 命令，带自定义渲染和状态持久化 |
| `hello.ts` | 最小化的自定义工具示例 |
| `question.ts` | 演示 `ctx.ui.select()`，以自定义 UI 向用户提问 |
| `questionnaire.ts` | 多问题输入，通过 tab 栏在问题之间导航 |
| `tool-override.ts` | 覆盖内置工具（例如为 `read` 添加日志/访问控制） |
| `dynamic-tools.ts` | 在启动后（`session_start`）以及运行时通过命令注册工具，支持 prompt 片段和工具特定的 prompt 指引 |
| `structured-output.ts` | 最终结构化输出工具，返回 `terminate: true` 使 agent 可以在该工具调用上结束 |
| `built-in-tool-renderer.ts` | 为内置工具（read、bash、edit、write）提供自定义紧凑渲染，同时保持原有行为 |
| `minimal-mode.ts` | 覆盖内置工具渲染以实现极简显示（折叠模式下只显示工具调用，不显示输出） |
| `truncated-tool.ts` | 包装 ripgrep 并进行恰当的输出截断（50KB/2000 行） |
| `ssh.ts` | 通过 SSH 将所有工具委托到远程机器执行，使用可插拔的 operations |
| `subagent/` | 将任务委托给拥有隔离上下文窗口的专用 subagent |

### 命令与 UI

| Extension | 描述 |
|-----------|-------------|
| `preset.ts` | 通过 `--preset` 标志和 `/preset` 命令为模型、thinking 级别、工具和指令设置命名预设 |
| `plan-mode/` | Claude Code 风格的 plan mode，用于只读探索，带 `/plan` 命令和步骤跟踪 |
| `tools.ts` | 交互式 `/tools` 命令，用于启用/禁用工具，支持会话持久化 |
| `handoff.ts` | 通过 `/handoff <goal>` 将上下文转移到一个新的聚焦会话 |
| `qna.ts` | 通过 `ctx.ui.setEditorText()` 将上一条回复中的问题提取到编辑器中 |
| `status-line.ts` | 通过 `ctx.ui.setStatus()` 在 footer 中显示 turn 进度，带主题化配色 |
| `github-issue-autocomplete.ts` | 通过叠加一个自定义 autocomplete provider 添加 `#1234` issue 补全，预先从 `gh issue list` 加载开放的 issue |
| `widget-placement.ts` | 通过 `ctx.ui.setWidget()` 的 placement 在编辑器上方和下方显示 widget |
| `hidden-thinking-label.ts` | 通过 `ctx.ui.setHiddenThinkingLabel()` 自定义折叠的 thinking 标签 |
| `working-indicator.ts` | 通过 `ctx.ui.setWorkingIndicator()` 自定义流式输出时的工作指示器 |
| `model-status.ts` | 通过 `model_select` hook 在状态栏中显示模型变更 |
| `snake.ts` | 贪吃蛇游戏，带自定义 UI、键盘处理和会话持久化 |
| `tic-tac-toe.ts` | 与 agent 对战井字棋，使用 `executionMode: "sequential"` 工具避免共享光标状态上的竞态条件 |
| `send-user-message.ts` | 演示 `pi.sendUserMessage()`，从 extension 发送用户消息 |
| `timed-confirm.ts` | 演示用 AbortSignal 自动关闭 `ctx.ui.confirm()` 和 `ctx.ui.select()` 对话框 |
| `rpc-demo.ts` | 演练所有 RPC 支持的 extension UI 方法；与 [`examples/rpc-extension-ui.ts`](../rpc-extension-ui.ts) 配套使用 |
| `modal-editor.ts` | 通过 `ctx.ui.setEditorComponent()` 实现类 vim 的模态编辑器 |
| `rainbow-editor.ts` | 通过自定义编辑器实现动画彩虹文字效果 |
| `notify.ts` | agent 完成时通过 OSC 777 发送桌面通知（Ghostty、iTerm2、WezTerm） |
| `titlebar-spinner.ts` | agent 工作时在终端标题栏显示盲文 spinner 动画 |
| `summarize.ts` | 用 GPT-5.2 总结对话并在临时 UI 中展示 |
| `custom-footer.ts` | 通过 `ctx.ui.setFooter()` 实现带 git 分支和 token 统计的自定义 footer |
| `custom-header.ts` | 通过 `ctx.ui.setHeader()` 实现自定义 header |
| `overlay-test.ts` | 测试 overlay 合成，包含内联文本输入和边界情况 |
| `overlay-qa-tests.ts` | 全面的 overlay QA 测试：anchor、margin、堆叠、溢出、动画 |
| `doom-overlay/` | 以 overlay 形式运行的 DOOM 游戏，35 FPS（演示实时游戏渲染） |
| `shutdown-command.ts` | 添加 `/quit` 命令，演示 `ctx.shutdown()` |
| `reload-runtime.ts` | 添加 `/reload-runtime` 命令和 `reload_runtime` 工具，展示安全的 reload 流程 |
| `interactive-shell.ts` | 通过 `user_bash` hook 以完整终端运行交互式命令（vim、htop） |
| `inline-bash.ts` | 通过 `input` 事件转换展开 prompt 中的 `!{command}` 模式 |
| `input-transform-streaming.ts` | 通过 `streamingBehavior` 为流式中途的引导（steering）跳过昂贵的输入预处理 |

### Git 集成

| Extension | 描述 |
|-----------|-------------|
| `git-checkpoint.ts` | 每个 turn 创建 git stash checkpoint，以便 fork 时恢复代码 |
| `auto-commit-on-exit.ts` | 退出时自动提交，使用最后一条 assistant 消息作为提交信息 |

### System Prompt 与 Compaction

| Extension | 描述 |
|-----------|-------------|
| `pirate.ts` | 演示用 `systemPromptAppend` 动态修改 system prompt |
| `claude-rules.ts` | 扫描 `.claude/rules/` 文件夹并在 system prompt 中列出规则 |
| `custom-compaction.ts` | 总结整个对话的自定义 compaction |
| `trigger-compact.ts` | 上下文用量超过 100k token 时触发 compaction，并添加 `/trigger-compact` 命令 |

### 系统集成

| Extension | 描述 |
|-----------|-------------|
| `mac-system-theme.ts` | 将 pi 主题与 macOS 深色/浅色模式同步 |

### 资源

| Extension | 描述 |
|-----------|-------------|
| `dynamic-resources/` | 使用 `resources_discover` 加载 skills、prompts 和 themes |

### 消息与通信

| Extension | 描述 |
|-----------|-------------|
| `message-renderer.ts` | 通过 `registerMessageRenderer` 实现带颜色和可展开细节的自定义消息渲染 |
| `entry-renderer.ts` | 通过 `appendEntry` 和 `registerEntryRenderer` 实现仅 TUI 的会话条目渲染 |
| `event-bus.ts` | 通过 `pi.events` 实现 extension 之间的通信 |

### 会话元数据

| Extension | 描述 |
|-----------|-------------|
| `session-name.ts` | 通过 `setSessionName` 为会话命名，用于会话选择器 |
| `bookmark.ts` | 通过 `setLabel` 为条目添加带标签的书签，用于 `/tree` 导航 |

### 自定义 Provider

| Extension | 描述 |
|-----------|-------------|
| `custom-provider-anthropic/` | 支持 OAuth 和自定义 streaming 实现的自定义 Anthropic provider |
| `custom-provider-gitlab-duo/` | 通过代理使用 pi-ai 内置 Anthropic/OpenAI streaming 的 GitLab Duo provider |

### 外部依赖

| Extension | 描述 |
|-----------|-------------|
| `with-deps/` | 带有自己的 package.json 和依赖的 extension（演示 jiti 模块解析） |
| `file-trigger.ts` | 监听一个触发文件并将其内容注入到对话中 |

## 编写 Extensions

完整文档参见 [docs/extensions.md](../../docs/extensions.md)。

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  // 订阅生命周期事件
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
      const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
      if (!ok) return { block: true, reason: "Blocked by user" };
    }
  });

  // 注册自定义工具
  pi.registerTool({
    name: "greet",
    label: "Greeting",
    description: "Generate a greeting",
    parameters: Type.Object({
      name: Type.String({ description: "Name to greet" }),
    }),
    async execute(toolCallId, params, onUpdate, ctx, signal) {
      return {
        content: [{ type: "text", text: `Hello, ${params.name}!` }],
        details: {},
      };
    },
  });

  // 注册命令
  pi.registerCommand("hello", {
    description: "Say hello",
    handler: async (args, ctx) => {
      ctx.ui.notify("Hello!", "info");
    },
  });
}
```

## 关键模式

**字符串参数使用 StringEnum**（Google API 兼容性所必需）：
```typescript
import { StringEnum } from "@earendil-works/pi-ai";

// 好
action: StringEnum(["list", "add"] as const)

// 坏 —— 在 Google 上不工作
action: Type.Union([Type.Literal("list"), Type.Literal("add")])
```

**通过 details 实现状态持久化：**
```typescript
// 将状态存储在工具结果的 details 中，以正确支持 fork
return {
  content: [{ type: "text", text: "Done" }],
  details: { todos: [...todos], nextId },  // 持久化到会话中
};

// 在会话事件中重建状态
pi.on("session_start", async (_event, ctx) => {
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.toolName === "my_tool") {
      const details = entry.message.details;
      // 从 details 重建状态
    }
  }
});
```
