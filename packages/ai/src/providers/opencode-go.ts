import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { OPENCODE_GO_MODELS } from "./opencode-go.models.ts";

export function opencodeGoProvider(): Provider<"anthropic-messages" | "openai-completions"> {
	// Bind one generated model catalog to both supported runtime protocols; each model's api selects its adapter.
	// 将同一份生成 model catalog 绑定到两种运行时协议；每个 model 的 api 决定使用哪个 adapter。
	return createProvider({
		id: "opencode-go",
		name: "OpenCode Zen Go",
		// Authentication is environment-backed and shared with the broader OpenCode provider family.
		// 认证由环境变量提供，并与更广泛的 OpenCode provider family 共用。
		auth: { apiKey: envApiKeyAuth("OpenCode API key", ["OPENCODE_API_KEY"]) },
		// Model metadata lives in the generated opencode-go.models.ts catalog; provider wiring stays hand-maintained here.
		// model metadata 位于生成的 opencode-go.models.ts catalog；此处仅手工维护 provider wiring。
		models: Object.values(OPENCODE_GO_MODELS),
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"openai-completions": openAICompletionsApi(),
		},
	});
}
