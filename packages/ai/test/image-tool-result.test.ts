import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { Api, Context, Model, Tool, ToolResultMessage } from "../src/compat.ts";
import { complete, getModel } from "../src/compat.ts";
import type { StreamOptions } from "../src/types.ts";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

import { hasAzureOpenAICredentials, resolveAzureDeploymentName } from "./azure-utils.ts";
import { hasBedrockCredentials } from "./bedrock-utils.ts";
import { resolveApiKey } from "./oauth.ts";

// Resolve OAuth tokens at module level (async, runs before tests)
// 在模块级解析 OAuth tokens，使基于凭证的 skip 条件在注册测试前已确定。
const oauthTokens = await Promise.all([
	resolveApiKey("anthropic"),
	resolveApiKey("github-copilot"),
	resolveApiKey("openai-codex"),
]);
const [anthropicOAuthToken, githubCopilotToken, openaiCodexToken] = oauthTokens;

/**
 * Test that tool results containing only images work correctly across all providers.
 * This verifies that:
 * 1. Tool results can contain image content blocks
 * 2. Providers correctly pass images from tool results to the LLM
 * 3. The LLM can see and describe images returned by tools
 *
 * 验证仅含图片的 tool result 可跨 provider 转换：内部 image content block 必须进入对应 API，
 * 且模型最终能描述图片；断言聚焦端到端可见性，不绑定 provider-specific payload 结构。
 */
async function handleToolWithImageResult<TApi extends Api>(model: Model<TApi>, options?: StreamOptionsWithExtras) {
	// Check if the model supports images
	// 模型未声明 image 输入能力时跳过，避免把 capability 缺失误判为 provider 转换失败。
	if (!model.input.includes("image")) {
		console.log(`Skipping tool image result test - model ${model.id} doesn't support images`);
		return;
	}

	// Read the test image
	// 使用固定 fixture 保持所有 provider 接收到完全相同的图片字节。
	const imagePath = join(__dirname, "data", "red-circle.png");
	const imageBuffer = readFileSync(imagePath);
	const base64Image = imageBuffer.toString("base64");

	// Define a tool that returns only an image (no text)
	// tool result 不提供文本线索，确保最终描述只能来自图片 content block。
	const getImageSchema = Type.Object({});
	const getImageTool: Tool<typeof getImageSchema> = {
		name: "get_circle",
		description: "Returns a circle image for visualization",
		parameters: getImageSchema,
	};

	const context: Context = {
		systemPrompt: "You are a helpful assistant that uses tools when asked.",
		messages: [
			{
				role: "user",
				content: "Call the get_circle tool to get an image, and describe what you see, shapes, colors, etc.",
				timestamp: Date.now(),
			},
		],
		tools: [getImageTool],
	};

	// First request - LLM should call the tool
	// 第一轮只验证模型进入 toolUse，建立后续 toolCallId 关联所需的调用上下文。
	const firstResponse = await complete(model, context, options);
	expect(firstResponse.stopReason).toBe("toolUse");

	// Find the tool call
	// 显式查找并收窄 toolCall，避免在缺少调用时继续构造无效 tool result。
	const toolCall = firstResponse.content.find((b) => b.type === "toolCall");
	expect(toolCall).toBeTruthy();
	if (!toolCall || toolCall.type !== "toolCall") {
		throw new Error("Expected tool call");
	}
	expect(toolCall.name).toBe("get_circle");

	// Add the tool call to context
	// 将 assistant tool call 原样加入 context，保持 provider 所需的调用/结果配对顺序。
	context.messages.push(firstResponse);

	// Create tool result with ONLY an image (no text)
	// 仅包含 image 的 ToolResultMessage 是核心转换边界，不允许 text block 提供降级信息。
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [
			{
				type: "image",
				data: base64Image,
				mimeType: "image/png",
			},
		],
		isError: false,
		timestamp: Date.now(),
	};

	context.messages.push(toolResult);

	// Second request - LLM should describe the image from the tool result
	// 第二轮验证 provider 能将 tool result 图片回送模型，并正常结束而非再次请求工具。
	const secondResponse = await complete(model, context, options);
	expect(secondResponse.stopReason).toBe("stop");
	expect(secondResponse.errorMessage).toBeFalsy();

	// Verify the LLM can see and describe the image
	// 语义断言保持最小化，只检查 fixture 的稳定视觉属性，降低自然语言措辞波动造成的失败。
	const textContent = secondResponse.content.find((b) => b.type === "text");
	expect(textContent).toBeTruthy();
	if (textContent && textContent.type === "text") {
		const lowerContent = textContent.text.toLowerCase();
		// Should mention red and circle since that's what the image shows
		// red 与 circle 是 fixture 的确定属性，因此可作为跨 provider 的共同可见性信号。
		expect(lowerContent).toContain("red");
		expect(lowerContent).toContain("circle");
	}
}

