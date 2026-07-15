# @earendil-works/pi-agent-core

带工具执行和事件流的有状态 agent。基于 `@earendil-works/pi-ai` 构建。

## 安装

```bash
npm install @earendil-works/pi-agent-core
```

## 快速开始

```typescript
import { Agent } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";

const agent = new Agent({
  initialState: {
    systemPrompt: "You are a helpful assistant.",
    model: getModel("anthropic", "claude-sonnet-4-20250514"),
  },
});

agent.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    // 只流式输出新的文本块
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await agent.prompt("Hello!");
```

## 核心概念

### AgentMessage vs LLM Message

agent 使用 `AgentMessage`，这是一个灵活的类型，可以包含：
- 标准 LLM 消息（`user`、`assistant`、`toolResult`）
- 通过 declaration merging 扩展的应用特定的自定义消息类型

LLM 只理解 `user`、`assistant` 和 `toolResult`。`convertToLlm` 函数在每次 LLM 调用前通过过滤和转换消息来弥合这一差距。

### 消息流

```
AgentMessage[] → transformContext() → AgentMessage[] → convertToLlm() → Message[] → LLM
                    (可选)                              (必需)
```

1. **transformContext**：修剪旧消息、注入外部上下文
2. **convertToLlm**：过滤掉仅用于 UI 的消息，将自定义类型转换为 LLM 格式

## 事件流

agent 会为 UI 更新发出事件。理解事件序列有助于构建响应式界面。

### prompt() 事件序列

当你调用 `prompt("Hello")` 时：

```
prompt("Hello")
├─ agent_start
├─ turn_start
├─ message_start   { message: userMessage }      // 你的 prompt
├─ message_end     { message: userMessage }
├─ message_start   { message: assistantMessage } // LLM 开始响应
├─ message_update  { message: partial... }       // 流式片段
├─ message_update  { message: partial... }
├─ message_end     { message: assistantMessage } // 完整响应
├─ turn_end        { message, toolResults: [] }
└─ agent_end       { messages: [...] }
```

### 带工具调用时

如果 assistant 调用了工具，循环会继续：

```
prompt("Read config.json")
├─ agent_start
├─ turn_start
├─ message_start/end  { userMessage }
├─ message_start      { assistantMessage with toolCall }
├─ message_update...
├─ message_end        { assistantMessage }
├─ tool_execution_start  { toolCallId, toolName, args }
├─ tool_execution_update { partialResult }           // 如果工具支持流式
├─ tool_execution_end    { toolCallId, result }
├─ message_start/end  { toolResultMessage }
├─ turn_end           { message, toolResults: [toolResult] }
│
├─ turn_start                                        // 下一个 turn
├─ message_start      { assistantMessage }           // LLM 响应工具结果
├─ message_update...
├─ message_end
├─ turn_end
└─ agent_end
```

工具执行模式可配置：

- `parallel`（默认）：顺序 preflight 各工具调用，并发执行被允许的工具，每个工具一旦定稿就发出 `tool_execution_end`，然后按 assistant 源顺序发出 toolResult 消息和 `turn_end.toolResults`
- `sequential`：逐个执行工具调用，与历史行为一致

在 parallel 模式下，工具完成事件遵循工具完成顺序，但持久化的 toolResult 消息仍然遵循 assistant 源顺序。

该模式可以通过 agent 配置中的 `toolExecution` 全局设置，或通过 `AgentTool` 上的 `executionMode` 按工具设置。如果一批工具调用中有任何一个的目标工具是 `executionMode: "sequential"`，则整批工具无论全局设置如何都会顺序执行。

`beforeToolCall` hook 在 `tool_execution_start` 和已验证的参数解析之后运行，它可以阻止执行。`afterToolCall` hook 在工具执行结束后、`tool_execution_end` 和最终工具结果消息事件发出之前运行。

工具还可以返回 `terminate: true` 来提示应跳过自动的后续 LLM 调用。只有当该批次中每个定稿的工具结果都设置了 `terminate: true` 时，循环才会提前停止。混合批次会正常继续。

