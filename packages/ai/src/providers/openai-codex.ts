import { openAICodexResponsesApi } from "../api/openai-codex-responses.lazy.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { loadOpenAICodexOAuth } from "../utils/oauth/load.ts";
import { OPENAI_CODEX_MODELS } from "./openai-codex.models.ts";

export function openaiCodexProvider(): Provider<"openai-codex-responses"> {
	// This provider is OAuth-only; loading the flow lazily keeps Node-specific OAuth code off the core path.
	// 此 provider 仅支持 OAuth；延迟加载流程可避免 Node 专用 OAuth 代码进入核心路径。
	return createProvider({
		id: "openai-codex",
		name: "OpenAI Codex",
		baseUrl: "https://chatgpt.com/backend-api",
		auth: {
			oauth: lazyOAuth({ name: "OpenAI (ChatGPT Plus/Pro)", load: loadOpenAICodexOAuth }),
		},
		// The generated catalog owns model availability, while the Codex Responses adapter owns wire behavior.
		// 生成目录负责模型可用性，Codex Responses 适配器负责协议交互行为。
		models: Object.values(OPENAI_CODEX_MODELS),
		api: openAICodexResponsesApi(),
	});
}