/**
 * Test that tool results containing both text and images work correctly across all providers.
 * This verifies that:
 * 1. Tool results can contain mixed content blocks (text + images)
 * 2. Providers correctly pass both text and images from tool results to the LLM
 * 3. The LLM can see both the text and images in tool results
 *
 * 混合内容场景同时验证 text 与 image 两条转换通道；模型必须结合文本细节与视觉属性，
 * 防止 provider adapter 静默丢弃其中一种 content block。
 */
async function handleToolWithTextAndImageResult<TApi extends Api>(
	model: Model<TApi>,
	options?: StreamOptionsWithExtras,
) {
	// Check if the model supports images
	// capability 不包含 image 时跳过，此分支不承担文本-only 降级行为测试。
	if (!model.input.includes("image")) {
		console.log(`Skipping tool text+image result test - model ${model.id} doesn't support images`);
		return;
	}

	// Read the test image
	const imagePath = join(__dirname, "data", "red-circle.png");
	const imageBuffer = readFileSync(imagePath);
	const base64Image = imageBuffer.toString("base64");

	// Define a tool that returns both text and an image
	// tool 同时返回可独立断言的文本事实和图片视觉属性，以检测任一通道丢失。
	const getImageSchema = Type.Object({});
	const getImageTool: Tool<typeof getImageSchema> = {
		name: "get_circle_with_description",
		description: "Returns a circle image with a text description",
		parameters: getImageSchema,
	};

	const context: Context = {
		systemPrompt: "You are a helpful assistant that uses tools when asked.",
		messages: [
			{
				role: "user",
				content:
					"Use the get_circle_with_description tool and tell me what you learned. Also say what color the shape is.",
				timestamp: Date.now(),
			},
		],
		tools: [getImageTool],
	};

	// First request - LLM should call the tool
	const firstResponse = await complete(model, context, options);
	expect(firstResponse.stopReason).toBe("toolUse");

	// Find the tool call
	const toolCall = firstResponse.content.find((b) => b.type === "toolCall");
	expect(toolCall).toBeTruthy();
	if (!toolCall || toolCall.type !== "toolCall") {
		throw new Error("Expected tool call");
	}
	expect(toolCall.name).toBe("get_circle_with_description");

	// Add the tool call to context
	context.messages.push(firstResponse);

	// Create tool result with BOTH text and image
	// 保持 text 在前、image 在后，覆盖 adapter 对混合 content 顺序的常见输入形式。
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [
			{
				type: "text",
				text: "This is a geometric shape with specific properties: it has a diameter of 100 pixels.",
			},
			{
				type: "image",
				data: base64Image,
				mimeType: "image/png",
			},
		],
		isError: false,
		timestamp: Date.now(),
	};

	context.messages.push(toolResult);

	// Second request - LLM should describe both the text and image from the tool result
	const secondResponse = await complete(model, context, options);
	expect(secondResponse.stopReason).toBe("stop");
	expect(secondResponse.errorMessage).toBeFalsy();

	// Verify the LLM can see both text and image
	// 最终回答必须分别证明文本信息和图片信息均已到达模型。
	const textContent = secondResponse.content.find((b) => b.type === "text");
	expect(textContent).toBeTruthy();
	if (textContent && textContent.type === "text") {
		const lowerContent = textContent.text.toLowerCase();
		// Should mention details from the text (diameter/pixels)
		// 任一文本关键词命中即可，避免要求模型逐字复述 tool result。
		expect(lowerContent.match(/diameter|100|pixel/)).toBeTruthy();
		// Should also mention the visual properties (red and circle)
		// 同时要求视觉属性，防止模型仅依赖描述性 text block 完成断言。
		expect(lowerContent).toContain("red");
		expect(lowerContent).toContain("circle");
	}
}