底层 loop 的调用者可以设置 `shouldStopAfterTurn`，在当前 turn 完成后优雅停止：

```typescript
const stream = agentLoop(prompts, context, {
  model,
  convertToLlm,
  shouldStopAfterTurn: async ({ message, toolResults, context, newMessages }) => {
    return shouldCompactBeforeNextTurn(context.messages);
  },
});
```

`shouldStopAfterTurn` 在 `turn_end` 发出之后、且 assistant 响应和所有工具执行正常完成之后运行。如果它返回 `true`，循环会发出 `agent_end` 并退出——在轮询 steering 或 follow-up 队列之前，也在启动下一次 LLM 调用之前。它不会中止 provider 流，不会取消正在运行的工具，也不会更改 assistant 消息的 stop reason。

当你使用 `Agent` 类时，assistant 的 `message_end` 处理被视为工具 preflight 开始前的屏障（barrier）。这意味着 `beforeToolCall` 看到的 agent 状态已经包含了发起该工具调用的 assistant 消息。

### continue() 事件序列

`continue()` 从现有上下文恢复而不添加新消息。用于出错后的重试。

```typescript
// 出错后，从当前状态重试
await agent.continue();
```

上下文中的最后一条消息必须是 `user` 或 `toolResult`（不能是 `assistant`）。

### 事件类型

| 事件 | 描述 |
|-------|-------------|
| `agent_start` | agent 开始处理 |
| `agent_end` | 本次运行的最后一个事件。被 await 的该事件订阅者仍计入 settlement |
| `turn_start` | 新的 turn 开始（一次 LLM 调用 + 工具执行） |
| `turn_end` | turn 完成，附带 assistant 消息和工具结果 |
| `message_start` | 任意消息开始（user、assistant、toolResult） |
| `message_update` | **仅 assistant。** 包含带 delta 的 `assistantMessageEvent` |
| `message_end` | 消息完成 |
| `tool_execution_start` | 工具开始 |
| `tool_execution_update` | 工具流式报告进度 |
| `tool_execution_end` | 工具完成 |

`Agent.subscribe()` 的监听器按注册顺序被 await。`agent_end` 意味着不会再发出更多 loop 事件，但 `await agent.waitForIdle()` 和 `await agent.prompt(...)` 只有在被 await 的 `agent_end` 监听器完成后才会 settle。

## Agent 选项

```typescript
const agent = new Agent({
  // 初始状态
  initialState: {
    systemPrompt: string,
    model: Model<any>,
    thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
    tools: AgentTool<any>[],
    messages: AgentMessage[],
  },

  // 将 AgentMessage[] 转换为 LLM Message[]（自定义消息类型时必需）
  convertToLlm: (messages) => messages.filter(...),

  // 在 convertToLlm 之前转换上下文（用于修剪、compaction）
  transformContext: async (messages, signal) => pruneOldMessages(messages),

  // Steering 模式："one-at-a-time"（默认）或 "all"
  steeringMode: "one-at-a-time",

  // Follow-up 模式："one-at-a-time"（默认）或 "all"
  followUpMode: "one-at-a-time",

  // 自定义 stream 函数（用于代理后端）
  streamFn: streamProxy,

  // 用于 provider 缓存的会话 ID
  sessionId: "session-123",

  // 动态 API key 解析（用于会过期的 OAuth token）
  getApiKey: async (provider) => refreshToken(),

  // 工具执行模式："parallel"（默认）或 "sequential"
  toolExecution: "parallel",

  // 在参数验证后对每个工具调用做 preflight，可阻止执行。
  beforeToolCall: async ({ toolCall, args, context }) => {
    if (toolCall.name === "bash") {
      return { block: true, reason: "bash is disabled" };
    }
  },

  // 在最终工具事件发出前对每个工具结果做后处理。
  afterToolCall: async ({ toolCall, result, isError, context }) => {
    if (toolCall.name === "notify_done" && !isError) {
      return { terminate: true };
    }
    if (!isError) {
      return { details: { ...result.details, audited: true } };
    }
  },

  // 针对基于 token 的 provider 的自定义 thinking 预算
  thinkingBudgets: {
    minimal: 128,
    low: 512,
    medium: 1024,
    high: 2048,
  },
});
```

