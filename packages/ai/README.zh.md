# @earendil-works/pi-ai

统一的 LLM API，包含 provider 集合、自动认证解析、token 与费用跟踪，以及简单的上下文持久化和会话中途向其他模型的交接（hand-off）。

**注意**：本库只收录支持 tool calling（function calling）的模型，因为这对 agentic 工作流至关重要。

## 目录

- [支持的 Providers](#支持的-providers)
- [安装](#安装)
- [快速开始](#快速开始)
- [Providers 与模型](#providers-与模型)
  - [Provider 工厂](#provider-工厂)
  - [所有内置 Providers](#所有内置-providers)
  - [查询模型](#查询模型)
  - [静态目录读取](#静态目录读取)
  - [动态 Providers](#动态-providers)
- [认证](#认证)
  - [认证如何解析](#认证如何解析)
  - [Credential Store](#credential-store)
  - [环境变量](#环境变量)
- [工具](#工具)
  - [定义工具](#定义工具)
  - [处理工具调用](#处理工具调用)
  - [用部分 JSON 流式处理工具调用](#用部分-json-流式处理工具调用)
  - [验证工具参数](#验证工具参数)
  - [完整事件参考](#完整事件参考)
- [图片输入](#图片输入)
- [图片生成](#图片生成)
- [Thinking/Reasoning](#thinkingreasoning)
  - [统一接口](#统一接口streamsimplecompletesimple)
  - [Provider 特定选项](#provider-特定选项streamcomplete)
  - [流式 Thinking 内容](#流式-thinking-内容)
- [Stop Reasons](#stop-reasons)
- [错误处理](#错误处理)
  - [中止请求](#中止请求)
  - [中止后继续](#中止后继续)
  - [调试 Provider Payload](#调试-provider-payload)
- [自定义 Providers](#自定义-providers)
  - [createProvider()](#createprovider)
  - [直接调用 API 实现](#直接调用-api-实现)
  - [OpenAI 兼容性设置](#openai-兼容性设置)
- [用于测试的 Faux Provider](#用于测试的-faux-provider)
- [跨 Provider 交接](#跨-provider-交接)
- [上下文序列化](#上下文序列化)
- [浏览器使用](#浏览器使用)
- [打包与 Tree Shaking](#打包与-tree-shaking)
- [OAuth Providers](#oauth-providers)
  - [Vertex AI](#vertex-ai)
  - [CLI 登录](#cli-登录)
  - [编程式 OAuth](#编程式-oauth)
- [从旧的全局 API 迁移](#从旧的全局-api-迁移)
- [开发](#开发)
- [License](#license)

## 支持的 Providers

- **OpenAI**
- **Ant Ling**
- **Azure OpenAI (Responses)**
- **OpenAI Codex**（ChatGPT Plus/Pro 订阅，需要 OAuth，见下文）
- **DeepSeek**
- **NVIDIA NIM**
- **Anthropic**
- **Google**
- **Vertex AI**（通过 Vertex AI 使用 Gemini）
- **Mistral**
- **Groq**
- **Cerebras**
- **Cloudflare AI Gateway**
- **Cloudflare Workers AI**
- **xAI**
- **OpenRouter**
- **Vercel AI Gateway**
- **ZAI Coding Plan (Global)**（另有独立的中国区 provider）
- **MiniMax**（另有独立的中国区 provider）
- **Together AI**
- **Hugging Face**
- **Moonshot AI**（另有独立的中国区 provider）
- **GitHub Copilot**（需要 OAuth，见下文）
- **Amazon Bedrock**
- **OpenCode Zen**
- **OpenCode Go**
- **Fireworks**（使用 OpenAI 和 Anthropic 兼容 API）
- **Kimi For Coding**（Moonshot AI 订阅端点，使用 Anthropic 兼容 API）
- **Xiaomi MiMo**（默认使用 API 计费端点，另有 `cn`/`ams`/`sgp` 区域的 Token Plan provider）
- **任何 OpenAI 兼容 API**：Ollama、vLLM、LM Studio 等

## 安装

```bash
npm install @earendil-works/pi-ai
```

TypeBox 的导出从 `@earendil-works/pi-ai` 重新导出：`Type`、`Static` 和 `TSchema`。

## 快速开始

你构建一个由 provider 组成的 `Models` 集合，并通过它进行流式请求。最快的方式是注册所有内置 provider；关心 bundle 大小的应用应改为注册单个 provider（参见 [Provider 工厂](#provider-工厂)和[打包与 Tree Shaking](#打包与-tree-shaking)）。

```typescript
import { Type, type Context, type Tool } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

// 一个注册了所有内置 provider 的 Models 集合
const models = builtinModels();

// 对集合进行同步查找
const model = models.getModel('openai', 'gpt-4o-mini')!;

// 用 TypeBox schema 定义工具，获得类型安全和验证
const tools: Tool[] = [{
  name: 'get_time',
  description: 'Get the current time',
  parameters: Type.Object({
    timezone: Type.Optional(Type.String({ description: 'Optional timezone (e.g., America/New_York)' }))
  })
}];

// 构建对话上下文（易于序列化，可在模型之间转移）
const context: Context = {
  systemPrompt: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: 'What time is it?', timestamp: Date.now() }],
  tools
};

// 方式 1：带所有事件类型的流式请求。
// 认证通过 provider 解析（这里是环境变量中的 OPENAI_API_KEY）。
const s = models.stream(model, context);

for await (const event of s) {
  switch (event.type) {
    case 'start':
      console.log(`Starting with ${event.partial.model}`);
      break;
    case 'text_start':
      console.log('\n[Text started]');
      break;
    case 'text_delta':
      process.stdout.write(event.delta);
      break;
    case 'text_end':
      console.log('\n[Text ended]');
      break;
    case 'thinking_start':
      console.log('[Model is thinking...]');
      break;
    case 'thinking_delta':
      process.stdout.write(event.delta);
      break;
    case 'thinking_end':
      console.log('[Thinking complete]');
      break;
    case 'toolcall_start':
      console.log(`\n[Tool call started: index ${event.contentIndex}]`);
      break;
    case 'toolcall_delta':
      // 工具的部分参数正在流式传输
      const partialCall = event.partial.content[event.contentIndex];
      if (partialCall.type === 'toolCall') {
        console.log(`[Streaming args for ${partialCall.name}]`);
      }
      break;
    case 'toolcall_end':
      console.log(`\nTool called: ${event.toolCall.name}`);
      console.log(`Arguments: ${JSON.stringify(event.toolCall.arguments)}`);
      break;
    case 'done':
      console.log(`\nFinished: ${event.reason}`);
      break;
    case 'error':
      console.error(`Error: ${event.error.errorMessage}`);
      break;
  }
}

// 流式结束后获取最终消息，并加入上下文
const finalMessage = await s.result();
context.messages.push(finalMessage);

// 处理工具调用（如果有）
const toolCalls = finalMessage.content.filter(b => b.type === 'toolCall');
for (const call of toolCalls) {
  const result = call.name === 'get_time'
    ? new Date().toLocaleString('en-US', {
        timeZone: call.arguments.timezone || 'UTC',
        dateStyle: 'full',
        timeStyle: 'long'
      })
    : 'Unknown tool';

  // 将工具结果添加到上下文（支持文本和图片）
  context.messages.push({
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text: result }],
    isError: false,
    timestamp: Date.now()
  });
}

// 如果有工具调用则继续
if (toolCalls.length > 0) {
  const continuation = await models.complete(model, context);
  context.messages.push(continuation);
  console.log('After tool execution:', continuation.content);
}

console.log(`Total tokens: ${finalMessage.usage.input} in, ${finalMessage.usage.output} out`);
console.log(`Cost: $${finalMessage.usage.cost.total.toFixed(4)}`);

// 方式 2：不流式，直接获取完整响应
const response = await models.complete(model, context);

for (const block of response.content) {
  if (block.type === 'text') {
    console.log(block.text);
  } else if (block.type === 'toolCall') {
    console.log(`Tool: ${block.name}(${JSON.stringify(block.arguments)})`);
  }
}
```

本 README 其余部分的代码片段都假定已按上述方式设置好 `models` 集合（并注册了相关的 provider）。

## Providers 与模型

**Provider** 是运行时单元：它拥有自己的模型目录、认证（API key 解析、OAuth 流程）和 stream 行为。`Models` 集合持有各 provider，并把每个请求路由到拥有该模型的 provider。

Provider 内部共享 **API 实现**（即传输协议）：Anthropic 模型使用 `anthropic-messages`，OpenAI 使用 `openai-responses`，而 xAI、Groq、Cerebras、OpenRouter 和大多数其他 provider 共享 `openai-completions`。混合 API 的 provider（GitHub Copilot、OpenCode Zen）按模型分发。

### Provider 工厂

对于只需要特定 provider 的应用，每个内置 provider 都有一个工厂函数，它们是子路径导入，只拉取该 provider 的目录：

```typescript
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { amazonBedrockProvider } from '@earendil-works/pi-ai/providers/amazon-bedrock';
// ……支持的 provider 列表里每个 provider 都有一个模块

const models = createModels();
models.setProvider(anthropicProvider());
models.setProvider(openrouterProvider());
```

Provider 工厂会导入它的模型目录和一个惰性 API 包装器。它们不导入其他 provider。启用 bundler 的代码分割后，SDK 实现（`@anthropic-ai/sdk`、`openai`、`@google/genai` 等）会留在惰性 chunk 中，在第一次向该 API 的模型发起请求时才加载。

### 所有内置 Providers

对于想要全部的应用（如快速开始所示）：

```typescript
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

const models = builtinModels(); // 注册了所有内置 provider 的 Models 集合
```

这会导入所有目录和每个内置 provider 工厂。这是重量级、显式的入口点。`builtinModels()` 接受与 `createModels()` 相同的选项（`credentials`、`authContext`）；如果你想把它们注册到自己的集合上，`builtinProviders()` 返回 provider 数组。

### 查询模型

读取是同步的，返回最后已知的列表：

```typescript
const providers = models.getProviders();           // 已注册的 Provider 对象
const provider = models.getProvider('anthropic');  // 单个 provider

const all = models.getModels();                    // 所有 provider 的全部模型
const anthropicModels = models.getModels('anthropic');
const model = models.getModel('anthropic', 'claude-sonnet-4-5');

for (const m of anthropicModels) {
  console.log(`${m.id}: ${m.name}`);
  console.log(`  API: ${m.api}`);
  console.log(`  Context: ${m.contextWindow} tokens`);
  console.log(`  Vision: ${m.input.includes('image')}`);
  console.log(`  Reasoning: ${m.reasoning}`);
}
```

动态列出的模型的类型是 `Model<Api>`。需要 API 特定的选项类型时，用 `hasApi()` guard 收窄：

```typescript
import { hasApi } from '@earendil-works/pi-ai';

const m = models.getModel('anthropic', 'claude-sonnet-4-5');
if (m && hasApi(m, 'anthropic-messages')) {
  // m: Model<'anthropic-messages'> —— stream 选项类型完整
  models.stream(m, context, { thinkingEnabled: true, thinkingBudgetTokens: 2048 });
}
```

### 静态目录读取

对于希望使用生成的内置目录并获得完整字面量类型（provider 和模型 ID 自动补全）、且不依赖任何集合的工具类代码：

```typescript
import { getBuiltinModel, getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';

const model = getBuiltinModel('openai', 'gpt-4o-mini'); // 类型为 Model<'openai-responses'>
const providers = getBuiltinProviders();
const anthropic = getBuiltinModels('anthropic');
```

### 动态 Providers

Provider 可以有动态模型列表（llama.cpp 服务器、实时的 OpenRouter 列表）。读取保持同步；获取是一个显式的异步动作：

```typescript
// getModels() 返回最后已知的列表（首次 refresh 之前为空）
await models.refresh('llamacpp');        // 获取单个 provider 的列表；失败时 reject
await models.refresh();                  // 并发刷新所有 provider，尽力而为
const fresh = models.getModel('llamacpp', 'qwen3-30b');
```

静态内置 provider 的 `refresh()` 是 no-op。构建动态 provider 参见 [createProvider()](#createprovider)。

## 认证

每个 provider 拥有自己的认证：API key 如何解析（存储的凭据、环境变量、AWS profile 或 gcloud ADC 等环境来源），以及在支持的情况下的 OAuth 登录/刷新流程。

### 认证如何解析

当你调用 `models.stream()` 时，集合会通过拥有该模型的 provider 解析认证，并合并到请求中。显式的按请求值总是优先：

```typescript
// 通过 provider 解析（环境变量、存储的凭据、OAuth token）：
await models.complete(model, context);

// 显式的 key 优先于 provider 能解析出的任何值：
await models.complete(model, context, { apiKey: 'sk-explicit' });
```

你可以在不发请求的情况下检查解析结果——对状态 UI 很有用：

```typescript
const auth = await models.getAuth(model);
if (auth) {
  console.log(`configured via ${auth.source}`); // 例如 "ANTHROPIC_API_KEY"、"OAuth"、"stored credential"
} else {
  console.log('not configured');
}
```

对未配置的 provider，`getAuth()` 解析为 `undefined`；当真正出问题时会以 `ModelsError` reject（`"oauth"`：token 刷新失败，凭据保留以便重新登录；`"auth"`：key 解析或 credential store 失败）。请求路径会以 stream 错误的形式呈现同样的失败。

### Credential Store

存储的凭据（交互式输入的 API key、OAuth token）保存在 `CredentialStore` 中——每个 provider 一条带类型标签的凭据。pi-ai 自带一个内存版默认实现；应用可以注入持久化存储：

```typescript
import { createModels, type CredentialStore } from '@earendil-works/pi-ai';

const models = createModels({ credentials: myFileBackedStore });
// builtinModels() 接受相同的选项：
// const models = builtinModels({ credentials: myFileBackedStore });
```

契约很小：`read(providerId)`、`modify(providerId, fn)`（唯一的写路径——串行化的 read-modify-write）和 `delete(providerId)`。OAuth token 刷新在 `modify` 内部运行，因此并发请求和进程不可能对一个已轮换的 token 重复刷新。存储的凭据*拥有*它的 provider：只有在没有存储任何凭据时才会查询环境变量，且刷新失败绝不会静默回退到环境变量中的 key。

API-key 凭据与 pi 的 `auth.json` 使用相同的 discriminator，并可以携带 provider 作用域的 env/config 值：

```typescript
const credential = {
  type: 'api_key',
  key: '...',
  env: {
    CLOUDFLARE_ACCOUNT_ID: 'account-id',
    CLOUDFLARE_GATEWAY_ID: 'gateway-id'
  }
} as const;
```

### 环境变量

内置 provider 解析以下环境变量（Node.js；浏览器中请显式传 `apiKey`）：

| Provider | 环境变量 |
|----------|------------------------|
| OpenAI | `OPENAI_API_KEY` |
| Ant Ling | `ANT_LING_API_KEY` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_BASE_URL`（例如 `https://{resource}.ai.azure.com`）或 `AZURE_OPENAI_RESOURCE_NAME`。支持 `*.openai.azure.com`、`*.cognitiveservices.azure.com` 和 `*.ai.azure.com`；根端点会自动规范化为 `/openai/v1`。可选：`AZURE_OPENAI_API_VERSION`（默认 `v1`）、`AZURE_OPENAI_DEPLOYMENT_NAME_MAP`。 |
| Anthropic | `ANTHROPIC_API_KEY` 或 `ANTHROPIC_OAUTH_TOKEN` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| NVIDIA NIM | `NVIDIA_API_KEY` |
| Google | `GEMINI_API_KEY` |
| Vertex AI | `GOOGLE_CLOUD_API_KEY` 或 `GOOGLE_CLOUD_PROJECT`（或 `GCLOUD_PROJECT`）+ `GOOGLE_CLOUD_LOCATION` + ADC |
| Mistral | `MISTRAL_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Cerebras | `CEREBRAS_API_KEY` |
| Cloudflare AI Gateway | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_GATEWAY_ID` |
| Cloudflare Workers AI | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` |
| xAI | `XAI_API_KEY` |
| Fireworks | `FIREWORKS_API_KEY` |
| Together AI | `TOGETHER_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` |
| ZAI Coding Plan (Global) | `ZAI_API_KEY` |
| ZAI Coding Plan (China) | `ZAI_CODING_CN_API_KEY` |
| MiniMax (Global) | `MINIMAX_API_KEY` |
| MiniMax (China) | `MINIMAX_CN_API_KEY` |
| Moonshot AI / Moonshot AI (China) | `MOONSHOT_API_KEY` |
| Hugging Face | `HF_TOKEN` |
| OpenCode Zen / OpenCode Go | `OPENCODE_API_KEY` |
| Kimi For Coding | `KIMI_API_KEY` |
| Xiaomi MiMo (API billing) | `XIAOMI_API_KEY` |
| Xiaomi MiMo Token Plan (China) | `XIAOMI_TOKEN_PLAN_CN_API_KEY` |
| Xiaomi MiMo Token Plan (Amsterdam) | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` |
| Xiaomi MiMo Token Plan (Singapore) | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` |

Amazon Bedrock 解析环境中的 AWS 凭据（`AWS_PROFILE`、access key 对、`AWS_BEARER_TOKEN_BEDROCK`、ECS 任务角色、web identity token）。Vertex AI 解析显式 key，或 gcloud Application Default Credentials 加上 project/location。

## 工具

工具使 LLM 能够与外部系统交互。本库使用 TypeBox schema 定义类型安全的工具，并利用 TypeBox 内置的 validator 和值转换工具进行自动验证。TypeBox schema 可以作为普通 JSON 序列化和反序列化，非常适合分布式系统。

### 定义工具

```typescript
import { Type, type Tool, StringEnum } from '@earendil-works/pi-ai';

// 用 TypeBox 定义工具参数
const weatherTool: Tool = {
  name: 'get_weather',
  description: 'Get current weather for a location',
  parameters: Type.Object({
    location: Type.String({ description: 'City name or coordinates' }),
    units: StringEnum(['celsius', 'fahrenheit'], { default: 'celsius' })
  })
};

// 注意：为兼容 Google API，请使用 StringEnum 辅助函数而不是 Type.Enum
// Type.Enum 生成的 anyOf/const 模式 Google 不支持

const bookMeetingTool: Tool = {
  name: 'book_meeting',
  description: 'Schedule a meeting',
  parameters: Type.Object({
    title: Type.String({ minLength: 1 }),
    startTime: Type.String({ format: 'date-time' }),
    endTime: Type.String({ format: 'date-time' }),
    attendees: Type.Array(Type.String({ format: 'email' }), { minItems: 1 })
  })
};
```

### 处理工具调用

工具结果使用 content block，可以同时包含文本和图片：

```typescript
import { readFileSync } from 'fs';

const context: Context = {
  messages: [{ role: 'user', content: 'What is the weather in London?', timestamp: Date.now() }],
  tools: [weatherTool]
};

const response = await models.complete(model, context);

// 检查响应中的工具调用
for (const block of response.content) {
  if (block.type === 'toolCall') {
    // 用参数执行你的工具
    // 验证参见"验证工具参数"一节
    const result = await executeWeatherApi(block.arguments);

    // 添加带文本内容的工具结果
    context.messages.push({
      role: 'toolResult',
      toolCallId: block.id,
      toolName: block.name,
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: false,
      timestamp: Date.now()
    });
  }
}

// 工具结果也可以包含图片（用于支持 vision 的模型）
const imageBuffer = readFileSync('chart.png');
context.messages.push({
  role: 'toolResult',
  toolCallId: 'tool_xyz',
  toolName: 'generate_chart',
  content: [
    { type: 'text', text: 'Generated chart showing temperature trends' },
    { type: 'image', data: imageBuffer.toString('base64'), mimeType: 'image/png' }
  ],
  isError: false,
  timestamp: Date.now()
});
```

### 用部分 JSON 流式处理工具调用

流式期间，工具调用参数会随到达逐步解析。这使得在完整参数可用之前就能进行实时 UI 更新：

```typescript
const s = models.stream(model, context);

for await (const event of s) {
  if (event.type === 'toolcall_delta') {
    const toolCall = event.partial.content[event.contentIndex];

    // 流式期间 toolCall.arguments 包含部分解析的 JSON
    // 这允许渐进式 UI 更新
    if (toolCall.type === 'toolCall' && toolCall.arguments) {
      // 保持防御性：arguments 可能不完整
      // 示例：在内容完成之前就显示正在写入的文件路径
      if (toolCall.name === 'write_file' && toolCall.arguments.path) {
        console.log(`Writing to: ${toolCall.arguments.path}`);

        // content 可能是部分的或缺失的
        if (toolCall.arguments.content) {
          console.log(`Content preview: ${toolCall.arguments.content.substring(0, 100)}...`);
        }
      }
    }
  }

  if (event.type === 'toolcall_end') {
    // 此时 toolCall.arguments 是完整的（但尚未验证）
    const toolCall = event.toolCall;
    console.log(`Tool completed: ${toolCall.name}`, toolCall.arguments);
  }
}
```

**关于部分工具参数的重要说明：**
- 在 `toolcall_delta` 事件期间，`arguments` 包含对部分 JSON 的尽力解析结果
- 字段可能缺失或不完整——使用前务必检查存在性
- 字符串值可能在词中间被截断
- 数组可能不完整
- 嵌套对象可能只填充了一部分
- `arguments` 最少也会是一个空对象 `{}`，绝不会是 `undefined`
- Google provider 不支持 function call 流式传输。你会收到单个带完整参数的 `toolcall_delta` 事件。

### 验证工具参数

实现自己的工具执行循环时，使用 `validateToolCall` 在把参数传给工具之前进行验证：

```typescript
import { validateToolCall, type Tool } from '@earendil-works/pi-ai';

const tools: Tool[] = [weatherTool, calculatorTool];
const s = models.stream(model, { messages, tools });

for await (const event of s) {
  if (event.type === 'toolcall_end') {
    const toolCall = event.toolCall;

    try {
      // 针对工具的 schema 验证参数（参数无效时抛出）
      const validatedArgs = validateToolCall(tools, toolCall);
      const result = await executeMyTool(toolCall.name, validatedArgs);
      // ……将工具结果添加到上下文
    } catch (error) {
      // 验证失败 —— 将错误作为工具结果返回，让模型可以重试
      context.messages.push({
        role: 'toolResult',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: 'text', text: error.message }],
        isError: true,
        timestamp: Date.now()
      });
    }
  }
}
```

### 完整事件参考

生成 assistant 消息期间发出的所有流式事件：

| 事件类型 | 描述 | 关键属性 |
|------------|-------------|----------------|
| `start` | 流开始 | `partial`：初始 assistant 消息结构 |
| `text_start` | 文本块开始 | `contentIndex`：在 content 数组中的位置 |
| `text_delta` | 收到文本片段 | `delta`：新文本，`contentIndex`：位置 |
| `text_end` | 文本块完成 | `content`：完整文本，`contentIndex`：位置 |
| `thinking_start` | Thinking 块开始 | `contentIndex`：在 content 数组中的位置 |
| `thinking_delta` | 收到 thinking 片段 | `delta`：新文本，`contentIndex`：位置 |
| `thinking_end` | Thinking 块完成 | `content`：完整 thinking，`contentIndex`：位置 |
| `toolcall_start` | 工具调用开始 | `contentIndex`：在 content 数组中的位置 |
| `toolcall_delta` | 工具参数流式传输中 | `delta`：JSON 片段，`partial.content[contentIndex].arguments`：部分解析的参数 |
| `toolcall_end` | 工具调用完成 | `toolCall`：完整的工具调用，含 `id`、`name`、`arguments` |
| `done` | 流完成 | `reason`：stop reason（"stop"、"length"、"toolUse"），`message`：最终的 assistant 消息 |
| `error` | 发生错误 | `reason`：错误类型（"error" 或 "aborted"），`error`：带部分内容的 AssistantMessage |

不保证不同 content block 的流式事件是连续的。Provider 可能在同一个上游 chunk 中发出文本、thinking 和工具调用的 delta，pi 可能交错地呈现相应事件，例如 `text_start`、`text_delta`、`toolcall_start`、`text_delta`、`toolcall_delta`。消费者必须使用 `contentIndex` 把每个 delta/end 事件与其 block 关联，且不得假设一个 block 的 `*_start`/`*_delta`/`*_end` 序列不会被其他 block 的事件打断。

## 图片输入

具有 vision 能力的模型可以处理图片。你可以通过 `input` 属性检查模型是否支持图片。如果把图片传给不支持 vision 的模型，它们会被静默忽略。

```typescript
import { readFileSync } from 'fs';

const model = models.getModel('openai', 'gpt-4o-mini')!;

// 检查模型是否支持图片
if (model.input.includes('image')) {
  console.log('Model supports vision');
}

const imageBuffer = readFileSync('image.png');
const base64Image = imageBuffer.toString('base64');

const response = await models.complete(model, {
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'What is in this image?' },
      { type: 'image', data: base64Image, mimeType: 'image/png' }
    ],
    timestamp: Date.now()
  }]
});

// 访问响应
for (const block of response.content) {
  if (block.type === 'text') {
    console.log(block.text);
  }
}
```

## 图片生成

图片生成使用与文本/聊天生成分离的 API 面，设计上与聊天侧对应：`ImagesModels` 集合持有 `ImagesProvider`，读取是同步的，认证通过拥有该模型的 provider 解析。图片生成是一次性 API：`generateImages()` 等待 provider 响应并返回最终的 `AssistantImages` 结果——不要为此使用 chat/stream API。

### 基本图片生成

```typescript
import { builtinImagesModels } from '@earendil-works/pi-ai/providers/all';

// 所有内置的图片生成 provider；接受与 createModels() 相同的选项
const imagesModels = builtinImagesModels();

const model = imagesModels.getModel('openrouter', 'google/gemini-2.5-flash-image')!;

// 认证通过 provider 解析（这里是 OPENROUTER_API_KEY）；显式 apiKey 优先
const result = await imagesModels.generateImages(model, {
  input: [{ type: 'text', text: 'Generate a red circle on a plain white background.' }]
});

for (const block of result.output) {
  if (block.type === 'text') {
    console.log(block.text);
  } else if (block.type === 'image') {
    console.log(block.mimeType);
    console.log(block.data.substring(0, 32));
  }
}
```

和聊天侧一样，你可以用各部分自行组建集合：`createImagesModels({ credentials?, authContext? })`、来自 `@earendil-works/pi-ai/providers/openrouter-images` 的 `openrouterImagesProvider()` 工厂，以及用于自定义图片 provider 的 `createImagesProvider({ id, auth, models, refreshModels?, api })`（动态列表用 `imagesModels.refresh(provider?)`）。失败绝不会 reject——它们返回一个 `stopReason: "error"` 的 `AssistantImages`。集合的 `getAuth(model)` 与聊天侧的工作方式完全一致。

旧的全局 API（`getImageModel()` / `getImageModels()` / `getImageProviders()` / `generateImages()`）在 [compat 入口点](#从旧的全局-api-迁移)上仍然可用：

```typescript
import { getImageModel, generateImages } from '@earendil-works/pi-ai/compat';

const model = getImageModel('openrouter', 'google/gemini-2.5-flash-image');
const result = await generateImages(model, {
  input: [{ type: 'text', text: 'Generate a red circle on a plain white background.' }]
}, {
  apiKey: process.env.OPENROUTER_API_KEY
});
```

有些模型也支持图片输入：

```typescript
import { readFileSync } from 'fs';

const imageBuffer = readFileSync('input.png');
const result = await imagesModels.generateImages(model, {
  input: [
    { type: 'text', text: 'Create a variation of this image with a blue background.' },
    { type: 'image', data: imageBuffer.toString('base64'), mimeType: 'image/png' }
  ]
});
```

通过模型元数据检查能力：

```typescript
console.log(model.input);   // ['text', 'image']
console.log(model.output);  // ['image'] 或 ['image', 'text']
```

### 说明与限制

- 图片模型位于 `ImagesModels` 集合中，聊天模型位于 `Models` 集合中；两者是分离的 API 面。
- 使用 `generateImages()`，而不是 chat/stream API。
- 图片生成模型不参与 tool calling。
- 输出通过 `AssistantImages.output` 返回，可以同时包含 base64 编码的 `ImageContent` 块和 `TextContent` 块。
- 有些模型只返回图片，有些返回图片加文本。请检查 `model.output`。
- 有些模型接受图片输入，有些只支持 text-to-image。请检查 `model.input`。
- 与流式 API 一样，图片生成支持 `apiKey`、`signal`、`headers`、`onPayload` 和 `onResponse` 等选项，结果可能包含 `stopReason`、`responseId` 和 `usage`。
- 如果你想让模型在对话中分析图片或调用工具，请使用常规聊天 API 配合支持图片输入的模型。
- 目前图片生成只通过一个 provider（OpenRouter）提供。

## Thinking/Reasoning

许多模型支持 thinking/reasoning 能力，能展示内部思考过程。你可以通过 `reasoning` 属性检查模型是否支持 reasoning。如果给不支持 reasoning 的模型传 reasoning 选项，它们会被静默忽略。

### 统一接口（streamSimple/completeSimple）

```typescript
// 各 provider 的许多模型都支持 thinking/reasoning
const model = models.getModel('anthropic', 'claude-sonnet-4-5')!;
// 或 models.getModel('openai', 'gpt-5-mini');
// 或 models.getModel('google', 'gemini-2.5-flash');
// 或 models.getModel('xai', 'grok-code-fast-1');

// 检查模型是否支持 reasoning
if (model.reasoning) {
  console.log('Model supports reasoning/thinking');
}

// 使用简化的 reasoning 选项
const response = await models.completeSimple(model, {
  messages: [{ role: 'user', content: 'Solve: 2x + 5 = 13', timestamp: Date.now() }]
}, {
  reasoning: 'medium'  // 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
});

// 访问 thinking 和文本块
for (const block of response.content) {
  if (block.type === 'thinking') {
    console.log('Thinking:', block.thinking);
  } else if (block.type === 'text') {
    console.log('Response:', block.text);
  }
}
```

### Provider 特定选项（stream/complete）

`models.stream()`/`complete()` 接受所属 API 的完整选项集。对动态查找到的模型用 `hasApi()` 收窄到其 API，以获得完整的选项类型：

```typescript
import { hasApi } from '@earendil-works/pi-ai';

// OpenAI Reasoning（o1、o3、gpt-5）
const openaiModel = models.getModel('openai', 'gpt-5-mini')!;
if (hasApi(openaiModel, 'openai-responses')) {
  await models.complete(openaiModel, context, {
    reasoningEffort: 'medium',
    reasoningSummary: 'detailed'  // 仅 OpenAI Responses API
  });
}

// Anthropic Thinking
const anthropicModel = models.getModel('anthropic', 'claude-sonnet-4-5')!;
if (hasApi(anthropicModel, 'anthropic-messages')) {
  await models.complete(anthropicModel, context, {
    thinkingEnabled: true,
    thinkingBudgetTokens: 8192  // 可选的 token 限制
  });
}

// Google Gemini Thinking
const googleModel = models.getModel('google', 'gemini-2.5-flash')!;
if (hasApi(googleModel, 'google-generative-ai')) {
  await models.complete(googleModel, context, {
    thinking: {
      enabled: true,
      budgetTokens: 8192  // -1 表示动态，0 表示禁用
    }
  });
}
```

### 流式 Thinking 内容

流式时，thinking 内容通过特定事件传递：

```typescript
const s = models.streamSimple(model, context, { reasoning: 'high' });

for await (const event of s) {
  switch (event.type) {
    case 'thinking_start':
      console.log('[Model started thinking]');
      break;
    case 'thinking_delta':
      process.stdout.write(event.delta);  // 流式输出 thinking 内容
      break;
    case 'thinking_end':
      console.log('\n[Thinking complete]');
      break;
  }
}
```

## Stop Reasons

每个 `AssistantMessage` 都包含一个 `stopReason` 字段，指示生成如何结束：

- `"stop"` —— 正常完成，模型完成了它的响应
- `"length"` —— 输出达到了最大 token 限制
- `"toolUse"` —— 模型正在调用工具并期待工具结果
- `"error"` —— 生成期间发生错误
- `"aborted"` —— 请求通过 abort signal 被取消

当底层 API 提供时，`AssistantMessage` 还可能包含 `responseId`——provider 特定的上游响应或消息标识符。不要假设它在所有 provider 上都存在。

## 错误处理

请求失败绝不会从 stream 函数中抛出：当请求以错误结束时（包括中止和工具调用验证错误），流式 API 会发出 error 事件，最终消息携带详情：

```typescript
// 流式中
for await (const event of s) {
  if (event.type === 'error') {
    // event.reason 是 "error" 或 "aborted"
    // event.error 是带部分内容的 AssistantMessage
    console.error(`Error (${event.reason}):`, event.error.errorMessage);
    console.log('Partial content:', event.error.content);
  }
}

// 最终消息将包含错误详情
const message = await s.result();
if (message.stopReason === 'error' || message.stopReason === 'aborted') {
  console.error('Request failed:', message.errorMessage);
  // message.content 包含错误之前收到的任何部分内容
  // message.usage 包含部分 token 计数和费用
}
```

认证失败（未配置 key、OAuth 刷新失败、未知 provider）以同样的方式呈现：作为 `stopReason: "error"` 的 stream 错误。

### 中止请求

Abort signal 允许你取消进行中的请求。被中止的请求 `stopReason === 'aborted'`：

```typescript
const controller = new AbortController();

// 2 秒后中止
setTimeout(() => controller.abort(), 2000);

const s = models.stream(model, {
  messages: [{ role: 'user', content: 'Write a long story', timestamp: Date.now() }]
}, {
  signal: controller.signal
});

for await (const event of s) {
  if (event.type === 'text_delta') {
    process.stdout.write(event.delta);
  } else if (event.type === 'error') {
    // event.reason 告诉你是 "error" 还是 "aborted"
    console.log(`${event.reason === 'aborted' ? 'Aborted' : 'Error'}:`, event.error.errorMessage);
  }
}

// 获取结果（若被中止则可能是部分的）
const response = await s.result();
if (response.stopReason === 'aborted') {
  console.log('Request was aborted:', response.errorMessage);
  console.log('Partial content received:', response.content);
  console.log('Tokens used:', response.usage);
}
```

### 中止后继续

被中止的消息可以加入对话上下文并在后续请求中继续：

```typescript
const context = {
  messages: [
    { role: 'user', content: 'Explain quantum computing in detail', timestamp: Date.now() }
  ]
};

// 第一个请求在 2 秒后被中止
const controller1 = new AbortController();
setTimeout(() => controller1.abort(), 2000);

const partial = await models.complete(model, context, { signal: controller1.signal });

// 把部分响应加入上下文
context.messages.push(partial);
context.messages.push({ role: 'user', content: 'Please continue', timestamp: Date.now() });

// 继续对话
const continuation = await models.complete(model, context);
```

### 调试 Provider Payload

使用 `onPayload` 回调检查发送给 provider 的请求 payload。这对调试请求格式问题或 provider 验证错误很有用。

```typescript
const response = await models.complete(model, context, {
  onPayload: (payload) => {
    console.log('Provider payload:', JSON.stringify(payload, null, 2));
  }
});
```

`stream`、`complete`、`streamSimple` 和 `completeSimple` 都支持该回调。

## 自定义 Providers

### createProvider()

`createProvider()` 用各部分构建一个 provider：标识、认证、模型列表和 API 实现。可用于本地推理服务器、代理，或任何 OpenAI/Anthropic 兼容端点：

```typescript
import { createModels, createProvider, envApiKeyAuth, type Model } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

const ollamaModel: Model<'openai-completions'> = {
  id: 'llama-3.1-8b',
  name: 'Llama 3.1 8B (Ollama)',
  api: 'openai-completions',
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 32000
};

const ollama = createProvider({
  id: 'ollama',
  name: 'Ollama',
  baseUrl: 'http://localhost:11434/v1',
  // 每个 provider 都要声明认证；无 key 的本地服务器解析为"已配置且无 key"。
  auth: { apiKey: { name: 'Ollama', resolve: async () => ({ auth: {} }) } },
  models: [ollamaModel],
  api: openAICompletionsApi(),
});

const models = createModels();
models.setProvider(ollama);

await models.complete(models.getModel('ollama', 'llama-3.1-8b')!, context);
```

对于有真实 key 的 provider，`envApiKeyAuth(displayName, envVars)` 提供标准行为（存储的凭据优先，其次是第一个已设置的环境变量）：

```typescript
const proxy = createProvider({
  id: 'my-proxy',
  auth: { apiKey: envApiKeyAuth('My proxy API key', ['MY_PROXY_API_KEY']) },
  models: [/* ... */],
  api: openAICompletionsApi(),
});
```

混合 API 的 provider 传一个以 `model.api` 为 key 的 map；每个模型分发到它的 API 实现：

```typescript
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';

const gateway = createProvider({
  id: 'my-gateway',
  auth: { apiKey: envApiKeyAuth('Gateway key', ['GATEWAY_API_KEY']) },
  models: [/* api 为 'anthropic-messages' 或 'openai-responses' 的模型 */],
  api: {
    'anthropic-messages': anthropicMessagesApi(),
    'openai-responses': openAIResponsesApi(),
  },
});
```

动态模型列表使用 `refreshModels`；在第一次 `models.refresh()` 之前，该 provider 的列表为空：

```typescript
const llamacpp = createProvider({
  id: 'llamacpp',
  auth: { apiKey: { name: 'llama.cpp', resolve: async () => ({ auth: {} }) } },
  models: [],
  refreshModels: async () => fetchModelsFromServer('http://localhost:8080'),
  api: openAICompletionsApi(),
});

models.setProvider(llamacpp);
await models.refresh('llamacpp');
```

自定义模型可以携带 `headers`（例如躲在 bot 检测后面的代理）和 `compat` 标志——参见 [OpenAI 兼容性设置](#openai-兼容性设置)。

有些 OpenAI 兼容服务器不理解 reasoning 模型使用的 `developer` 角色。对这些 provider，把 `compat.supportsDeveloperRole` 设为 `false`，system prompt 就会作为 `system` 消息发送。如果服务器也不支持 `reasoning_effort`，同时把 `compat.supportsReasoningEffort` 设为 `false`。这通常适用于 Ollama、vLLM、SGLang 及类似的 OpenAI 兼容服务器。

使用模型级的 `thinkingLevelMap` 来描述模型特定的 thinking 控制。key 是 pi 的 thinking 级别（`off`、`minimal`、`low`、`medium`、`high`、`xhigh`）。缺失的 key 使用 provider 默认值，字符串值会发送给 provider，`null` 表示不支持该级别。

```typescript
const ollamaReasoningModel: Model<'openai-completions'> = {
  id: 'gpt-oss:20b',
  name: 'GPT-OSS 20B (Ollama)',
  api: 'openai-completions',
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131072,
  maxTokens: 32000,
  thinkingLevelMap: {
    minimal: null,
    low: null,
    medium: null,
    high: 'high',
    xhigh: null,
  },
  compat: {
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
  }
};
```

### 直接调用 API 实现

API 实现可以独立导入。每个模块恰好导出 `stream` 和 `streamSimple`，并带有该 API 的完整选项类型。直接调用会绕过 provider 认证——请显式传 `apiKey`：

```typescript
import { stream } from '@earendil-works/pi-ai/api/anthropic-messages';

const s = stream(claudeModel, context, {
  apiKey: process.env.ANTHROPIC_API_KEY,
  thinkingEnabled: true,
  thinkingBudgetTokens: 2048,
});
```

内置 API 实现位于 `./api/<api-id>` 下：

| API id | 选项类型 |
|--------|--------------|
| `anthropic-messages` | `AnthropicOptions` |
| `openai-completions` | `OpenAICompletionsOptions` |
| `openai-responses` | `OpenAIResponsesOptions` |
| `openai-codex-responses` | `OpenAICodexResponsesOptions` |
| `azure-openai-responses` | `AzureOpenAIResponsesOptions` |
| `google-generative-ai` | `GoogleOptions` |
| `google-vertex` | `GoogleVertexOptions` |
| `mistral-conversations` | `MistralOptions` |
| `bedrock-converse-stream` | `BedrockOptions` |

导入实现模块会加载它的 SDK。`./api/<id>.lazy` 包装器（provider 工厂使用）在运行时或 bundler 支持动态 import 分块时，将该加载推迟到第一次请求。旧版本的原始 API 子路径（`./anthropic`、`./google`、`./mistral`、`./openai-completions` 等）已移除；请使用 `@earendil-works/pi-ai/api/<api-id>`。

### OpenAI 兼容性设置

`openai-completions` API 被许多 provider 实现，各有细微差异。默认情况下，库会针对一小批已知的 OpenAI 兼容 provider（Cerebras、xAI、Chutes、DeepSeek、NVIDIA NIM、Together AI、zAi、OpenCode、Cloudflare Workers AI 等）基于 `baseUrl` 自动检测兼容性设置。对于自定义代理或未知端点，你可以通过 `compat` 字段覆盖这些设置。对于 `openai-responses` 模型，compat 字段支持 Responses 特有的标志。

```typescript
interface OpenAICompletionsCompat {
  supportsStore?: boolean;           // provider 是否支持 `store` 字段（默认：true）
  supportsDeveloperRole?: boolean;   // provider 支持 `developer` 角色还是 `system`（默认：true）
  supportsReasoningEffort?: boolean; // provider 是否支持 `reasoning_effort`（默认：true）
  supportsUsageInStreaming?: boolean; // provider 是否支持 `stream_options: { include_usage: true }`（默认：true）
  supportsStrictMode?: boolean;      // provider 是否支持工具定义中的 `strict`（默认：true）
  sendSessionAffinityHeaders?: boolean; // 启用缓存时是否根据 `sessionId` 发送 `session_id`、`x-client-request-id` 和 `x-session-affinity`（默认：false）
  maxTokensField?: 'max_completion_tokens' | 'max_tokens';  // 使用哪个字段名（默认：max_completion_tokens）
  requiresToolResultName?: boolean;  // 工具结果是否需要 `name` 字段（默认：false）
  requiresAssistantAfterToolResult?: boolean; // 工具结果后是否必须跟一条 assistant 消息（默认：false）
  requiresThinkingAsText?: boolean;  // thinking 块是否必须转换为文本（默认：false）
  requiresReasoningContentOnAssistantMessages?: boolean; // 启用 reasoning 时，所有重放的 assistant 消息是否必须带空的 reasoning_content（默认：对 DeepSeek 自动检测）
  thinkingFormat?: 'openai' | 'openrouter' | 'deepseek' | 'together' | 'zai' | 'qwen' | 'chat-template' | 'qwen-chat-template' | 'string-thinking' | 'ant-ling'; // reasoning 参数的格式：'openai' 使用 reasoning_effort，'openrouter' 使用 reasoning: { effort }，'deepseek' 使用 thinking: { type } 且在支持时加 reasoning_effort，'together' 使用 reasoning: { enabled } 且在支持时加 reasoning_effort，'zai' 使用 thinking: { type }，'qwen' 使用 enable_thinking，'chat-template' 使用可配置的 chat_template_kwargs，'qwen-chat-template' 使用 chat_template_kwargs.enable_thinking 和 preserve_thinking，'string-thinking' 使用顶层 thinking，'ant-ling' 只对已映射的 effort 使用 reasoning: { effort }（默认：openai）
  chatTemplateKwargs?: Record<string, string | number | boolean | null | { '$var': 'thinking.enabled' | 'thinking.effort'; omitWhenOff?: boolean }>; // chat_template_kwargs 的值；用 $var 引用 pi 控制的 thinking 值
  cacheControlFormat?: 'anthropic';  // 在 system prompt、最后一个工具和最后的 user/assistant 文本内容上使用 Anthropic 风格的 cache_control
  openRouterRouting?: OpenRouterRouting; // OpenRouter 路由偏好（默认：{}）
  vercelGatewayRouting?: VercelGatewayRouting; // Vercel AI Gateway 路由偏好（默认：{}）
}

interface OpenAIResponsesCompat {
  supportsDeveloperRole?: boolean;   // provider 支持 `developer` 角色还是 `system`（默认：true）
  sendSessionIdHeader?: boolean;     // 启用缓存时是否根据 `sessionId` 发送 `session_id`（默认：true）
  supportsLongCacheRetention?: boolean; // provider 是否支持 `prompt_cache_retention: "24h"`（默认：true）
}
```

如果未设置 `compat`，库会回退到基于 URL 的检测。如果只设置了一部分，未指定的字段使用检测到的默认值。这适用于：

- **LiteLLM 代理**：可能不支持 `store` 字段
- **自定义推理服务器**：可能使用非标准字段名
- **自托管端点**：功能支持可能不同

## 用于测试的 Faux Provider

`fauxProvider()` 构建一个内存 provider，返回脚本化的响应，用于测试和演示：

```typescript
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai';

const faux = fauxProvider({
  tokensPerSecond: 50 // 可选
});

const models = createModels();
models.setProvider(faux.provider);

const model = faux.getModel();
const context = {
  messages: [{ role: 'user', content: 'Summarize package.json and then call echo', timestamp: Date.now() }]
};

faux.setResponses([
  fauxAssistantMessage([
    fauxThinking('Need to inspect package metadata first.'),
    fauxToolCall('echo', { text: 'package.json' })
  ], { stopReason: 'toolUse' })
]);

const first = await models.complete(model, context, {
  sessionId: 'session-1',
  cacheRetention: 'short'
});
context.messages.push(first);

context.messages.push({
  role: 'toolResult',
  toolCallId: first.content.find((block) => block.type === 'toolCall')!.id,
  toolName: 'echo',
  content: [{ type: 'text', text: 'package.json contents here' }],
  isError: false,
  timestamp: Date.now()
});

faux.setResponses([
  fauxAssistantMessage([
    fauxThinking('Now I can summarize the tool output.'),
    fauxText('Here is the summary.')
  ])
]);

const s = models.stream(model, context);
for await (const event of s) {
  console.log(event.type);
}

// 可选：多个 faux 模型用于模型切换测试
const multiModel = fauxProvider({
  provider: 'faux-multi',
  models: [
    { id: 'faux-fast', reasoning: false },
    { id: 'faux-thinker', reasoning: true }
  ]
});
models.setProvider(multiModel.provider);
const thinker = multiModel.getModel('faux-thinker');

console.log(thinker?.reasoning);
console.log(faux.getPendingResponseCount());
console.log(faux.state.callCount);
```

说明：
- 响应按请求开始的顺序从队列中消费。
- 队列为空时，faux provider 返回一条 assistant 错误消息，`errorMessage: "No more faux responses queued"`。
- 用 `faux.setResponses([...])` 替换剩余队列，用 `faux.appendResponses([...])` 追加响应。
- `faux.models` 暴露所有 faux 模型。`faux.getModel()` 返回第一个，`faux.getModel(id)` 返回指定的一个。
- 用 `fauxAssistantMessage(...)` 构建脚本化的 assistant 回复。用 `fauxText(...)`、`fauxThinking(...)` 和 `fauxToolCall(...)` 构建 content block，无需手动填底层字段。
- 用量按大约每 4 个字符 1 个 token 估算。当存在 `sessionId` 且 `cacheRetention` 不是 `"none"` 时，会自动模拟 prompt cache 的读写。
- 工具调用参数通过 `toolcall_delta` 分块增量流式传输。
- 默认情况下，每个流式 chunk 在各自的 microtask 中发出。设置 `tokensPerSecond` 可以按真实时间节奏投递 chunk。
- 预期用法是每个 handle 一条确定性的脚本化流程。如果需要独立的并发流程，请用不同的 `provider` id 创建多个 faux provider。

## 跨 Provider 交接

本库支持在同一对话中无缝地在不同 LLM provider 之间交接。这允许你在对话中途切换模型，同时保留上下文，包括 thinking 块、工具调用和工具结果。

当一个 provider 的消息发送给另一个 provider 时，库会自动做兼容性转换：

- **User 和工具结果消息**原样传递
- **来自相同 provider/API 的 assistant 消息**按原样保留
- **来自不同 provider 的 assistant 消息**的 thinking 块被转换为带 `<thinking>` 标签的文本
- **工具调用和普通文本**原样保留

```typescript
import { createModels, type Context } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';

const models = createModels();
models.setProvider(anthropicProvider());
models.setProvider(openaiProvider());
models.setProvider(googleProvider());

const context: Context = { messages: [] };

// 从 Claude 开始
const claude = models.getModel('anthropic', 'claude-sonnet-4-5')!;
context.messages.push({ role: 'user', content: 'What is 25 * 18?', timestamp: Date.now() });
context.messages.push(await models.completeSimple(claude, context, { reasoning: 'medium' }));

// 切换到 GPT-5 —— 它会把 Claude 的 thinking 看作带 <thinking> 标签的文本
const gpt5 = models.getModel('openai', 'gpt-5-mini')!;
context.messages.push({ role: 'user', content: 'Is that calculation correct?', timestamp: Date.now() });
context.messages.push(await models.complete(gpt5, context));

// 切换到 Gemini
const gemini = models.getModel('google', 'gemini-2.5-flash')!;
context.messages.push({ role: 'user', content: 'What was the original question?', timestamp: Date.now() });
const geminiResponse = await models.complete(gemini, context);
```

所有 provider 都能处理来自其他 provider 的消息——文本、工具调用和结果（包括图片）、thinking 块（转换为带标签的文本）以及带部分内容的被中止消息。这带来灵活的工作流：从快速模型开始，切换到更强的模型做复杂推理，或在 provider 故障时保持连续性。

## 上下文序列化

`Context` 对象可以用标准 JSON 方法轻松序列化和反序列化，便于持久化对话、实现聊天历史或在服务之间传输上下文：

```typescript
const context: Context = {
  systemPrompt: 'You are a helpful assistant.',
  messages: [
    { role: 'user', content: 'What is TypeScript?', timestamp: Date.now() }
  ]
};

const model = models.getModel('openai', 'gpt-4o-mini')!;
const response = await models.complete(model, context);
context.messages.push(response);

// 序列化整个上下文
const serialized = JSON.stringify(context);

// 保存到数据库、localStorage、文件等
localStorage.setItem('conversation', serialized);

// 之后：反序列化并继续对话
const restored: Context = JSON.parse(localStorage.getItem('conversation')!);
restored.messages.push({ role: 'user', content: 'Tell me more about its type system', timestamp: Date.now() });

// 用任意模型继续
const newModel = models.getModel('anthropic', 'claude-3-5-haiku-20241022')!;
const continuation = await models.complete(newModel, restored);
```

模型也是纯粹可序列化的数据——不附带任何函数或实现——所以持久化"这个对话用的是哪个模型"只需一个 `JSON.stringify`。

> **注意**：如果上下文包含图片（如图片输入一节所示的 base64 编码），它们也会被序列化。

## 浏览器使用

本库支持浏览器环境。核心入口点和 provider 工厂无副作用，可以干净地打包。浏览器中没有环境变量，所以要显式传 API key——或者注入一个 `CredentialStore`（如基于 localStorage 的实现），让 provider 认证从存储的凭据解析：

```typescript
import { createModels } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';

const models = createModels();
models.setProvider(anthropicProvider());

const model = models.getModel('anthropic', 'claude-3-5-haiku-20241022')!;
const response = await models.complete(model, {
  messages: [{ role: 'user', content: 'Hello!', timestamp: Date.now() }]
}, {
  apiKey: 'your-api-key'
});
```

> **安全警告**：在前端代码中暴露 API key 很危险。任何人都可以提取并滥用你的 key。此方式仅用于内部工具或演示。生产应用请使用后端代理来保护 API key。

浏览器兼容性说明：

- Amazon Bedrock（`bedrock-converse-stream`）不支持浏览器环境。它仍会出现在模型列表中；调用在运行时失败。
- OAuth 登录流程仅限 Node。它们被惰性加载在 bundler 不可见的 import 之后，因此注册一个支持 OAuth 的 provider 不会把 Node-only 代码拉进浏览器 bundle——只有真正登录才会。
- 如果需要在 Web 应用中使用 Bedrock 或基于 OAuth 的认证，请使用服务端代理或后端服务。

## 打包与 Tree Shaking

为了得到更小的 bundle，只导入需要的 provider：

```typescript
import { createModels } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';

const models = createModels();
models.setProvider(openaiProvider());
```

规则：

- `@earendil-works/pi-ai` 是核心入口点，不导入内置目录、provider 工厂或 SDK 实现。
- `@earendil-works/pi-ai/providers/<provider>` 只导入该 provider 的目录和惰性 API 包装器。
- `@earendil-works/pi-ai/providers/all` 导入所有内置 provider 工厂和全部目录。只在需要完整内置集合时使用。
- 启用代码分割后，provider 的 SDK 留在惰性 chunk 中，首次请求时才加载。
- 不启用代码分割时，bundler 会把可达的惰性 API 实现折叠进单个 bundle。此时单 provider 的 bundle 会包含该 provider 的 SDK；`providers/all` 会包含所有静态可见的 SDK。Bedrock 是例外：它的 AWS SDK 实现通过 bundler 不可见的 Node-only import 加载。
- 直接导入 `@earendil-works/pi-ai/api/<api-id>` 会立即加载该 API 实现及其 SDK。

新的打包应用请避免使用 `@earendil-works/pi-ai/compat`；它保留旧的全局 API，并导入完整的内置目录。

对于单文件 Node ESM bundle，某些 SDK 依赖内部可能仍使用动态 CommonJS `require()`。如果看到 `Dynamic require of "child_process" is not supported` 之类的错误，请给 bundle 添加一个 Node `require` shim。使用 esbuild：

```bash
esbuild app.js --bundle --platform=node --format=esm \
  --banner:js='import { createRequire } from "module";const require = createRequire(import.meta.url);' \
  --outfile=app.bundle.js
```

这只针对 Node bundle；它不是浏览器或 Cloudflare Workers 的解决方案。

Bedrock 仅限 Node。像其他 provider 一样添加它：

```typescript
import { createModels } from '@earendil-works/pi-ai';
import { amazonBedrockProvider } from '@earendil-works/pi-ai/providers/amazon-bedrock';

const models = createModels();
models.setProvider(amazonBedrockProvider());
```

在正常的 Node 包使用和代码分割 bundle 中，Bedrock 会惰性加载它的 AWS SDK 实现。对于必须包含 Bedrock 支持的独立单文件 bundle，请显式注册实现模块：

```typescript
import { setBedrockProviderModule } from '@earendil-works/pi-ai/api/bedrock-converse-stream.lazy';
import { bedrockProviderModule } from '@earendil-works/pi-ai/bedrock-provider';

setBedrockProviderModule(bedrockProviderModule);
```

这个显式覆盖会把 AWS SDK 打进 bundle。没有它，Bedrock 的不透明运行时 import 需要包的 Bedrock 实现文件在运行时可用。

### Provider 作用域的环境变量覆盖

在 stream 选项中传 `env`，把 provider 配置限定到单个请求。`env` 中的值在 provider 认证和配置（例如 Cloudflare account ID、Azure OpenAI 设置、Vertex project/location、Bedrock 设置、`PI_CACHE_RETENTION` 以及 `HTTP_PROXY`/`HTTPS_PROXY`）中优先于进程环境变量。

```typescript
const models = builtinModels();
const model = models.getModel('cloudflare-ai-gateway', 'workers-ai/@cf/moonshotai/kimi-k2.6')!;

const response = await models.complete(model, context, {
  env: {
    CLOUDFLARE_API_KEY: '...',
    CLOUDFLARE_ACCOUNT_ID: 'account-id',
    CLOUDFLARE_GATEWAY_ID: 'gateway-id'
  }
});
```

当一个进程需要为不同请求使用不同的 provider 设置，或不希望环境变量泄漏到某次 provider 调用时使用。

## OAuth Providers

几个 provider 支持 OAuth 认证而非静态 API key：

- **Anthropic**（Claude Pro/Max 订阅）
- **OpenAI Codex**（ChatGPT Plus/Pro 订阅，可访问 GPT-5.x Codex 模型）
- **GitHub Copilot**（Copilot 订阅）

这些 provider 都在 `provider.auth.oauth` 上携带一个 `OAuthAuth`，包含三个操作：`login(callbacks)` 运行交互式流程并返回凭据，`refresh(credential)` 交换 refresh token，`toAuth(credential)` 派生请求认证（GitHub Copilot 的按账号 base URL 就来自这里）。刷新是自动的：`models.getAuth()` 和请求路径会在 credential store 锁内刷新过期的 token，因此并发请求和进程不会重复刷新。

```typescript
import { createModels } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';

const models = createModels({ credentials: myStore }); // 持久化的 CredentialStore
models.setProvider(anthropicProvider());

// 登录：用 prompt()/notify() 回调驱动流程，持久化凭据
const provider = models.getProvider('anthropic')!;
const credential = await provider.auth.oauth!.login({
  prompt: async (p) => {
    // p.type: 'text' | 'secret' | 'select' | 'manual_code'
    // manual_code 提示会与本地回调服务器竞速；服务器胜出时 p.signal 会中止它们
    return await askUser(p.message);
  },
  notify: (event) => {
    // event.type: 'auth_url' | 'device_code' | 'progress'
    if (event.type === 'auth_url') console.log(`Open: ${event.url}`);
    if (event.type === 'device_code') console.log(`Code: ${event.userCode} at ${event.verificationUri}`);
    if (event.type === 'progress') console.log(event.message);
  },
});
await myStore.modify('anthropic', async () => credential);

// 从此之后，请求会自动解析并刷新 token
const model = models.getModel('anthropic', 'claude-sonnet-4-5')!;
await models.complete(model, context);

// 登出
await myStore.delete('anthropic');
```

### Vertex AI

Vertex AI 模型支持 Google Cloud API key 或 Application Default Credentials（ADC）：

- **API key**：设置 `GOOGLE_CLOUD_API_KEY` 或在调用选项中传 `apiKey`。
- **本地开发（ADC）**：运行 `gcloud auth application-default login`
- **CI/生产（ADC）**：设置 `GOOGLE_APPLICATION_CREDENTIALS` 指向 service account 的 JSON key 文件

使用 ADC 时，还需设置 `GOOGLE_CLOUD_PROJECT`（或 `GCLOUD_PROJECT`）和 `GOOGLE_CLOUD_LOCATION`。也可以在调用选项中传 `project`/`location`。使用 `GOOGLE_CLOUD_API_KEY` 时不需要 `project` 和 `location`。

```bash
# 本地（使用你的用户凭据）
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT="my-project"
export GOOGLE_CLOUD_LOCATION="us-central1"

# CI/生产（service account key 文件）
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"
```

官方文档：[Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials)

### CLI 登录

最快的认证方式：

```bash
npx @earendil-works/pi-ai login              # 交互式选择 provider
npx @earendil-works/pi-ai login anthropic    # 登录指定 provider
npx @earendil-works/pi-ai list               # 列出可用 provider
```

凭据保存到当前目录的 `auth.json`。

### 编程式 OAuth

旧的流程函数仍可通过 `@earendil-works/pi-ai/oauth` 入口点使用（`loginAnthropic`、`loginOpenAICodex`、`loginGitHubCopilot`、`refreshOAuthToken`、`getOAuthApiKey`）；在那里凭据存储由调用者负责。新代码应优先使用上面展示的 provider 自有的 `OAuthAuth`——它与 credential store 组合，并免费获得带锁的自动刷新。

Provider 说明：

**OpenAI Codex**：需要 ChatGPT Plus 或 Pro 订阅。提供对 GPT-5.x Codex 模型的访问，具有扩展的上下文窗口和 reasoning 能力。当 stream 选项中提供 `sessionId` 时，库会自动处理基于会话的 prompt caching。可以在 stream 选项中把 `transport` 设为 `"sse"`、`"websocket"` 或 `"auto"` 来选择 Codex Responses 的传输方式。使用 WebSocket 且带 `sessionId` 时，连接按会话复用，闲置 5 分钟后过期。

**Azure OpenAI (Responses)**：仅使用 Responses API。设置 `AZURE_OPENAI_API_KEY` 以及 `AZURE_OPENAI_BASE_URL` 或 `AZURE_OPENAI_RESOURCE_NAME` 之一。`AZURE_OPENAI_BASE_URL` 同时支持 `https://<resource>.openai.azure.com` 和 `https://<resource>.cognitiveservices.azure.com`；根端点会自动规范化为 `.../openai/v1`。需要时可用 `AZURE_OPENAI_API_VERSION`（默认 `v1`）覆盖 API 版本。部署名默认按模型 ID 处理，可用 `azureDeploymentName` 或 `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` 覆盖，格式为逗号分隔的 `model-id=deployment` 对（例如 `gpt-4o-mini=my-deployment,gpt-4o=prod`）。有意不支持旧式基于 deployment 的 URL。

**GitHub Copilot**：如果收到 "The requested model is not supported" 错误，请在 VS Code 中手动启用该模型：打开 Copilot Chat，点击模型选择器，选择该模型（带警告图标），然后点击 "Enable"。

## 从旧的全局 API 迁移

旧版本暴露了一个全局 API：通过全局注册表按 `model.api` 分发的 `stream()`/`complete()`、同步的 `getModel()`/`getModels()`/`getProviders()` 目录读取、`registerApiProvider()`、`getEnvApiKey()`，以及各 API 的惰性 stream 函数。这套 API 原样保留在 **compat 入口点**上：

```typescript
// 之前
import { getModel, complete } from '@earendil-works/pi-ai';

// 之后（行为完全一致，只改一处 import 路径）
import { getModel, complete } from '@earendil-works/pi-ai/compat';
```

compat 是根入口点的严格超集，所以一个文件可以整体切换 import 路径。它会在未来的版本中移除；请迁移到 `createModels()` + provider 工厂：

| 旧 | 新 |
|-----|-----|
| `getModel('openai', 'gpt-4o-mini')` | `models.getModel('openai', 'gpt-4o-mini')` 或 `providers/all` 的 `getBuiltinModel()` |
| `getModels('anthropic')` / `getProviders()` | `models.getModels('anthropic')` / `models.getProviders()` 或 `getBuiltin*` |
| `stream(model, ctx, opts)`（环境变量 key 注入） | `models.stream(model, ctx, opts)`（provider 认证解析） |
| `registerApiProvider({ api, stream, streamSimple })` | `createProvider({ id, auth, models, api })` + `models.setProvider()` |
| `getEnvApiKey('openai')` | `await models.getAuth(model)` |
| `streamAnthropic(model, ctx, opts)` | `@earendil-works/pi-ai/api/anthropic-messages` 的 `stream`，或集合中的 provider |
| `registerFauxProvider()` | `fauxProvider()` + `models.setProvider()` |

## 开发

### 添加新 Provider

添加一个新的 LLM provider 需要跨多个文件的更改。分层布局：API 实现位于 `src/api/`，provider 工厂位于 `src/providers/`，生成的目录位于 `src/providers/<id>.models.ts`。此清单涵盖所有必需步骤：

#### 1. 核心类型（`src/types.ts`）

- 如果是新 API，把 API 标识符加入 `KnownApi`（例如 `"bedrock-converse-stream"`）
- 把 provider 名加入 `KnownProvider`（例如 `"amazon-bedrock"`）
- 把选项类型加入 `ApiOptionsMap`

#### 2. API 实现（`src/api/<api-id>.ts`，仅新 API 需要）

创建一个新的 API 实现文件（例如 `bedrock-converse-stream.ts`），恰好导出 `stream` 和 `streamSimple`，外加：

- 一个扩展 `StreamOptions` 的选项接口（例如 `BedrockOptions`）
- 将 `Context` 转换为 provider 格式的消息转换函数
- 如果 provider 支持工具，还需工具转换
- 响应解析，发出标准化事件（`text`、`tool_call`、`thinking`、`usage`、`stop`）

添加惰性包装器 `src/api/<api-id>.lazy.ts`（通过 `lazyApi()` 提供 `<name>Api()`），使 provider 能够在不导入其 SDK 的情况下引用该实现。在 `src/index.ts` 中添加应保留在 `@earendil-works/pi-ai` 根级别的 `export type` 重导出。

#### 3. 模型生成（`scripts/generate-models.ts`、`scripts/generate-image-models.ts`）

- 添加从 provider 数据源（如 models.dev API）获取和解析模型的逻辑
- 通过 `scripts/generate-models.ts` 把聊天/支持工具的 provider 模型数据映射到标准化的 `Model` 接口；重新生成会输出 `src/providers/<id>.models.ts` 和聚合器
- 通过 `scripts/generate-image-models.ts` 把图片生成 provider 的模型数据映射到标准化的 `ImagesModel` 接口
- 处理 provider 特定的怪癖（定价格式、能力标志、模型 ID 转换）

#### 4. Provider 工厂（`src/providers/<id>.ts`）

- 用 `createProvider()` 组装目录 + 认证 + 惰性 API 包装器
- 认证：标准 key provider 用 `envApiKeyAuth`，环境式认证（AWS profile、ADC）用自定义 `ApiKeyAuth`，有 OAuth 流程的用 `lazyOAuth`
- 在 `src/providers/all.ts` 中注册工厂
- 如果是新 API：在 `src/compat.ts` 的 builtin 列表中注册，并在 `package.json` 中添加包子路径导出

#### 5. 测试（`test/`）

创建或更新测试文件以覆盖新 provider：

- `stream.test.ts` —— 基础流式和工具使用
- `tokens.test.ts` —— token 用量报告
- `abort.test.ts` —— 请求取消
- `empty.test.ts` —— 空消息处理
- `context-overflow.test.ts` —— 上下文超限错误
- `image-limits.test.ts` —— 图片支持（如适用）
- `unicode-surrogate.test.ts` —— Unicode 处理
- `tool-call-without-result.test.ts` —— 孤立的工具调用
- `image-tool-result.test.ts` —— 工具结果中的图片
- `total-tokens.test.ts` —— token 计数准确性
- `cross-provider-handoff.test.ts` —— 跨 provider 上下文重放
- `providers.test.ts` —— provider 列表和认证解析

对于 `cross-provider-handoff.test.ts`，至少添加一个 provider/模型对。如果 provider 提供多个模型系列（例如 GPT 和 Claude），每个系列至少添加一对。

对于非标准认证的 provider（AWS、Google Vertex），创建类似 `bedrock-utils.ts` 的带凭据检测辅助函数的工具文件。

#### 6. Coding Agent 集成（`../coding-agent/`）

更新 `src/core/model-resolver.ts`：

- 在 `DEFAULT_MODELS` 中为该 provider 添加默认模型 ID

更新 `src/cli/args.ts`：

- 在帮助文本中添加环境变量说明

更新 `README.md`：

- 在 providers 一节中添加该 provider 及设置说明

#### 7. 文档

更新 `packages/ai/README.md`：

- 添加到支持的 Providers 表格
- 记录 provider 特定的选项或认证要求
- 在环境变量一节中添加环境变量

#### 8. Changelog

在 `packages/ai/CHANGELOG.md` 的 `## [Unreleased]` 下添加条目：

```markdown
### Added
- Added support for [Provider Name] provider ([#PR](link) by [@author](link))
```

## License

MIT
