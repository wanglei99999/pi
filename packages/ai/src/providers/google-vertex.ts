import { googleVertexApi } from "../api/google-vertex.lazy.ts";
import type { ApiKeyAuth } from "../auth/types.ts";
import { createProvider, type Provider } from "../models.ts";
import { GOOGLE_VERTEX_MODELS } from "./google-vertex.models.ts";

const VERTEX_ADC_PATH = "~/.config/gcloud/application_default_credentials.json";

/**
 * Vertex accepts an explicit API key or Application Default Credentials
 * Vertex 支持显式 API key 或 Application Default Credentials。
 * (`gcloud auth application-default login`). ADC additionally requires
 * project and location env vars, which the implementation reads itself.
 * ADC 还要求 project 和 location 环境配置；具体值由 API 实现自行读取。
 */
const vertexAuth: ApiKeyAuth = {
	name: "Google Cloud credentials",
	resolve: async ({ ctx, credential }) => {
		// 已存储 credential 优先于 GOOGLE_CLOUD_API_KEY；任一有效 key 都直接走 API key 认证分支。
		const key = credential?.key ?? (await ctx.env("GOOGLE_CLOUD_API_KEY"));
		if (key) return { auth: { apiKey: key }, source: credential?.key ? "stored credential" : "GOOGLE_CLOUD_API_KEY" };

		const adcPath = await ctx.env("GOOGLE_APPLICATION_CREDENTIALS");
		// ADC 只有在凭据文件、project 和 location 同时可用时才视为已配置，避免列表展示无法请求的模型。
		const hasCredentials = await ctx.fileExists(adcPath ?? VERTEX_ADC_PATH);
		const hasProject = Boolean((await ctx.env("GOOGLE_CLOUD_PROJECT")) ?? (await ctx.env("GCLOUD_PROJECT")));
		const hasLocation = Boolean(await ctx.env("GOOGLE_CLOUD_LOCATION"));
		if (hasCredentials && hasProject && hasLocation) {
			// 返回空 auth 表示认证已就绪但无需注入 apiKey，API 层将从环境解析 ADC 配置。
			return { auth: {}, source: "gcloud application default credentials" };
		}
		return undefined;
	},
};

export function googleVertexProvider(): Provider<"google-vertex"> {
	// 提供商绑定静态 Vertex 模型目录与 lazy API 工厂，注册阶段不会立即加载 @google/genai 实现。
	return createProvider({
		id: "google-vertex",
		name: "Google Vertex AI",
		auth: { apiKey: vertexAuth },
		models: Object.values(GOOGLE_VERTEX_MODELS),
		api: googleVertexApi(),
	});
}
