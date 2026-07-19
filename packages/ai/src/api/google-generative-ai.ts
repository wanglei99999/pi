import {
	type GenerateContentConfig,
	type GenerateContentParameters,
	GoogleGenAI,
	type ThinkingConfig,
} from "@google/genai";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
	ThinkingLevel,
	ToolCall,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import type { GoogleThinkingLevel } from "./google-shared.ts";
import {
	convertMessages,
	convertTools,
	isThinkingPart,
	mapStopReason,
	mapToolChoice,
	retainThoughtSignature,
} from "./google-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

export interface GoogleOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: {
		enabled: boolean;
		budgetTokens?: number; // -1 for dynamic, 0 to disable
		// -1 表示由模型动态决定，0 表示禁用（仅适用于支持该预算语义的模型）。
		level?: GoogleThinkingLevel;
	};
}

// Counter for generating unique tool call IDs
// 当提供商未返回 ID 或返回重复 ID 时，用进程级计数器参与生成唯一工具调用 ID。
let toolCallCounter = 0;

export const stream: StreamFunction<"google-generative-ai", GoogleOptions> = (
	model: Model<"google-generative-ai">,
	context: Context,
	options?: GoogleOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "google-generative-ai" as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			const apiKey = options?.apiKey;
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}
			const client = createClient(model, apiKey, options?.headers);
			let params = buildParams(model, context, options);
			// onPayload 位于协议参数构建完成后的最后扩展点，返回值可整体替换即将发送的请求对象。
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as GenerateContentParameters;
			}
			const googleStream = await client.models.generateContentStream(params);

			stream.push({ type: "start", partial: output });
			let currentBlock: TextContent | ThinkingContent | null = null;
			const blocks = output.content;
			const blockIndex = () => blocks.length - 1;
			for await (const chunk of googleStream) {
				// @google/genai documents GenerateContentResponse.responseId as an output-only field
				// used to identify each response. Keep the first non-empty one from the stream.
				// @google/genai 将 GenerateContentResponse.responseId 定义为只读响应标识；流中保留首个非空值。
				output.responseId ||= chunk.responseId;
				const candidate = chunk.candidates?.[0];
				if (candidate?.content?.parts) {
					for (const part of candidate.content.parts) {
						if (part.text !== undefined) {
							// thinking 与普通 text 不能共享内容块；类型切换时先结束旧块，再为新块发出 *_start。
							// 两类文本都跨 chunk 保留 thoughtSignature，供后续同模型会话恢复内容连续性。
							const isThinking = isThinkingPart(part);
							if (
								!currentBlock ||
								(isThinking && currentBlock.type !== "thinking") ||
								(!isThinking && currentBlock.type !== "text")
							) {
								if (currentBlock) {
									if (currentBlock.type === "text") {
										stream.push({
											type: "text_end",
											contentIndex: blocks.length - 1,
											content: currentBlock.text,
											partial: output,
										});
									} else {
										stream.push({
											type: "thinking_end",
											contentIndex: blockIndex(),
											content: currentBlock.thinking,
											partial: output,
										});
									}
								}
								if (isThinking) {
									currentBlock = { type: "thinking", thinking: "", thinkingSignature: undefined };
									output.content.push(currentBlock);
									stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
								} else {
									currentBlock = { type: "text", text: "" };
									output.content.push(currentBlock);
									stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
								}
							}
							if (currentBlock.type === "thinking") {
								currentBlock.thinking += part.text;
								currentBlock.thinkingSignature = retainThoughtSignature(
									currentBlock.thinkingSignature,
									part.thoughtSignature,
								);
								stream.push({
									type: "thinking_delta",
									contentIndex: blockIndex(),
									delta: part.text,
									partial: output,
								});
							} else {
								currentBlock.text += part.text;
								currentBlock.textSignature = retainThoughtSignature(
									currentBlock.textSignature,
									part.thoughtSignature,
								);
								stream.push({
									type: "text_delta",
									contentIndex: blockIndex(),
									delta: part.text,
									partial: output,
								});
							}
						}

						if (part.functionCall) {
							// functionCall 开始前关闭正在输出的文本/推理块，保持事件内容索引边界清晰。
							if (currentBlock) {
								if (currentBlock.type === "text") {
									stream.push({
										type: "text_end",
										contentIndex: blockIndex(),
										content: currentBlock.text,
										partial: output,
									});
								} else {
									stream.push({
										type: "thinking_end",
										contentIndex: blockIndex(),
										content: currentBlock.thinking,
										partial: output,
									});
								}
								currentBlock = null;
							}

							// Generate unique ID if not provided or if it's a duplicate
							// 提供商未给 ID 或同一响应内 ID 重复时生成唯一值，避免工具结果错误配对。
							const providedId = part.functionCall.id;
							const needsNewId =
								!providedId || output.content.some((b) => b.type === "toolCall" && b.id === providedId);
							const toolCallId = needsNewId
								? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`
								: providedId;

							const toolCall: ToolCall = {
								type: "toolCall",
								id: toolCallId,
								name: part.functionCall.name || "",
								arguments: (part.functionCall.args as Record<string, any>) ?? {},
								...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
							};

							output.content.push(toolCall);
							// SDK 在 part 中一次给出完整 args，因此仍按统一协议连续发送 start、单个 delta 和 end。
							stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
							stream.push({
								type: "toolcall_delta",
								contentIndex: blockIndex(),
								delta: JSON.stringify(toolCall.arguments),
								partial: output,
							});
							stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
						}
					}
				}

				if (candidate?.finishReason) {
					output.stopReason = mapStopReason(candidate.finishReason);
					if (output.content.some((b) => b.type === "toolCall")) {
						output.stopReason = "toolUse";
					}
				}

				if (chunk.usageMetadata) {
					// promptTokenCount 包含 cachedContentTokenCount；普通输入需扣除缓存命中，thoughts 计入输出和 reasoning。
					output.usage = {
						input:
							(chunk.usageMetadata.promptTokenCount || 0) - (chunk.usageMetadata.cachedContentTokenCount || 0),
						output:
							(chunk.usageMetadata.candidatesTokenCount || 0) + (chunk.usageMetadata.thoughtsTokenCount || 0),
						cacheRead: chunk.usageMetadata.cachedContentTokenCount || 0,
						cacheWrite: 0,
						reasoning: chunk.usageMetadata.thoughtsTokenCount || 0,
						totalTokens: chunk.usageMetadata.totalTokenCount || 0,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					};
					calculateCost(model, output.usage);
				}
			}

			if (currentBlock) {
				if (currentBlock.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex: blockIndex(),
						content: currentBlock.text,
						partial: output,
					});
				} else {
					stream.push({
						type: "thinking_end",
						contentIndex: blockIndex(),
						content: currentBlock.thinking,
						partial: output,
					});
				}
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error("An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			// Remove internal index property used during streaming
			// 错误返回前移除流式处理中可能附加的内部 index，避免把实现细节写入持久化消息。
			for (const block of output.content) {
				if ("index" in block) {
					delete (block as { index?: number }).index;
				}
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatProviderError(normalizeProviderError(error));
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimple: StreamFunction<"google-generative-ai", SimpleStreamOptions> = (
	model: Model<"google-generative-ai">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey;
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = buildBaseOptions(model, context, options, apiKey);
	// simple 入口只负责把统一 reasoning 配置映射为 Google 的 level 或 budget，再复用完整 stream。
	if (!options?.reasoning) {
		return stream(model, context, { ...base, thinking: { enabled: false } } satisfies GoogleOptions);
	}

	const clampedReasoning = clampThinkingLevel(model, options.reasoning);
	const effort = (clampedReasoning === "off" ? "high" : clampedReasoning) as ClampedThinkingLevel;
	const googleModel = model as Model<"google-generative-ai">;

	if (isGemini3ProModel(googleModel) || isGemini3FlashModel(googleModel) || isGemma4Model(googleModel)) {
		return stream(model, context, {
			...base,
			thinking: {
				enabled: true,
				level: getThinkingLevel(effort, googleModel),
			},
		} satisfies GoogleOptions);
	}

	return stream(model, context, {
		...base,
		thinking: {
			enabled: true,
			budgetTokens: getGoogleBudget(googleModel, effort, options.thinkingBudgets),
		},
	} satisfies GoogleOptions);
};

function createClient(
	model: Model<"google-generative-ai">,
	apiKey?: string,
	optionsHeaders?: ProviderHeaders,
): GoogleGenAI {
	const httpOptions: { baseUrl?: string; apiVersion?: string; headers?: Record<string, string> } = {};
	if (model.baseUrl) {
		httpOptions.baseUrl = model.baseUrl;
		httpOptions.apiVersion = ""; // baseUrl already includes version path, don't append
		// baseUrl 已包含版本路径，因此清空 apiVersion，避免 SDK 再次追加。
	}
	// 调用级 headers 覆盖模型默认 headers，随后统一转换为 SDK 接受的普通对象。
	const headers = providerHeadersToRecord({ ...model.headers, ...optionsHeaders });
	if (headers) {
		httpOptions.headers = headers;
	}

	return new GoogleGenAI({
		apiKey,
		httpOptions: Object.keys(httpOptions).length > 0 ? httpOptions : undefined,
	});
}

function buildParams(
	model: Model<"google-generative-ai">,
	context: Context,
	options: GoogleOptions = {},
): GenerateContentParameters {
	const contents = convertMessages(model, context);

	const generationConfig: GenerateContentConfig = {};
	if (options.temperature !== undefined) {
		generationConfig.temperature = options.temperature;
	}
	if (options.maxTokens !== undefined) {
		generationConfig.maxOutputTokens = options.maxTokens;
	}

	const config: GenerateContentConfig = {
		...(Object.keys(generationConfig).length > 0 && generationConfig),
		...(context.systemPrompt && { systemInstruction: sanitizeSurrogates(context.systemPrompt) }),
		...(context.tools && context.tools.length > 0 && { tools: convertTools(context.tools) }),
	};

	if (context.tools && context.tools.length > 0 && options.toolChoice) {
		config.toolConfig = {
			functionCallingConfig: {
				mode: mapToolChoice(options.toolChoice),
			},
		};
	} else {
		config.toolConfig = undefined;
	}

	if (options.thinking?.enabled && model.reasoning) {
		// 新模型使用 thinkingLevel，旧模型使用 thinkingBudget；同一请求只设置其中一种控制方式。
		const thinkingConfig: ThinkingConfig = { includeThoughts: true };
		if (options.thinking.level !== undefined) {
			// Cast to any since our GoogleThinkingLevel mirrors Google's ThinkingLevel enum values
			// GoogleThinkingLevel 与 SDK 的 ThinkingLevel 枚举值一致，仅类型声明来自不同边界。
			thinkingConfig.thinkingLevel = options.thinking.level as any;
		} else if (options.thinking.budgetTokens !== undefined) {
			thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
		}
		config.thinkingConfig = thinkingConfig;
	} else if (model.reasoning && options.thinking && !options.thinking.enabled) {
		config.thinkingConfig = getDisabledThinkingConfig(model);
	}

	if (options.signal) {
		if (options.signal.aborted) {
			throw new Error("Request aborted");
		}
		config.abortSignal = options.signal;
	}

	const params: GenerateContentParameters = {
		model: model.id,
		contents,
		config,
	};

	return params;
}

type ClampedThinkingLevel = Exclude<ThinkingLevel, "xhigh" | "max">;

function isGemma4Model(model: Model<"google-generative-ai">): boolean {
	return /gemma-?4/.test(model.id.toLowerCase());
}

function isGemini3ProModel(model: Model<"google-generative-ai">): boolean {
	return /gemini-3(?:\.\d+)?-pro/.test(model.id.toLowerCase());
}

function isGemini3FlashModel(model: Model<"google-generative-ai">): boolean {
	const id = model.id.toLowerCase();
	return /gemini-3(?:\.\d+)?-flash/.test(id) || id === "gemini-flash-latest" || id === "gemini-flash-lite-latest";
}

function getDisabledThinkingConfig(model: Model<"google-generative-ai">): ThinkingConfig {
	// Google docs: Gemini 3.1 Pro cannot disable thinking, and Gemini 3 Flash / Flash-Lite
	// do not support full thinking-off either. For Gemini 3 models, use the lowest supported
	// thinkingLevel without includeThoughts so hidden thinking remains invisible to pi.
	// Google 文档说明这些模型不能完全关闭 thinking；因此使用最低支持的 thinkingLevel，
	// 且不设置 includeThoughts，使内部 thinking 不暴露给 pi。
	if (isGemini3ProModel(model)) {
		return { thinkingLevel: "LOW" as any };
	}
	if (isGemini3FlashModel(model)) {
		return { thinkingLevel: "MINIMAL" as any };
	}
	if (isGemma4Model(model)) {
		return { thinkingLevel: "MINIMAL" as any };
	}

	// Gemini 2.x supports disabling via thinkingBudget = 0.
	// Gemini 2.x 支持通过 thinkingBudget = 0 完全禁用 thinking。
	return { thinkingBudget: 0 };
}

function getThinkingLevel(effort: ClampedThinkingLevel, model: Model<"google-generative-ai">): GoogleThinkingLevel {
	if (isGemini3ProModel(model)) {
		switch (effort) {
			case "minimal":
			case "low":
				return "LOW";
			case "medium":
			case "high":
				return "HIGH";
		}
	}
	if (isGemma4Model(model)) {
		switch (effort) {
			case "minimal":
			case "low":
				return "MINIMAL";
			case "medium":
			case "high":
				return "HIGH";
		}
	}
	switch (effort) {
		case "minimal":
			return "MINIMAL";
		case "low":
			return "LOW";
		case "medium":
			return "MEDIUM";
		case "high":
			return "HIGH";
	}
}

function getGoogleBudget(
	model: Model<"google-generative-ai">,
	effort: ClampedThinkingLevel,
	customBudgets?: ThinkingBudgets,
): number {
	// 调用方自定义预算优先于模型默认表；未匹配的模型返回 -1，交由 Google 动态分配。
	if (customBudgets?.[effort] !== undefined) {
		return customBudgets[effort]!;
	}

	if (model.id.includes("2.5-pro")) {
		const budgets: Record<ClampedThinkingLevel, number> = {
			minimal: 128,
			low: 2048,
			medium: 8192,
			high: 32768,
		};
		return budgets[effort];
	}

	if (model.id.includes("2.5-flash-lite")) {
		const budgets: Record<ClampedThinkingLevel, number> = {
			minimal: 512,
			low: 2048,
			medium: 8192,
			high: 24576,
		};
		return budgets[effort];
	}

	if (model.id.includes("2.5-flash")) {
		const budgets: Record<ClampedThinkingLevel, number> = {
			minimal: 128,
			low: 2048,
			medium: 8192,
			high: 24576,
		};
		return budgets[effort];
	}

	return -1;
}
