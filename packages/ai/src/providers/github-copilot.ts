import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { loadGitHubCopilotOAuth } from "../utils/oauth/load.ts";
import { GITHUB_COPILOT_MODELS } from "./github-copilot.models.ts";

export function githubCopilotProvider(): Provider<"anthropic-messages" | "openai-completions" | "openai-responses"> {
	// One Copilot provider routes different catalog models through their declared protocol adapters.
	// 同一个 Copilot provider 会按模型声明将请求路由到不同协议适配器。
	return createProvider({
		id: "github-copilot",
		name: "GitHub Copilot",
		baseUrl: "https://api.individual.githubcopilot.com",
		auth: {
			// Environment tokens support automation, while lazy OAuth keeps interactive flow code out of base bundles.
			// 环境 token 支持自动化，延迟 OAuth 则避免基础 bundle 提前加载交互授权代码。
			apiKey: envApiKeyAuth("GitHub Copilot token", ["COPILOT_GITHUB_TOKEN"]),
			oauth: lazyOAuth({ name: "GitHub Copilot", load: loadGitHubCopilotOAuth }),
		},
		models: Object.values(GITHUB_COPILOT_MODELS),
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"openai-completions": openAICompletionsApi(),
			"openai-responses": openAIResponsesApi(),
		},
	});
}