## Agent 状态

```typescript
interface AgentState {
  systemPrompt: string;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool<any>[];
  messages: AgentMessage[];
  readonly isStreaming: boolean;
  readonly streamingMessage?: AgentMessage;
  readonly pendingToolCalls: ReadonlySet<string>;
  readonly errorMessage?: string;
}
```

通过 `agent.state` 访问状态。

给 `agent.state.tools = [...]` 或 `agent.state.messages = [...]` 赋值时，会先复制顶层数组再存储。修改返回的数组会修改当前 agent 状态。

流式期间，`agent.state.streamingMessage` 包含当前部分完成的 assistant 消息。

`agent.state.isStreaming` 在整个运行完全 settle 之前（包括被 await 的 `agent_end` 订阅者）都保持为 `true`。

## 方法

### Prompting

```typescript
// 文本 prompt
await agent.prompt("Hello");

// 带图片
await agent.prompt("What's in this image?", [
  { type: "image", data: base64Data, mimeType: "image/jpeg" }
]);

// 直接传 AgentMessage
await agent.prompt({ role: "user", content: "Hello", timestamp: Date.now() });

// 从当前上下文继续（最后一条消息必须是 user 或 toolResult）
await agent.continue();
```

### 状态管理

```typescript
agent.state.systemPrompt = "New prompt";
agent.state.model = getModel("openai", "gpt-4o");
agent.state.thinkingLevel = "medium";
agent.state.tools = [myTool];
agent.toolExecution = "sequential";
agent.beforeToolCall = async ({ toolCall }) => undefined;
agent.afterToolCall = async ({ toolCall, result }) => undefined;
agent.state.messages = newMessages; // 顶层数组会被复制
agent.state.messages.push(message);
agent.reset();
```

### 会话与 Thinking 预算

```typescript
agent.sessionId = "session-123";

agent.thinkingBudgets = {
  minimal: 128,
  low: 512,
  medium: 1024,
  high: 2048,
};
```

### 控制

```typescript
agent.abort();           // 取消当前操作
await agent.waitForIdle(); // 等待完成
```

### 事件

```typescript
const unsubscribe = agent.subscribe(async (event, signal) => {
  if (event.type === "agent_end") {
    // 本次运行的最终屏障工作
    await flushSessionState(signal);
  }
});
unsubscribe();
```

## Steering 与 Follow-up

Steering 消息让你可以在工具运行时打断 agent。Follow-up 消息让你可以在 agent 本应停止之后排队后续工作。

```typescript
agent.steeringMode = "one-at-a-time";
agent.followUpMode = "one-at-a-time";

// 当 agent 正在运行工具时
agent.steer({
  role: "user",
  content: "Stop! Do this instead.",
  timestamp: Date.now(),
});

// 在 agent 完成当前工作之后
agent.followUp({
  role: "user",
  content: "Also summarize the result.",
  timestamp: Date.now(),
});

const steeringMode = agent.steeringMode;
const followUpMode = agent.followUpMode;

agent.clearSteeringQueue();
agent.clearFollowUpQueue();
agent.clearAllQueues();
```

使用 clearSteeringQueue、clearFollowUpQueue 或 clearAllQueues 丢弃已排队的消息。

当在一个 turn 完成后检测到 steering 消息时：
1. 当前 assistant 消息的所有工具调用都已完成
2. steering 消息被注入
3. LLM 在下一个 turn 中响应

只有在没有更多工具调用且没有 steering 消息时才会检查 follow-up 消息。如果队列中有，就会注入它们并运行新的一个 turn。

## 自定义消息类型

通过 declaration merging 扩展 `AgentMessage`：

