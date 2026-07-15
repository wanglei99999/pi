import type { AnthropicOptions } from "./api/anthropic-messages.ts";
import type { AzureOpenAIResponsesOptions } from "./api/azure-openai-responses.ts";
import type { BedrockOptions } from "./api/bedrock-converse-stream.ts";
import type { GoogleOptions } from "./api/google-generative-ai.ts";
import type { GoogleVertexOptions } from "./api/google-vertex.ts";
import type { MistralOptions } from "./api/mistral-conversations.ts";
import type { OpenAICodexResponsesOptions } from "./api/openai-codex-responses.ts";
import type { OpenAICompletionsOptions } from "./api/openai-completions.ts";
import type { OpenAIResponsesOptions } from "./api/openai-responses.ts";
import type { AssistantMessageDiagnostic } from "./utils/diagnostics.ts";
import type { AssistantMessageEventStream } from "./utils/event-stream.ts";

export type { AssistantMessageEventStream } from "./utils/event-stream.ts";

export type KnownApi =
	| "openai-completions"
	| "mistral-conversations"
	| "openai-responses"
	| "azure-openai-responses"
	| "openai-codex-responses"
	| "anthropic-messages"
	| "bedrock-converse-stream"
	| "google-generative-ai"
	| "google-vertex";

export type Api = KnownApi | (string & {});
// 保留已知 API 的自动补全，同时允许外部提供商注册自定义协议标识。

export type KnownImagesApi = "openrouter-images";

export type ImagesApi = KnownImagesApi | (string & {});

export type KnownProvider =
	| "amazon-bedrock"
	| "ant-ling"
	| "anthropic"
	| "google"
	| "google-vertex"
	| "openai"
	| "azure-openai-responses"
	| "openai-codex"
	| "nvidia"
	| "deepseek"
	| "github-copilot"
	| "xai"
	| "groq"
	| "cerebras"
	| "openrouter"
	| "vercel-ai-gateway"
	| "zai"
	| "zai-coding-cn"
	| "mistral"
	| "minimax"
	| "minimax-cn"
	| "moonshotai"
	| "moonshotai-cn"
	| "huggingface"
	| "fireworks"
	| "together"
	| "opencode"
	| "opencode-go"
	| "kimi-coding"
	| "cloudflare-workers-ai"
	| "cloudflare-ai-gateway"
	| "xiaomi"
	| "xiaomi-token-plan-cn"
	| "xiaomi-token-plan-ams"
	| "xiaomi-token-plan-sgp";
export type ProviderId = KnownProvider | string;
// ProviderId 刻意保持开放，避免统一模型层限制第三方或运行时注册的提供商。

export type KnownImagesProvider = "openrouter";

export type ImagesProviderId = KnownImagesProvider | string;

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";
export type ModelThinkingLevel = "off" | ThinkingLevel;
export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;
export type ChatTemplateKwargValue =
	| string
	| number
	| boolean
	| null
	| {
			$var: "thinking.enabled" | "thinking.effort";
			omitWhenOff?: boolean;
	  };

