import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { FIREWORKS_MODELS } from "./fireworks.models.ts";

// The generated model catalog owns model-specific metadata; this factory owns runtime authentication and protocol wiring.
// 生成的模型清单负责各模型元数据；本工厂负责运行时认证与协议连接。
export function fireworksProvider(): Provider<"anthropic-messages" | "openai-completions"> {
	return createProvider({
		id: "fireworks",
		name: "Fireworks",
		baseUrl: "https://api.fireworks.ai/inference",
		// Standard API-key auth supports saved credentials and the declared environment-variable fallback.
		// 标准 API key 认证支持已保存凭据，并回退到这里声明的环境变量。
		auth: { apiKey: envApiKeyAuth("Fireworks API key", ["FIREWORKS_API_KEY"]) },
		models: Object.values(FIREWORKS_MODELS),
		// Each generated model selects its wire protocol through api; these adapters implement the corresponding translation.
		// 每个生成模型通过 api 选择传输协议；这些适配器实现对应的协议转换。
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"openai-completions": openAICompletionsApi(),
		},
	});
}
