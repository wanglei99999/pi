import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import type { SettingsManager } from "./settings-manager.ts";
import { isInstallTelemetryEnabled } from "./telemetry.ts";

const OPENROUTER_HOST = "openrouter.ai";
const NVIDIA_NIM_HOST = "integrate.api.nvidia.com";
const CLOUDFLARE_API_HOST = "api.cloudflare.com";
const CLOUDFLARE_AI_GATEWAY_HOST = "gateway.ai.cloudflare.com";
const OPENCODE_HOST = "opencode.ai";

function matchesHost(baseUrl: string, expectedHost: string): boolean {
	// Parse the URL and compare the exact hostname; malformed URLs never qualify for host-based attribution.
	// 解析 URL 后精确比较 hostname；格式无效的 URL 不会获得基于 host 的归属标签。
	try {
		return new URL(baseUrl).hostname === expectedHost;
	} catch {
		return false;
	}
}

function isOpenRouterModel(model: Model<Api>): boolean {
	// Provider attribution may come from the declared provider ID or from a compatible endpoint URL.
	// provider 归属既可来自声明的 provider ID，也可来自兼容 endpoint URL。
	return model.provider === "openrouter" || model.baseUrl.includes(OPENROUTER_HOST);
}

function isNvidiaNimModel(model: Model<Api>): boolean {
	return model.provider === "nvidia" || matchesHost(model.baseUrl, NVIDIA_NIM_HOST);
}

function isCloudflareModel(model: Model<Api>): boolean {
	return (
		model.provider === "cloudflare-workers-ai" ||
		model.provider === "cloudflare-ai-gateway" ||
		matchesHost(model.baseUrl, CLOUDFLARE_API_HOST) ||
		matchesHost(model.baseUrl, CLOUDFLARE_AI_GATEWAY_HOST)
	);
}

function getDefaultAttributionHeaders(
	model: Model<Api>,
	settingsManager: SettingsManager,
): Record<string, string> | undefined {
	// Install telemetry controls product attribution headers, but does not govern provider-specific session headers.
	// install telemetry 控制产品归属 headers，但不控制 provider-specific session headers。
	if (!isInstallTelemetryEnabled(settingsManager)) {
		return undefined;
	}

	if (isOpenRouterModel(model)) {
		return {
			"HTTP-Referer": "https://pi.dev",
			"X-OpenRouter-Title": "pi",
			"X-OpenRouter-Categories": "cli-agent",
		};
	}

	if (isNvidiaNimModel(model)) {
		return {
			"X-BILLING-INVOKE-ORIGIN": "Pi",
		};
	}

	if (isCloudflareModel(model)) {
		return {
			"User-Agent": "pi-coding-agent",
		};
	}

	return undefined;
}

function getSessionHeaders(model: Model<Api>, sessionId: string | undefined): Record<string, string> | undefined {
	// Session attribution is emitted only when both a sessionId and an OpenCode-compatible provider are present.
	// 仅当 sessionId 与 OpenCode-compatible provider 同时存在时才生成 session 归属信息。
	if (!sessionId) return undefined;
	if (
		model.provider !== "opencode" &&
		model.provider !== "opencode-go" &&
		!matchesHost(model.baseUrl, OPENCODE_HOST)
	) {
		return undefined;
	}
	return { "x-opencode-session": sessionId, "x-opencode-client": "pi" };
}

export function mergeProviderAttributionHeaders(
	model: Model<Api>,
	settingsManager: SettingsManager,
	sessionId: string | undefined,
	...headerSources: Array<ProviderHeaders | undefined>
): ProviderHeaders | undefined {
	// Merge from lowest to highest precedence: session defaults, telemetry defaults, then caller sources.
	// 按优先级由低到高合并：session defaults、telemetry defaults，最后是调用方 sources。
	const merged: ProviderHeaders = {
		...getSessionHeaders(model, sessionId),
		...getDefaultAttributionHeaders(model, settingsManager),
	};

	for (const headers of headerSources) {
		if (headers) {
			// Exact duplicate keys use last-writer-wins; header name casing is not normalized here.
			// 完全相同的重复 key 采用最后写入者优先；此处不会规范化 header name casing。
			Object.assign(merged, headers);
		}
	}

	// Preserve the optional contract by returning undefined instead of an empty header object.
	// 没有任何 header 时返回 undefined，而不是空对象，以保持可选返回约定。
	return Object.keys(merged).length > 0 ? merged : undefined;
}
