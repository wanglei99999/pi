import OpenAI from "openai";
import type {
	ChatCompletion,
	ChatCompletionContentPart,
	ChatCompletionContentPartImage,
	ChatCompletionContentPartText,
	ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions.js";
import type {
	AssistantImages,
	ImageContent,
	ImagesContext,
	ImagesFunction,
	ImagesModel,
	ImagesOptions,
	ProviderHeaders,
	TextContent,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";

interface OpenRouterGeneratedImage {
	image_url?: string | { url?: string };
}

type OpenRouterImageGenerationMessage = ChatCompletion["choices"][number]["message"] & {
	images?: OpenRouterGeneratedImage[];
};

type OpenRouterImageGenerationChoice = ChatCompletion["choices"][number] & {
	message: OpenRouterImageGenerationMessage;
};

type OpenRouterImageGenerationResponse = ChatCompletion & {
	choices: OpenRouterImageGenerationChoice[];
};

export const generateImages: ImagesFunction<"openrouter-images", ImagesOptions> = async (
	model: ImagesModel<"openrouter-images">,
	context: ImagesContext,
	options?: ImagesOptions,
) => {
	// Keep image generation on the non-streaming chat endpoint because OpenRouter returns images on the final message.
	// 图片生成使用非流式 chat 端点，因为 OpenRouter 只在最终 message 中返回图片。
	const output: AssistantImages = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: "stop",
		timestamp: Date.now(),
	};

	try {
		const apiKey = options?.apiKey;
		if (!apiKey) {
			throw new Error(`No API key for provider: ${model.provider}`);
		}
		const client = createClient(model, apiKey, options?.headers);
		let params = buildParams(model, context);
		const nextParams = await options?.onPayload?.(params, model);
		// Treat the payload hook result as a complete replacement so callers can adapt gateway-specific fields.
		// 将 payload hook 的结果视为完整替换，便于调用方适配 Gateway 专用字段。
		if (nextParams !== undefined) {
			params = nextParams as typeof params;
		}
		const requestOptions = {
			...(options?.signal ? { signal: options.signal } : {}),
			...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
			maxRetries: options?.maxRetries ?? 0,
		};
		const { data: response, response: rawResponse } = await client.chat.completions
			.create(params as unknown as ChatCompletionCreateParamsNonStreaming, requestOptions)
			.withResponse();
		await options?.onResponse?.({ status: rawResponse.status, headers: headersToRecord(rawResponse.headers) }, model);

		const imageResponse = response as OpenRouterImageGenerationResponse;
		output.responseId = imageResponse.id;
		if (imageResponse.usage) {
			output.usage = parseUsage(imageResponse.usage, model);
		}

		const choice = imageResponse.choices[0];
		// Preserve optional explanatory text before collecting generated data-URL images.
		// 先保留可选说明文本，再收集生成的 data URL 图片。
		if (choice) {
			const content = choice.message.content;
			if (typeof content === "string" && content.length > 0) {
				output.output.push({ type: "text", text: content } satisfies TextContent);
			}

			for (const image of choice.message.images ?? []) {
				// Only inline base64 data URLs can be represented by the provider-neutral ImageContent type.
				// 只有内联 base64 data URL 能转换为提供商无关的 ImageContent。
				const imageUrl = typeof image.image_url === "string" ? image.image_url : image.image_url?.url;
				if (!imageUrl?.startsWith("data:")) continue;
				const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
				if (!matches) continue;
				output.output.push({
					type: "image",
					mimeType: matches[1],
					data: matches[2],
				} satisfies ImageContent);
			}
		}

		return output;
	} catch (error) {
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = formatProviderError(normalizeProviderError(error));
		return output;
	}
};

function createClient(
	model: ImagesModel<"openrouter-images">,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
): OpenAI {
	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		defaultHeaders: providerHeadersToRecord({ ...model.headers, ...optionsHeaders }),
	});
}

type OpenRouterImagesCreateParams = Omit<ChatCompletionCreateParamsNonStreaming, "modalities"> & {
	modalities: Array<"image" | "text">;
};

function buildParams(model: ImagesModel<"openrouter-images">, context: ImagesContext): OpenRouterImagesCreateParams {
	// Encode all prompt parts as one user message while preserving text/image order.
	// 将所有提示部分编码到同一条 user message 中，并保持文本与图片的原始顺序。
	const content: ChatCompletionContentPart[] = context.input.map((item): ChatCompletionContentPart => {
		if (item.type === "text") {
			return {
				type: "text",
				text: sanitizeSurrogates(item.text),
			} satisfies ChatCompletionContentPartText;
		}
		return {
			type: "image_url",
			image_url: {
				url: `data:${item.mimeType};base64,${item.data}`,
			},
		} satisfies ChatCompletionContentPartImage;
	});

	return {
		model: model.id,
		messages: [
			{
				role: "user" as const,
				content,
			},
		],
		stream: false,
		modalities: model.output.includes("text") ? ["image", "text"] : ["image"],
	};
}

function parseUsage(
	rawUsage: {
		prompt_tokens?: number;
		completion_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
	},
	model: ImagesModel<"openrouter-images">,
) {
	// Some gateways include cache writes inside cached_tokens, so subtract writes before deriving cache reads.
	// 部分 Gateway 会把 cache write 计入 cached_tokens，因此先扣除写入量再计算 cache read。
	const promptTokens = rawUsage.prompt_tokens || 0;
	const reportedCachedTokens = rawUsage.prompt_tokens_details?.cached_tokens || 0;
	const cacheWriteTokens = rawUsage.prompt_tokens_details?.cache_write_tokens || 0;
	const cacheReadTokens =
		cacheWriteTokens > 0 ? Math.max(0, reportedCachedTokens - cacheWriteTokens) : reportedCachedTokens;
	const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
	const output = rawUsage.completion_tokens || 0;
	const usage = {
		// Reconstruct totals from normalized buckets to avoid double-counting provider-specific cache fields.
		// 使用规范化后的各项重新计算总量，避免提供商缓存字段被重复计数。
		input,
		output,
		cacheRead: cacheReadTokens,
		cacheWrite: cacheWriteTokens,
		totalTokens: input + output + cacheReadTokens + cacheWriteTokens,
		cost: {
			input: (model.cost.input / 1000000) * input,
			output: (model.cost.output / 1000000) * output,
			cacheRead: (model.cost.cacheRead / 1000000) * cacheReadTokens,
			cacheWrite: (model.cost.cacheWrite / 1000000) * cacheWriteTokens,
			total: 0,
		},
	};
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage;
}
