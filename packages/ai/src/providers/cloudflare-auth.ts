import type { ApiKeyAuth, ApiKeyCredential, AuthContext } from "../auth/types.ts";
import type { Api, ImagesApi, ImagesModel, Model, ProviderEnv } from "../types.ts";

const CLOUDFLARE_API_KEY = "CLOUDFLARE_API_KEY";
const CLOUDFLARE_ACCOUNT_ID = "CLOUDFLARE_ACCOUNT_ID";
const CLOUDFLARE_GATEWAY_ID = "CLOUDFLARE_GATEWAY_ID";

type CloudflareAuthKind = "workers-ai" | "ai-gateway";

async function resolveValue(
	name: string,
	ctx: AuthContext,
	credential: ApiKeyCredential | undefined,
): Promise<string | undefined> {
	// A stored credential is authoritative as a bundle; do not mix its missing fields with ambient environment values.
	// 已保存凭据作为整体具有权威性，字段缺失时不再与环境变量混用。
	if (credential) {
		if (name === CLOUDFLARE_API_KEY) return credential.key;
		return credential.env?.[name];
	}
	return ctx.env(name);
}

function resolveCloudflareBaseUrl(
	model: Model<Api> | ImagesModel<ImagesApi>,
	accountId: string,
	gatewayId: string | undefined,
): string {
	// Substitute deployment identifiers at auth resolution time while keeping generated model templates immutable.
	// 在认证解析阶段替换部署标识，同时保持生成的模型 URL 模板不变。
	return model.baseUrl
		.replaceAll(`{${CLOUDFLARE_ACCOUNT_ID}}`, accountId)
		.replaceAll(`{${CLOUDFLARE_GATEWAY_ID}}`, gatewayId ?? "");
}

async function resolveCloudflareEnv(
	kind: CloudflareAuthKind,
	model: Model<Api> | ImagesModel<ImagesApi>,
	ctx: AuthContext,
	credential: ApiKeyCredential | undefined,
): Promise<{ apiKey: string; env: ProviderEnv; baseUrl: string; source: string } | undefined> {
	// Workers AI needs account credentials, whereas AI Gateway additionally requires a gateway ID.
	// Workers AI 需要账户凭据，AI Gateway 还必须提供 gateway ID。
	const apiKey = await resolveValue(CLOUDFLARE_API_KEY, ctx, credential);
	const accountId = await resolveValue(CLOUDFLARE_ACCOUNT_ID, ctx, credential);
	const gatewayId = kind === "ai-gateway" ? await resolveValue(CLOUDFLARE_GATEWAY_ID, ctx, credential) : undefined;

	if (!apiKey || !accountId || (kind === "ai-gateway" && !gatewayId)) return undefined;

	return {
		apiKey,
		env: {
			CLOUDFLARE_ACCOUNT_ID: accountId,
			...(gatewayId ? { CLOUDFLARE_GATEWAY_ID: gatewayId } : {}),
		},
		baseUrl: resolveCloudflareBaseUrl(model, accountId, gatewayId),
		source: credential ? "stored credential" : CLOUDFLARE_API_KEY,
	};
}

export function cloudflareWorkersAIAuth(): ApiKeyAuth {
	// Workers AI uses the API key through the normal provider apiKey channel.
	// Workers AI 通过标准 provider apiKey 通道使用 API key。
	return {
		name: "Cloudflare API key",
		login: async (callbacks) => {
			const key = await callbacks.prompt({ type: "secret", message: "Enter Cloudflare API key" });
			const accountId = await callbacks.prompt({ type: "text", message: "Enter Cloudflare account ID" });
			return { type: "api_key", key, env: { CLOUDFLARE_ACCOUNT_ID: accountId } };
		},
		resolve: async ({ model, ctx, credential }) => {
			const resolved = await resolveCloudflareEnv("workers-ai", model, ctx, credential);
			if (!resolved) return undefined;
			return {
				auth: { apiKey: resolved.apiKey, baseUrl: resolved.baseUrl },
				env: resolved.env,
				source: resolved.source,
			};
		},
	};
}

export function cloudflareAIGatewayAuth(): ApiKeyAuth {
	// AI Gateway authenticates with its dedicated header and explicitly removes incompatible defaults.
	// AI Gateway 使用专用 header 认证，并显式移除不兼容的默认认证 header。
	return {
		name: "Cloudflare API key",
		login: async (callbacks) => {
			const key = await callbacks.prompt({ type: "secret", message: "Enter Cloudflare API key" });
			const accountId = await callbacks.prompt({ type: "text", message: "Enter Cloudflare account ID" });
			const gatewayId = await callbacks.prompt({ type: "text", message: "Enter Cloudflare AI Gateway ID" });
			return {
				type: "api_key",
				key,
				env: { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_GATEWAY_ID: gatewayId },
			};
		},
		resolve: async ({ model, ctx, credential }) => {
			const resolved = await resolveCloudflareEnv("ai-gateway", model, ctx, credential);
			if (!resolved) return undefined;
			return {
				auth: {
					// Null header values instruct the shared client layer to suppress model-provided auth headers.
					// null header 值通知共享客户端层抑制模型预设的认证 header。
					headers: {
						"cf-aig-authorization": `Bearer ${resolved.apiKey}`,
						Authorization: null,
						"x-api-key": null,
					},
					baseUrl: resolved.baseUrl,
				},
				env: resolved.env,
				source: resolved.source,
			};
		},
	};
}
