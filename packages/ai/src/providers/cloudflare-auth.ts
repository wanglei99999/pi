import type { ApiKeyAuth, ApiKeyCredential, AuthContext } from "../auth/types.ts";
import type { ProviderEnv } from "../types.ts";

const CLOUDFLARE_API_KEY = "CLOUDFLARE_API_KEY";
const CLOUDFLARE_ACCOUNT_ID = "CLOUDFLARE_ACCOUNT_ID";
const CLOUDFLARE_GATEWAY_ID = "CLOUDFLARE_GATEWAY_ID";

type CloudflareAuthKind = "workers-ai" | "ai-gateway";

async function resolveValue(
	name: string,
	ctx: AuthContext,
	credential: ApiKeyCredential | undefined,
): Promise<string | undefined> {
	// Per-field merge: prefer the credential value, fall back to ambient env.
	// A credential carrying only the API key must still pick up the account /
	// gateway id from the environment.
	const fromCredential = credential
		? name === CLOUDFLARE_API_KEY
			? credential.key
			: credential.env?.[name]
		: undefined;
	return fromCredential ?? (await ctx.env(name));
}

async function resolveCloudflareEnv(
	kind: CloudflareAuthKind,
	ctx: AuthContext,
	credential: ApiKeyCredential | undefined,
): Promise<{ apiKey: string; env: ProviderEnv; source: string } | undefined> {
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
		source: credential ? "stored credential" : CLOUDFLARE_API_KEY,
	};
}

export function cloudflareWorkersAIAuth(): ApiKeyAuth {
	// Workers AI uses the API key through the normal provider apiKey channel.
	// Workers AI 通过标准 provider apiKey 通道使用 API key。
	return {
		name: "Cloudflare API key",
		login: async (interaction) => {
			const key = await interaction.prompt({ type: "secret", message: "Enter Cloudflare API key" });
			const accountId = await interaction.prompt({ type: "text", message: "Enter Cloudflare account ID" });
			return { type: "api_key", key, env: { CLOUDFLARE_ACCOUNT_ID: accountId } };
		},
		resolve: async ({ ctx, credential }) => {
			const resolved = await resolveCloudflareEnv("workers-ai", ctx, credential);
			if (!resolved) return undefined;
			return {
				auth: { apiKey: resolved.apiKey },
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
		login: async (interaction) => {
			const key = await interaction.prompt({ type: "secret", message: "Enter Cloudflare API key" });
			const accountId = await interaction.prompt({ type: "text", message: "Enter Cloudflare account ID" });
			const gatewayId = await interaction.prompt({ type: "text", message: "Enter Cloudflare AI Gateway ID" });
			return {
				type: "api_key",
				key,
				env: { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_GATEWAY_ID: gatewayId },
			};
		},
		resolve: async ({ ctx, credential }) => {
			const resolved = await resolveCloudflareEnv("ai-gateway", ctx, credential);
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
				},
				env: resolved.env,
				source: resolved.source,
			};
		},
	};
}
