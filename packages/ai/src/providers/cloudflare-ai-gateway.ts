import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { createProvider, type Provider } from "../models.ts";
import { CLOUDFLARE_AI_GATEWAY_MODELS } from "./cloudflare-ai-gateway.models.ts";
import { cloudflareAIGatewayAuth } from "./cloudflare-auth.ts";

export function cloudflareAIGatewayProvider(): Provider<
	"anthropic-messages" | "openai-completions" | "openai-responses"
> {
	// One Gateway provider exposes multiple upstream protocol adapters behind a shared provider identity.
	// 单个 Gateway provider 在统一 provider 身份下暴露多个上游协议适配器。
	return createProvider({
		id: "cloudflare-ai-gateway",
		name: "Cloudflare AI Gateway",
		// Authentication is resolved at the Gateway boundary rather than by each protocol implementation.
		// 认证在 Gateway 边界统一解析，而不是由各协议实现分别处理。
		auth: { apiKey: cloudflareAIGatewayAuth() },
		// The generated catalog defines selectable models; API adapters only determine how each model is invoked.
		// 生成的目录定义可选模型；API 适配器只决定各模型的调用方式。
		models: Object.values(CLOUDFLARE_AI_GATEWAY_MODELS),
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"openai-completions": openAICompletionsApi(),
			"openai-responses": openAIResponsesApi(),
		},
	});
}