describe("Tool Results with Images", () => {
	describe.skipIf(!process.env.GEMINI_API_KEY)("Google Provider (gemini-2.5-flash)", () => {
		const llm = getModel("google", "gemini-2.5-flash");

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Completions Provider (gpt-4o-mini)", () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
		void _compat;
		// Force the catalog model through openai-completions to exercise that adapter independently of its default api.
		// 强制 catalog model 走 openai-completions，以独立覆盖该 adapter，而不依赖默认 api。
		const llm: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
		};

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Responses Provider (gpt-5-mini)", () => {
		const llm = getModel("openai", "gpt-5-mini");

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	describe.skipIf(!hasAzureOpenAICredentials())("Azure OpenAI Responses Provider (gpt-4o-mini)", () => {
		const llm = getModel("azure-openai-responses", "gpt-4o-mini");
		const azureDeploymentName = resolveAzureDeploymentName(llm.id);
		const azureOptions = azureDeploymentName ? { azureDeploymentName } : {};

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm, azureOptions);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm, azureOptions);
		});
	});

	describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic Provider (claude-haiku-4-5)", () => {
		const model = getModel("anthropic", "claude-haiku-4-5");

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(model);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(model);
		});
	});

	describe.skipIf(!process.env.OPENROUTER_API_KEY)("OpenRouter Provider (glm-4.5v)", () => {
		const llm = getModel("openrouter", "z-ai/glm-4.5v");

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	describe.skipIf(!process.env.MISTRAL_API_KEY)("Mistral Provider (pixtral-12b)", () => {
		const llm = getModel("mistral", "pixtral-12b");

		it("should handle tool result with only image", { retry: 5, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		it("should handle tool result with text and image", { retry: 5, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	describe.skipIf(!process.env.TOGETHER_API_KEY)("Together AI Provider (Kimi-K2.6)", () => {
		const llm = getModel("together", "moonshotai/Kimi-K2.6");
		const options = { reasoningEffort: "high" } satisfies StreamOptionsWithExtras;

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm, options);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm, options);
		});
	});

	describe.skipIf(!process.env.XIAOMI_API_KEY)("Xiaomi MiMo (API billing) Provider (mimo-v2.5-pro)", () => {
		const llm = getModel("xiaomi", "mimo-v2.5-pro");

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		// FIXME(xiaomi): when a tool_result contains both a descriptive text block
		// and an image block, MiMo locks onto the text and ignores the image (it
		// reports the text-derived diameter but never mentions the image's color).
		// The image-only case above proves the image reaches the model, and the
		// text-only path obviously works, so this is a multimodal-fusion quality
		// issue in the model, not a transport bug. Re-enable when upstream model
		// quality improves.
		// 图片-only 用例证明传输链路正常；混合用例因模型只关注 text 而跳过，边界属于上游
		// multimodal-fusion 质量，不应被误诊为 provider adapter 丢失 image。
		it.skip("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY)(
		"Xiaomi MiMo Token Plan (CN) Provider (mimo-v2.5-pro)",
		() => {
			const llm = getModel("xiaomi-token-plan-cn", "mimo-v2.5-pro");

			it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
				await handleToolWithImageResult(llm);
			});

			// FIXME(xiaomi): see the API-billing block above — same multimodal-fusion
			// limitation applies to Token Plan endpoints (same model behind both).
			// Token Plan endpoint 使用同一模型，因此沿用上方相同的 multimodal-fusion 跳过边界。
			it.skip("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
				await handleToolWithTextAndImageResult(llm);
			});
		},
	);

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_AMS_API_KEY)(
		"Xiaomi MiMo Token Plan (AMS) Provider (mimo-v2.5-pro)",
		() => {
			const llm = getModel("xiaomi-token-plan-ams", "mimo-v2.5-pro");

			it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
				await handleToolWithImageResult(llm);
			});

			// FIXME(xiaomi): see the API-billing block above — same multimodal-fusion
			// limitation applies to Token Plan endpoints (same model behind both).
			// Token Plan endpoint 使用同一模型，因此沿用上方相同的 multimodal-fusion 跳过边界。
			it.skip("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
				await handleToolWithTextAndImageResult(llm);
			});
		},
	);

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_SGP_API_KEY)(
		"Xiaomi MiMo Token Plan (SGP) Provider (mimo-v2.5-pro)",
		() => {
			const llm = getModel("xiaomi-token-plan-sgp", "mimo-v2.5-pro");

			it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
				await handleToolWithImageResult(llm);
			});

			// FIXME(xiaomi): see the API-billing block above — same multimodal-fusion
			// limitation applies to Token Plan endpoints (same model behind both).
			// Token Plan endpoint 使用同一模型，因此沿用上方相同的 multimodal-fusion 跳过边界。
			it.skip("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
				await handleToolWithTextAndImageResult(llm);
			});
		},
	);

	describe.skipIf(!process.env.KIMI_API_KEY)("Kimi For Coding Provider (k2p7)", () => {
		const llm = getModel("kimi-coding", "k2p7");

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	describe.skipIf(!process.env.AI_GATEWAY_API_KEY)("Vercel AI Gateway Provider (google/gemini-2.5-flash)", () => {
		const llm = getModel("vercel-ai-gateway", "google/gemini-2.5-flash");

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	describe.skipIf(!hasBedrockCredentials())("Amazon Bedrock Provider (claude-sonnet-4-5)", () => {
		const llm = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0");

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	// =========================================================================
	// OAuth-based providers (credentials from ~/.pi/agent/oauth.json)
	// 以下 provider 使用预先解析的 OAuth credentials，并通过单测级 skipIf 控制执行。
	// =========================================================================

	describe("Anthropic OAuth Provider (claude-sonnet-4-5)", () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");

		it.skipIf(!anthropicOAuthToken)(
			"should handle tool result with only image",
			{ retry: 3, timeout: 30000 },
			async () => {
				await handleToolWithImageResult(model, { apiKey: anthropicOAuthToken });
			},
		);

		it.skipIf(!anthropicOAuthToken)(
			"should handle tool result with text and image",
			{ retry: 3, timeout: 30000 },
			async () => {
				await handleToolWithTextAndImageResult(model, { apiKey: anthropicOAuthToken });
			},
		);
	});

	describe("GitHub Copilot Provider", () => {
		it.skipIf(!githubCopilotToken)(
			"claude-haiku-4.5 - should handle tool result with only image",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-haiku-4.5");
				await handleToolWithImageResult(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-haiku-4.5 - should handle tool result with text and image",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-haiku-4.5");
				await handleToolWithTextAndImageResult(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should handle tool result with only image",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-sonnet-4.6");
				await handleToolWithImageResult(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should handle tool result with text and image",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-sonnet-4.6");
				await handleToolWithTextAndImageResult(llm, { apiKey: githubCopilotToken });
			},
		);
	});

	describe("OpenAI Codex Provider", () => {
		it.skipIf(!openaiCodexToken)(
			"gpt-5.5 - should handle tool result with only image",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("openai-codex", "gpt-5.5");
				await handleToolWithImageResult(llm, { apiKey: openaiCodexToken });
			},
		);

		it.skipIf(!openaiCodexToken)(
			"gpt-5.5 - should handle tool result with text and image",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("openai-codex", "gpt-5.5");
				await handleToolWithTextAndImageResult(llm, { apiKey: openaiCodexToken });
			},
		);
	});
});