/** Token budgets for each thinking level (token-based providers only) */
/** 各思考级别对应的 token 预算，仅适用于按 token 控制推理的提供商。 */
export interface ThinkingBudgets {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

// Base options all providers share
// 所有提供商共享的基础请求选项
export type CacheRetention = "none" | "short" | "long";

export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";

/** Provider-scoped environment overrides. Values take precedence over process.env. */
/** 提供商作用域内的环境变量覆盖，其优先级高于 process.env。 */
export type ProviderEnv = Record<string, string>;
export type ProviderHeaders = Record<string, string | null>;

export interface ProviderResponse {
	status: number;
	headers: Record<string, string>;
}

export interface StreamOptions {
	temperature?: number;
	maxTokens?: number;
	signal?: AbortSignal;
	apiKey?: string;
	/**
	 * Preferred transport for providers that support multiple transports.
	 * 为支持多种传输方式的提供商指定首选传输。
	 * Providers that do not support this option ignore it.
	 * 不支持此选项的提供商会直接忽略它。
	 */
	transport?: Transport;
	/**
	 * Prompt cache retention preference. Providers map this to their supported values.
	 * 提示词缓存保留偏好，由各提供商映射为其支持的具体取值。
	 * Default: "short".
	 * 默认值为 "short"。
	 */
	cacheRetention?: CacheRetention;
	/**
	 * Optional session identifier for providers that support session-based caching.
	 * 可选的会话标识，供支持会话级缓存的提供商使用。
	 * Providers can use this to enable prompt caching, request routing, or other
	 * 提供商可据此实现提示词缓存、请求路由或其他
	 * session-aware features. Ignored by providers that don't support it.
	 * 会话感知能力；不支持的提供商会忽略它。
	 */
	sessionId?: string;
	/**
	 * Optional callback for inspecting or replacing provider payloads before sending.
	 * 发送前检查或替换提供商请求载荷的可选回调。
	 * Return undefined to keep the payload unchanged.
	 * 返回 undefined 表示保持载荷不变。
	 */
	onPayload?: (payload: unknown, model: Model<Api>) => unknown | undefined | Promise<unknown | undefined>;
	/**
	 * Optional callback invoked after an HTTP response is received and before
	 * 可选回调：收到 HTTP 响应后、
	 * its body stream is consumed.
	 * 消费响应体流之前调用。
	 */
	onResponse?: (response: ProviderResponse, model: Model<Api>) => void | Promise<void>;
	/**
	 * Optional custom HTTP headers to include in API requests.
	 * API 请求中附加的可选自定义 HTTP 头。
	 * Merged with provider defaults; caller values override default headers.
	 * 与提供商默认头合并，调用方值覆盖同名默认值。
	 * On AWS Bedrock these are injected via a Smithy `build`-step middleware so
	 * 在 AWS Bedrock 中，这些头通过 Smithy `build` 阶段中间件注入，
	 * they are covered by SigV4 signing; reserved headers (`x-amz-*`,
	 * 因而会纳入 SigV4 签名；保留头（`x-amz-*`、
	 * `authorization`, `host`) are silently ignored to preserve SigV4 / bearer auth.
	 * `authorization`、`host`）会被静默忽略，以免破坏 SigV4 或 bearer 认证。
	 * A null value suppresses a provider/API default header with the same name.
	 * 值为 null 时，移除提供商或 API 的同名默认头。
	 */
	headers?: ProviderHeaders;
	/**
	 * HTTP request timeout in milliseconds for providers/SDKs that support it.
	 * For example, OpenAI and Anthropic SDK clients default to 10 minutes.
	 */
	timeoutMs?: number;
	/**
	 * WebSocket connect timeout in milliseconds for providers that support
	 * 支持 WebSocket 传输的提供商使用的连接超时，单位为毫秒；
	 * WebSocket transports. This covers the connection/open handshake only;
	 * 仅覆盖连接和 open 握手，
	 * stream idleness after connection uses timeoutMs.
	 * 连接建立后的流空闲超时仍由 timeoutMs 控制。
	 */
	websocketConnectTimeoutMs?: number;
	/**
	 * Maximum retry attempts for providers/SDKs that support client-side retries.
	 * For example, OpenAI and Anthropic SDK clients default to 2.
	 */
	maxRetries?: number;
	/**
	 * Maximum delay in milliseconds to wait for a retry when the server requests a long wait.
	 * 服务器要求长时间等待时，客户端允许的最大重试等待时间，单位为毫秒。
	 * If the server's requested delay exceeds this value, the request fails immediately
	 * 若服务器要求的延迟超过该值，请求立即失败，
	 * with an error containing the requested delay, allowing higher-level retry logic
	 * 错误中会保留服务器要求的延迟，便于上层重试逻辑
	 * to handle it with user visibility.
	 * 在用户可见的情况下接管处理。
	 * Default: 60000 (60 seconds). Set to 0 to disable the cap.
	 * 默认值为 60000；设为 0 可取消上限。
	 */
	maxRetryDelayMs?: number;
	/**
	 * Optional metadata to include in API requests.
	 * Providers extract the fields they understand and ignore the rest.
	 * For example, Anthropic uses `user_id` for abuse tracking and rate limiting.
	 */
	metadata?: Record<string, unknown>;
	/**
	 * Provider-scoped environment values. These take precedence over process.env for
	 * 提供商作用域内的环境变量值；配置区域、端点占位符和
	 * provider configuration such as regional settings, endpoint placeholders, and
	 * 代理变量等提供商配置时，
	 * proxy variables.
	 * 其优先级高于 process.env。
	 */
	env?: ProviderEnv;
}

export type ProviderStreamOptions = StreamOptions & Record<string, unknown>;

/**
 * Maps known APIs to their full provider-specific stream option types.
 * 将已知 API 映射到完整的提供商专属流选项类型。
 * Type-only imports from API implementation modules are erased at emit, so
 * API 实现模块的纯类型导入会在输出时擦除，
 * this is tree-shake safe.
 * 因此不会影响 tree-shaking。
 */
export interface ApiOptionsMap {
	"anthropic-messages": AnthropicOptions;
	"openai-completions": OpenAICompletionsOptions;
	"openai-responses": OpenAIResponsesOptions;
	"openai-codex-responses": OpenAICodexResponsesOptions;
	"azure-openai-responses": AzureOpenAIResponsesOptions;
	"google-generative-ai": GoogleOptions;
	"google-vertex": GoogleVertexOptions;
	"mistral-conversations": MistralOptions;
	"bedrock-converse-stream": BedrockOptions;
}

/**
 * Full stream options for an API. Known APIs resolve to their concrete option
 * API 的完整流选项：已知 API 解析为具体选项类型，
 * type; custom API strings fall back to the generic shape.
 * 自定义 API 字符串则回退为通用结构。
 */
export type ApiStreamOptions<TApi extends Api> = TApi extends keyof ApiOptionsMap
	? ApiOptionsMap[TApi]
	: StreamOptions & Record<string, unknown>;

/**
 * The uniform stream contract of an API implementation module: every module
 * API 实现模块统一遵循的流契约：
 * under `src/api/` exports exactly `stream` and `streamSimple`, so the module
 * `src/api/` 下每个模块都导出 `stream` 和 `streamSimple`，因此模块本身
 * itself satisfies this interface. Lazy wrappers (`lazyApi()`) and provider
 * 即满足此接口；惰性包装器和提供商工厂
 * factories pass these around as values. This is the untyped dispatch shape;
 * 将其作为值传递。此接口只描述未细分 API 的分派形状；
 * per-API option typing lives on the implementation modules themselves and on
 * 每个 API 的具体选项类型仍定义在实现模块以及
 * `Provider.stream()` via `ApiStreamOptions`.
 * `Provider.stream()` 的 `ApiStreamOptions` 上。
 */
export interface ProviderStreams {
	stream(model: Model<Api>, context: Context, options?: StreamOptions): AssistantMessageEventStream;
	streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

/**
 * The uniform contract of an image-generation API implementation module:
 * every image API module under `src/api/` exports exactly `generateImages`,
 * so the module itself satisfies this interface. Lazy wrappers and image
 * provider factories pass these around as values.
 */
export interface ProviderImages {
	generateImages(
		model: ImagesModel<ImagesApi>,
		context: ImagesContext,
		options?: ImagesOptions,
	): Promise<AssistantImages>;
}

export interface ImagesOptions {
	signal?: AbortSignal;
	apiKey?: string;
	/**
	 * Provider-scoped environment values. These take precedence over process.env for
	 * provider configuration such as endpoint placeholders and proxy variables.
	 */
	env?: ProviderEnv;
	/**
	 * Optional callback for inspecting or replacing provider payloads before sending.
	 * Return undefined to keep the payload unchanged.
	 */
	onPayload?: (payload: unknown, model: ImagesModel<ImagesApi>) => unknown | undefined | Promise<unknown | undefined>;
	/**
	 * Optional callback invoked after an HTTP response is received.
	 */
	onResponse?: (response: ProviderResponse, model: ImagesModel<ImagesApi>) => void | Promise<void>;
	/**
	 * Optional custom HTTP headers to include in API requests.
	 * Merged with provider defaults; can override default headers.
	 * A null value suppresses a provider/API default header with the same name.
	 */
	headers?: ProviderHeaders;
	/**
	 * HTTP request timeout in milliseconds for providers/SDKs that support it.
	 */
	timeoutMs?: number;
	/**
	 * Maximum retry attempts for providers/SDKs that support client-side retries.
	 */
	maxRetries?: number;
	/**
	 * Maximum delay in milliseconds to wait for a retry when the server requests a long wait.
	 * If the server's requested delay exceeds this value, the request fails immediately
	 * with an error containing the requested delay, allowing higher-level retry logic
	 * to handle it with user visibility.
	 * Default: 60000 (60 seconds). Set to 0 to disable the cap.
	 */
	maxRetryDelayMs?: number;
	/**
	 * Optional metadata to include in API requests.
	 * Providers extract the fields they understand and ignore the rest.
	 */
	metadata?: Record<string, unknown>;
}

export type ProviderImagesOptions = ImagesOptions & Record<string, unknown>;

// Unified options with reasoning passed to streamSimple() and completeSimple()
// 传给 streamSimple() 和 completeSimple() 的统一推理选项
export interface SimpleStreamOptions extends StreamOptions {
	reasoning?: ThinkingLevel;
	/** Custom token budgets for thinking levels (token-based providers only) */
	/** 思考级别的自定义 token 预算，仅适用于按 token 控制推理的提供商 */
	thinkingBudgets?: ThinkingBudgets;
}

// Generic StreamFunction with typed options.
// 带类型化选项的通用 StreamFunction。
//
// Contract:
// 契约：
// - Must return an AssistantMessageEventStream.
// - 必须返回 AssistantMessageEventStream。
// - Once invoked, request/model/runtime failures should be encoded in the
// - 调用后，请求、模型或运行时失败应编码到返回的流中，
//   returned stream, not thrown.
//   而不是直接抛出。
// - Error termination must produce an AssistantMessage with stopReason
// - 错误终止必须生成 stopReason 为
//   "error" or "aborted" and errorMessage, emitted via the stream protocol.
//   "error" 或 "aborted" 且包含 errorMessage 的 AssistantMessage，并通过流协议发出。
export type StreamFunction<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> = (
	model: Model<TApi>,
	context: Context,
	options?: TOptions,
) => AssistantMessageEventStream;

export type ImagesFunction<TApi extends ImagesApi = ImagesApi, TOptions extends ImagesOptions = ImagesOptions> = (
	model: ImagesModel<TApi>,
	context: ImagesContext,
	options?: TOptions,
) => Promise<AssistantImages>;

export interface TextSignatureV1 {
	v: 1;
	id: string;
	phase?: "commentary" | "final_answer";
}

export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string; // e.g., for OpenAI responses, message metadata (legacy id string or TextSignatureV1 JSON)
	// 提供商返回的文本元数据，用于跨轮回放；可能是旧版 id 字符串或 TextSignatureV1 JSON
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string; // e.g., for OpenAI responses, the reasoning item ID
	// 提供商返回的不透明推理标识，用于后续轮次保持推理上下文连续
	/** When true, the thinking content was redacted by safety filters. The opaque
	 *  encrypted payload is stored in `thinkingSignature` so it can be passed back
	 *  to the API for multi-turn continuity. */
	/** 为 true 时表示思考内容被安全过滤器遮蔽；不透明的加密载荷保存在 `thinkingSignature` 中，
	 * 以便后续轮次原样回传给 API，维持多轮连续性。 */
	redacted?: boolean;
}

export interface ImageContent {
	type: "image";
	data: string; // base64 encoded image data
	mimeType: string; // e.g., "image/jpeg", "image/png"
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, any>;
	thoughtSignature?: string; // Google-specific: opaque signature for reusing thought context
	// Google 专属的不透明签名，用于复用工具调用关联的思考上下文
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Subset of `cacheWrite` written with 1h retention. Only Anthropic reports this split. */
	/** `cacheWrite` 中保留 1 小时的子集；目前仅 Anthropic 单独报告此项。 */
	cacheWrite1h?: number;
	/**
	 * Reasoning/thinking tokens, when the provider reports them. This is a subset of
	 * 提供商报告推理明细时记录的 reasoning/thinking token；它是
	 * `output`: `output` already includes these tokens. Set to a number (possibly 0) by
	 * `output` 的子集，`output` 已包含这些 token。提供推理拆分的提供商
	 * providers that expose a reasoning breakdown; left undefined by providers that don't.
	 * 会将其设为数值（可能为 0），不提供拆分的提供商则保持 undefined。
	 */
	reasoning?: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number; // Unix timestamp in milliseconds
}

export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	api: Api;
	provider: ProviderId;
	model: string;
	responseModel?: string; // Concrete `chunk.model` when different from the requested `model` (e.g. OpenRouter `auto` -> `anthropic/...`)
	// 上游实际响应模型与请求模型不同时，记录具体的 `chunk.model`
	responseId?: string; // Provider-specific response/message identifier when the upstream API exposes one
	// 上游 API 暴露响应或消息标识时，保存提供商专属 id
	diagnostics?: AssistantMessageDiagnostic[]; // Redacted provider/runtime diagnostics for failures and recoveries.
	// 经脱敏的提供商或运行时诊断信息，用于解释失败与恢复过程
	usage: Usage;
	stopReason: StopReason;
	errorMessage?: string;
	timestamp: number; // Unix timestamp in milliseconds
}

