import type { AssistantMessage } from "../types.ts";

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
	return new RegExp(patterns.join("|"), "i");
}

const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
	// OpenCode Go/free-tier limits returned as 429 JSON error types by OpenCode's
	// Zen API. These are subscription/account limits, not transient throttles.
	// OpenCode 的 Zen API 会以 429 JSON 错误类型返回 OpenCode Go/免费层限制。
	// 这些属于订阅或账户限制，并非暂时性限流。
	"GoUsageLimitError",
	"FreeUsageLimitError",

	// OpenCode Go subscription-limit text asks users to enable available-balance
	// usage after rolling/weekly/monthly limits are reached.
	// 达到滚动、每周或每月限制后，OpenCode Go 的订阅限制文本会提示用户
	// 启用可用余额消费。
	"Monthly usage limit reached",
	"available balance",

	// Generic quota/budget/billing exhaustion. `insufficient_quota` is OpenAI's
	// quota/billing error code; the other strings cover common gateway wording.
	// 通用的配额、预算或计费额度耗尽判断。`insufficient_quota` 是 OpenAI 的
	// 配额/计费错误码，其他字符串覆盖常见网关措辞。
	"insufficient_quota",
	"out of budget",
	"quota exceeded",
	"billing",
]);

const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	// Generic provider load, HTTP status, and server-side transient failures.
	// 通用的提供商负载、HTTP 状态和服务端暂时性故障。
	"overloaded",
	"rate.?limit",
	"too many requests",
	"429",
	"500",
	"502",
	"503",
	"504",
	"524",
	"service.?unavailable",
	"server.?error",
	"internal.?error",

	// Wrapper/provider text for transient upstream failures, including OpenRouter
	// "Provider returned error" responses (#2264).
	// 包装层或提供商用于描述上游暂时性故障的文本，包括 OpenRouter 的
	// "Provider returned error" 响应（#2264）。
	"provider.?returned.?error",

	// Network, proxy, and fetch transport failures. This includes OpenAI Codex
	// raw-fetch failures such as "upstream connect", "connection refused", and
	// "reset before headers" (#733), plus OpenRouter connection drops (#3317).
	// 网络、代理和 fetch 传输故障。其中包括 OpenAI Codex raw-fetch 的
	// "upstream connect"、"connection refused"、"reset before headers" 等故障（#733），
	// 以及 OpenRouter 连接中断（#3317）。
	"network.?error",
	"connection.?error",
	"connection.?refused",
	"connection.?lost",
	"other side closed",
	"fetch failed",
	"upstream.?connect",
	"reset before headers",
	"socket hang up",
	"socket connection was closed",
	"timed? out",
	"timeout",
	"terminated",

	// WebSocket transports can report close/error text instead of HTTP/fetch text.
	// WebSocket 传输可能报告关闭/错误文本，而不是 HTTP/fetch 文本。
	"websocket.?closed",
	"websocket.?error",

	// Premature stream endings from SDKs and transports. Anthropic can throw
	// "stream ended without ..." and "Anthropic stream ended before message_stop"
	// (#4433); Bedrock/Smithy can throw an HTTP/2 no-response error (#3594).
	// SDK 或传输层提前结束流。Anthropic 可能抛出 "stream ended without ..." 和
	// "Anthropic stream ended before message_stop"（#4433）；Bedrock/Smithy 可能
	// 抛出 HTTP/2 无响应错误（#3594）。
	"ended without",
	"stream ended before message_stop",
	"http2 request did not get a response",

	// Provider-requested retry delay cap failures should flow through the outer
	// retry policy so callers can surface/abort the backoff (#1123).
	// 提供商要求的重试延迟超过上限时，应交由外层重试策略处理，
	// 以便调用方展示或中止退避过程（#1123）。
	"retry delay",

	// Explicit retry guidance emitted mid-stream by OpenAI Responses and Bedrock
	// stream exceptions (#6019).
	// OpenAI Responses 和 Bedrock 流异常在流处理中途给出的明确重试指引（#6019）。
	"you can retry your request",
	"try your request again",
	"please retry your request",

	// gRPC based providers (e.g. NVIDIA NIM)
	// 基于 gRPC 的提供商（如 NVIDIA NIM）
	"ResourceExhausted",
]);

/**
 * Classifies whether a failed assistant message looks like a transient provider
 * or transport error, so callers can decide if the last assistant turn should be
 * restarted.
 * 判断失败的助手消息是否类似提供商或传输层的暂时性错误，
 * 供调用方决定是否应重新开始上一轮助手响应。
 *
 * This does not implement retry policy. Callers should first handle context
 * overflow separately, then apply their own retry budget, backoff, and reporting
 * before restarting the assistant turn.
 * 此函数不实现重试策略。调用方应先单独处理上下文溢出，再应用自己的
 * 重试预算、退避和报告机制，然后重新开始助手响应。
 */
export function isRetryableAssistantError(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	const errorMessage = message.errorMessage;
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return false;
	return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
}