```typescript
declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    notification: { role: "notification"; text: string; timestamp: number };
  }
}

// 现在这是合法的
const msg: AgentMessage = { role: "notification", text: "Info", timestamp: Date.now() };
```

在 `convertToLlm` 中处理自定义类型：

```typescript
const agent = new Agent({
  convertToLlm: (messages) => messages.flatMap(m => {
    if (m.role === "notification") return []; // 过滤掉
    return [m];
  }),
});
```

## 工具

使用 `AgentTool` 定义工具：

```typescript
import { Type } from "typebox";

const readFileTool: AgentTool = {
  name: "read_file",
  label: "Read File",  // 用于 UI 显示
  description: "Read a file's contents",
  parameters: Type.Object({
    path: Type.String({ description: "File path" }),
  }),
  // 为该工具覆盖执行模式（可选）。
  // "sequential" 强制整批工具逐个运行。
  // "parallel" 允许与其他工具调用并发执行。
  // 省略时应用全局 toolExecution 配置。
  executionMode: "sequential",
  execute: async (toolCallId, params, signal, onUpdate) => {
    const content = await fs.readFile(params.path, "utf-8");

    // 可选：流式报告进度
    onUpdate?.({ content: [{ type: "text", text: "Reading..." }], details: {} });

    // 可选：在这里加上 `terminate: true`，当批次中每个定稿的工具结果
    // 都这样做时，将跳过自动的后续 LLM 调用。
    return {
      content: [{ type: "text", text: content }],
      details: { path: params.path, size: content.length },
    };
  },
};

agent.state.tools = [readFileTool];
```

### 错误处理

工具失败时**抛出错误**。不要把错误消息作为 content 返回。

```typescript
execute: async (toolCallId, params, signal, onUpdate) => {
  if (!fs.existsSync(params.path)) {
    throw new Error(`File not found: ${params.path}`);
  }
  // 仅在成功时返回 content
  return { content: [{ type: "text", text: "..." }] };
}
```

抛出的错误会被 agent 捕获，并以 `isError: true` 的工具错误形式报告给 LLM。

从 `execute()` 或 `afterToolCall` 返回 `terminate: true` 可以提示 agent 在当前工具批次后停止。只有当批次中每个定稿的工具结果都是 terminating 时才会生效。该提示仅在运行时有效；发出的 `toolResult` transcript 消息仍是标准的 LLM 工具结果。

## Proxy 用法

用于通过后端代理的浏览器应用：

```typescript
import { Agent, streamProxy } from "@earendil-works/pi-agent-core";

const agent = new Agent({
  streamFn: (model, context, options) =>
    streamProxy(model, context, {
      ...options,
      authToken: "...",
      proxyUrl: "https://your-server.com",
    }),
});
```

## 底层 API

不使用 Agent 类的直接控制方式：

```typescript
import { agentLoop, agentLoopContinue } from "@earendil-works/pi-agent-core";

const context: AgentContext = {
  systemPrompt: "You are helpful.",
  messages: [],
  tools: [],
};

const config: AgentLoopConfig = {
  model: getModel("openai", "gpt-4o"),
  convertToLlm: (msgs) => msgs.filter(m => ["user", "assistant", "toolResult"].includes(m.role)),
  toolExecution: "parallel",  // 若设置了工具级 executionMode 则被其覆盖
  beforeToolCall: async ({ toolCall, args, context }) => undefined,
  afterToolCall: async ({ toolCall, result, isError, context }) => undefined,
};

const userMessage = { role: "user", content: "Hello", timestamp: Date.now() };

for await (const event of agentLoop([userMessage], context, config)) {
  console.log(event.type);
}

// 从现有上下文继续
for await (const event of agentLoopContinue(context, config)) {
  console.log(event.type);
}
```

这些底层流是观察性的（observational）。它们保持事件顺序，但不会等待你的异步事件处理 settle 之后才让后续的生产者阶段继续。如果你需要消息处理在工具 preflight 之前充当屏障，请使用 `Agent` 类而不是裸的 `agentLoop()` 或 `agentLoopContinue()`。

## License

MIT