export interface ToolResultMessage<TDetails = any> {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[]; // Supports text and images
	// 工具结果协议同时支持文本和图片内容
	details?: TDetails;
	isError: boolean;
	timestamp: number; // Unix timestamp in milliseconds
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export type ImagesInputContent = TextContent | ImageContent;
export type ImagesOutputContent = TextContent | ImageContent;

export interface ImagesContext {
	input: ImagesInputContent[];
}

export type ImagesStopReason = "stop" | "error" | "aborted";

export interface AssistantImages {
	api: ImagesApi;
	provider: ImagesProviderId;
	model: string;
	output: ImagesOutputContent[];
	responseId?: string;
	usage?: Usage;
	stopReason: ImagesStopReason;
	errorMessage?: string;
	timestamp: number; // Unix timestamp in milliseconds
}

import type { TSchema } from "typebox";

export interface Tool<TParameters extends TSchema = TSchema> {
	name: string;
	description: string;
	parameters: TParameters;
}

export interface Context {
	systemPrompt?: string;
	messages: Message[];
	tools?: Tool[];
}

/**
 * Event protocol for AssistantMessageEventStream.
 * AssistantMessageEventStream 使用的事件协议。
 *
 * Streams should emit `start` before partial updates, then terminate with either:
 * 流必须先发出 `start`，再发出增量更新，并以下列事件之一终止：
 * - `done` carrying the final successful AssistantMessage, or
 * - `done`：携带最终成功的 AssistantMessage；或
 * - `error` carrying the final AssistantMessage with stopReason "error" or "aborted"
 * - `error`：携带 stopReason 为 "error" 或 "aborted" 的最终 AssistantMessage，
 *   and errorMessage.
 *   且包含 errorMessage。
 */
export type AssistantMessageEvent =
	| { type: "start"; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| { type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse">; message: AssistantMessage }
	| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

/**
 * Compatibility settings for OpenAI-compatible completions APIs.
 * OpenAI-compatible completions API 的兼容性设置。
 * Use this to override URL-based auto-detection for custom providers.
 * 自定义提供商可用这些选项覆盖基于 URL 的自动检测结果。
 */
export interface OpenAICompletionsCompat {
	/** Whether the provider supports the `store` field. Default: auto-detected from URL. */
	supportsStore?: boolean;
	/** Whether the provider supports the `developer` role (vs `system`). Default: auto-detected from URL. */
	supportsDeveloperRole?: boolean;
	/** Whether the provider supports `reasoning_effort`. Default: auto-detected from URL. */
	supportsReasoningEffort?: boolean;
	/** Whether the provider supports `stream_options: { include_usage: true }` for token usage in streaming responses. Default: true. */
	supportsUsageInStreaming?: boolean;
	/** Which field to use for max tokens. Default: auto-detected from URL. */
	maxTokensField?: "max_completion_tokens" | "max_tokens";
	/** Whether tool results require the `name` field. Default: auto-detected from URL. */
	requiresToolResultName?: boolean;
	/** Whether a user message after tool results requires an assistant message in between. Default: auto-detected from URL. */
	requiresAssistantAfterToolResult?: boolean;
	/** Whether thinking blocks must be converted to text blocks with <thinking> delimiters. Default: auto-detected from URL. */
	requiresThinkingAsText?: boolean;
	/** Whether all replayed assistant messages must include an empty reasoning_content field when reasoning is enabled. Default: auto-detected from URL. */
	requiresReasoningContentOnAssistantMessages?: boolean;
	/** Format for reasoning/thinking parameter. "openai" uses reasoning_effort, "openrouter" uses reasoning: { effort }, "deepseek" uses thinking: { type } plus reasoning_effort when supported, "together" uses reasoning: { enabled } plus reasoning_effort when supported, "zai" uses thinking: { type }, "qwen" uses top-level enable_thinking: boolean, "qwen-chat-template" uses chat_template_kwargs.enable_thinking and preserve_thinking, "chat-template" uses configurable chat_template_kwargs, "string-thinking" uses top-level thinking: string, and "ant-ling" uses reasoning: { effort } only when the mapped effort is non-null. Default: "openai". */
	/** 推理参数格式选择；各协议值决定请求字段映射，默认使用 "openai"。 */
	thinkingFormat?:
		| "openai"
		| "openrouter"
		| "deepseek"
		| "together"
		| "zai"
		| "qwen"
		| "chat-template"
		| "qwen-chat-template"
		| "string-thinking"
		| "ant-ling";
	/** Kwargs to send as `chat_template_kwargs` when `thinkingFormat` is `chat-template`. Use `{ "$var": "thinking.enabled" }` or `{ "$var": "thinking.effort" }` for pi-controlled thinking values. */
	chatTemplateKwargs?: Record<string, ChatTemplateKwargValue>;
	/** OpenRouter-compatible routing preferences sent as the `provider` request field. */
	openRouterRouting?: OpenRouterRouting;
	/** Vercel AI Gateway routing preferences. Only used when baseUrl points to Vercel AI Gateway. */
	vercelGatewayRouting?: VercelGatewayRouting;
	/** Whether z.ai supports top-level `tool_stream: true` for streaming tool call deltas. Default: false. */
	zaiToolStream?: boolean;
	/** Whether the provider supports the `strict` field in tool definitions. Default: true. */
	supportsStrictMode?: boolean;
	/** Cache control convention for prompt caching. "anthropic" applies Anthropic-style `cache_control` markers to the system prompt, last tool definition, and last user/assistant text content. */
	/** 提示词缓存的控制约定；"anthropic" 会在系统提示词、最后一个工具定义及最后一段用户/助手文本上添加 `cache_control`。 */
	cacheControlFormat?: "anthropic";
	/** Whether to send known session-affinity headers (`session_id`, `x-client-request-id`, `x-session-affinity`) from `options.sessionId` when caching is enabled. Default: false. */
	sendSessionAffinityHeaders?: boolean;
	/** Whether the provider supports long prompt cache retention (`prompt_cache_retention: "24h"` or Anthropic-style `cache_control.ttl: "1h"`, depending on format). Default: true. */
	supportsLongCacheRetention?: boolean;
}

/** Compatibility settings for OpenAI Responses APIs. */
/** OpenAI Responses API 的兼容性设置。 */
export interface OpenAIResponsesCompat {
	/** Whether the provider supports the `developer` role (vs `system`). Default: true. */
	supportsDeveloperRole?: boolean;
	/** Whether to send the OpenAI `session_id` cache-affinity header from `options.sessionId` when caching is enabled. Default: true. */
	sendSessionIdHeader?: boolean;
	/** Whether the provider supports `prompt_cache_retention: "24h"`. Default: true. */
	supportsLongCacheRetention?: boolean;
}

/** Compatibility settings for Anthropic Messages-compatible APIs. */
/** Anthropic Messages-compatible API 的兼容性设置。 */
export interface AnthropicMessagesCompat {
	/**
	 * Whether the provider accepts per-tool `eager_input_streaming`.
	 * 提供商是否接受每个工具上的 `eager_input_streaming`。
	 * When false, the Anthropic provider omits `tools[].eager_input_streaming`
	 * 为 false 时，Anthropic 提供商省略 `tools[].eager_input_streaming`，
	 * and sends the legacy `fine-grained-tool-streaming-2025-05-14` beta header
	 * 并在启用工具的请求中发送旧版 beta header，
	 * for tool-enabled requests.
	 * 以兼容旧式细粒度工具流协议。
	 * Default: true.
	 */
	supportsEagerToolInputStreaming?: boolean;
	/** Whether the provider supports Anthropic long cache retention (`cache_control.ttl: "1h"`). Default: true. */
	supportsLongCacheRetention?: boolean;
	/**
	 * Whether to send the `x-session-affinity` header from `options.sessionId`
	 * 启用缓存时，是否根据 `options.sessionId` 发送 `x-session-affinity` header。
	 * when caching is enabled. Required for providers like Fireworks that use
	 * Fireworks 等提供商依赖会话亲和性完成提示词缓存路由，
	 * session affinity for prompt cache routing (requests to the same replica
	 * 将同一会话请求路由到相同副本
	 * maximize cache hits).
	 * 可提高缓存命中率。
	 * Default: false.
	 */
	sendSessionAffinityHeaders?: boolean;
	/**
	 * Whether the provider supports Anthropic-style `cache_control` markers on
	 * 提供商是否支持在工具定义上使用 Anthropic 风格的 `cache_control` 标记。
	 * tool definitions. When false, `cache_control` is omitted from tool params.
	 * 为 false 时，工具参数中会省略 `cache_control`。
	 * Some Anthropic-compatible providers (e.g., Fireworks) do not support this
	 * 某些 Anthropic-compatible 提供商（如 Fireworks）不支持该字段，
	 * field on tools and may reject or ignore it.
	 * 可能拒绝或忽略带此字段的工具定义。
	 * Default: true.
	 */
	supportsCacheControlOnTools?: boolean;
	/**
	 * Whether the model accepts the Anthropic `temperature` request field.
	 * Claude Opus 4.7+ rejects non-default temperature values.
	 * Default: true.
	 */
	supportsTemperature?: boolean;
	/**
	 * Whether to force adaptive thinking (`thinking.type: "adaptive"` plus
	 * 是否强制使用 adaptive thinking，即 `thinking.type: "adaptive"` 加上
	 * `output_config.effort`) regardless of the model id. Built-in models that
	 * `output_config.effort`，而不依赖模型 id。需要该格式的内置模型
	 * require adaptive thinking set this in generated metadata. Custom
	 * 会在生成的元数据中设置此项；自定义
	 * Anthropic-compatible providers can set this to `true` for any model whose
	 * Anthropic-compatible 提供商也可为上游要求该格式的模型设为 true。
	 * upstream requires the adaptive format. Set to `false` to
	 * 对被覆盖的内置模型显式设为 false，
	 * opt out on overridden built-in models.
	 * 即可退出 adaptive thinking。
	 * Default: false.
	 */
	forceAdaptiveThinking?: boolean;
	/** Whether to replay empty thinking signatures as `signature: ""` instead of converting thinking to text. Default: false. */
	allowEmptySignature?: boolean;
}

/**
 * OpenRouter provider routing preferences.
 * OpenRouter 的上游提供商路由偏好。
 * Controls which upstream providers OpenRouter routes requests to.
 * 控制 OpenRouter 将请求路由到哪些上游提供商。
 * Sent as the `provider` field in the OpenRouter API request body.
 * 最终作为 OpenRouter API 请求体中的 `provider` 字段发送。
 * @see https://openrouter.ai/docs/guides/routing/provider-selection
 */
export interface OpenRouterRouting {
	/** Whether to allow backup providers to serve requests. Default: true. */
	allow_fallbacks?: boolean;
	/** Whether to filter providers to only those that support all parameters in the request. Default: false. */
	require_parameters?: boolean;
	/** Data collection setting. "allow" (default): allow providers that may store/train on data. "deny": only use providers that don't collect user data. */
	data_collection?: "deny" | "allow";
	/** Whether to restrict routing to only ZDR (Zero Data Retention) endpoints. */
	zdr?: boolean;
	/** Whether to restrict routing to only models that allow text distillation. */
	enforce_distillable_text?: boolean;
	/** An ordered list of provider names/slugs to try in sequence, falling back to the next if unavailable. */
	order?: string[];
	/** List of provider names/slugs to exclusively allow for this request. */
	only?: string[];
	/** List of provider names/slugs to skip for this request. */
	ignore?: string[];
	/** A list of quantization levels to filter providers by (e.g., ["fp16", "bf16", "fp8", "fp6", "int8", "int4", "fp4", "fp32"]). */
	quantizations?: string[];
	/** Sorting strategy. Can be a string (e.g., "price", "throughput", "latency") or an object with `by` and `partition`. */
	sort?:
		| string
		| {
				/** The sorting metric: "price", "throughput", "latency". */
				by?: string;
				/** Partitioning strategy: "model" (default) or "none". */
				partition?: string | null;
		  };
	/** Maximum price per million tokens (USD). */
	max_price?: {
		/** Price per million prompt tokens. */
		prompt?: number | string;
		/** Price per million completion tokens. */
		completion?: number | string;
		/** Price per image. */
		image?: number | string;
		/** Price per audio unit. */
		audio?: number | string;
		/** Price per request. */
		request?: number | string;
	};
	/** Preferred minimum throughput (tokens/second). Can be a number (applies to p50) or an object with percentile-specific cutoffs. */
	preferred_min_throughput?:
		| number
		| {
				/** Minimum tokens/second at the 50th percentile. */
				p50?: number;
				/** Minimum tokens/second at the 75th percentile. */
				p75?: number;
				/** Minimum tokens/second at the 90th percentile. */
				p90?: number;
				/** Minimum tokens/second at the 99th percentile. */
				p99?: number;
		  };
	/** Preferred maximum latency (seconds). Can be a number (applies to p50) or an object with percentile-specific cutoffs. */
	preferred_max_latency?:
		| number
		| {
				/** Maximum latency in seconds at the 50th percentile. */
				p50?: number;
				/** Maximum latency in seconds at the 75th percentile. */
				p75?: number;
				/** Maximum latency in seconds at the 90th percentile. */
				p90?: number;
				/** Maximum latency in seconds at the 99th percentile. */
				p99?: number;
		  };
}

/**
 * Vercel AI Gateway routing preferences.
 * Vercel AI Gateway 的上游提供商路由偏好。
 * Controls which upstream providers the gateway routes requests to.
 * 控制网关将请求路由到哪些上游提供商。
 * @see https://vercel.com/docs/ai-gateway/models-and-providers/provider-options
 */
export interface VercelGatewayRouting {
	/** List of provider slugs to exclusively use for this request (e.g., ["bedrock", "anthropic"]). */
	only?: string[];
	/** List of provider slugs to try in order (e.g., ["anthropic", "openai"]). */
	order?: string[];
}

// Model interface for the unified model system
// 统一模型系统使用的模型接口
export interface Model<TApi extends Api> {
	id: string;
	name: string;
	api: TApi;
	provider: ProviderId;
	baseUrl: string;
	reasoning: boolean;
	/**
	 * Maps pi thinking levels to provider/model-specific values.
	 * 将 pi 的思考级别映射为提供商或模型专属取值。
	 * Missing keys use provider defaults. null marks a level as unsupported.
	 * 缺失键沿用提供商默认值；null 表示不支持该级别。
	 */
	thinkingLevelMap?: ThinkingLevelMap;
	input: ("text" | "image")[];
	cost: {
		input: number; // $/million tokens
		output: number; // $/million tokens
		cacheRead: number; // $/million tokens
		cacheWrite: number; // $/million tokens
	};
	contextWindow: number;
	maxTokens: number;
	headers?: Record<string, string>;
	/** Compatibility overrides for OpenAI-compatible APIs. If not set, auto-detected from baseUrl. */
	/** OpenAI-compatible API 的兼容性覆盖；未设置时根据 baseUrl 自动检测。 */
	compat?: TApi extends "openai-completions"
		? OpenAICompletionsCompat
		: TApi extends "openai-responses"
			? OpenAIResponsesCompat
			: TApi extends "anthropic-messages"
				? AnthropicMessagesCompat
				: never;
}

export interface ImagesModel<TApi extends ImagesApi>
	extends Omit<Model<Api>, "api" | "provider" | "reasoning" | "contextWindow" | "maxTokens" | "compat"> {
	api: TApi;
	provider: ImagesProviderId;
	output: ("text" | "image")[];
}
