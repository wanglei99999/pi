import { googleGenerativeAIApi } from "../api/google-generative-ai.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { GOOGLE_MODELS } from "./google.models.ts";

export function googleProvider(): Provider<"google-generative-ai"> {
	// The provider couples the generated Gemini catalog to the native Google Generative AI adapter.
	// 该 provider 将生成的 Gemini 目录绑定到原生 Google Generative AI 适配器。
	return createProvider({
		id: "google",
		name: "Google",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		auth: { apiKey: envApiKeyAuth("Gemini API key", ["GEMINI_API_KEY"]) },
		// API-key auth remains environment-compatible while the model catalog stays static and generated.
		// API key 认证兼容环境变量，模型目录则保持静态生成。
		models: Object.values(GOOGLE_MODELS),
		api: googleGenerativeAIApi(),
	});
}
