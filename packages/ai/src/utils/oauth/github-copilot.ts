/**
 * GitHub Copilot OAuth flow
 * GitHub device flow 先获取长期 GitHub access token，再交换成短期 Copilot token；两者分别存入 refresh 与 access 字段。
 */

import type { OAuthAuth, OAuthCredential } from "../../auth/types.ts";
import { GITHUB_COPILOT_MODELS } from "../../providers/github-copilot.models.ts";
import type { Api, Model } from "../../types.ts";
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";
import type { OAuthCredentials, OAuthDeviceCodeInfo, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

type CopilotCredentials = OAuthCredentials & {
	enterpriseUrl?: string;
	availableModelIds: string[];
};

const decode = (s: string) => atob(s);
const CLIENT_ID = decode("SXYxLmI1MDdhMDhjODdlY2ZlOTg=");

const COPILOT_HEADERS = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
} as const;
const COPILOT_API_VERSION = "2026-06-01";

type DeviceCodeResponse = {
	device_code: string;
	user_code: string;
	verification_uri: string;
	interval?: number;
	expires_in: number;
};

type DeviceTokenSuccessResponse = {
	access_token: string;
	token_type?: string;
	scope?: string;
};

type DeviceTokenErrorResponse = {
	error: string;
	error_description?: string;
	interval?: number;
};

export function normalizeDomain(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	try {
		const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
		return url.hostname;
	} catch {
		return null;
	}
}

function getUrls(domain: string): {
	deviceCodeUrl: string;
	accessTokenUrl: string;
	copilotTokenUrl: string;
} {
	return {
		deviceCodeUrl: `https://${domain}/login/device/code`,
		accessTokenUrl: `https://${domain}/login/oauth/access_token`,
		copilotTokenUrl: `https://api.${domain}/copilot_internal/v2/token`,
	};
}

/**
 * Parse the proxy-ep from a Copilot token and convert to API base URL.
 * Token format: tid=...;exp=...;proxy-ep=proxy.individual.githubcopilot.com;...
 * Returns API URL like https://api.individual.githubcopilot.com
 * proxy-ep 由账户授权结果决定，应优先于静态 enterprise fallback，以便请求路由到正确的 Copilot 集群。
 */
function getBaseUrlFromToken(token: string): string | null {
	const match = token.match(/proxy-ep=([^;]+)/);
	if (!match) return null;
	const proxyHost = match[1];
	// Convert proxy.xxx to api.xxx
	const apiHost = proxyHost.replace(/^proxy\./, "api.");
	return `https://${apiHost}`;
}

export function getGitHubCopilotBaseUrl(token?: string, enterpriseDomain?: string): string {
	// If we have a token, extract the base URL from proxy-ep
	// token 内的账户级路由最准确；只有旧 token 或解析失败时才回退到域名推导。
	if (token) {
		const urlFromToken = getBaseUrlFromToken(token);
		if (urlFromToken) return urlFromToken;
	}
	// Fallback for enterprise or if token parsing fails
	// Enterprise 使用组织域名端点，github.com 则落到个人 Copilot 公共 API。
	if (enterpriseDomain) return `https://copilot-api.${enterpriseDomain}`;
	return "https://api.individual.githubcopilot.com";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function isSelectableCopilotModel(item: Record<string, unknown>): boolean {
	const policy = asRecord(item.policy);
	const capabilities = asRecord(item.capabilities);
	const supports = asRecord(capabilities?.supports);
	return item.model_picker_enabled === true && policy?.state !== "disabled" && supports?.tool_calls !== false;
}

function parseAvailableCopilotModelIds(raw: unknown): string[] {
	const data = asRecord(raw)?.data;
	if (!Array.isArray(data)) {
		throw new Error("Invalid Copilot models response");
	}

	const ids: string[] = [];
	for (const rawItem of data) {
		const item = asRecord(rawItem);
		const id = item?.id;
		if (typeof id === "string" && item && isSelectableCopilotModel(item)) {
			ids.push(id);
		}
	}
	return ids;
}

async function fetchAvailableGitHubCopilotModelIds(copilotToken: string, enterpriseDomain?: string): Promise<string[]> {
	// 可用模型列表属于账户状态，使用短期 Copilot token 与官方客户端标识请求，并设置短超时避免刷新长期阻塞。
	const baseUrl = getGitHubCopilotBaseUrl(copilotToken, enterpriseDomain);
	const raw = await fetchJson(`${baseUrl}/models`, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${copilotToken}`,
			...COPILOT_HEADERS,
			"X-GitHub-Api-Version": COPILOT_API_VERSION,
		},
		signal: AbortSignal.timeout(5000),
	});
	return parseAvailableCopilotModelIds(raw);
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
	const response = await fetch(url, init);
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`${response.status} ${response.statusText}: ${text}`);
	}
	return response.json();
}

async function startDeviceFlow(domain: string): Promise<DeviceCodeResponse> {
	const urls = getUrls(domain);
	const data = await fetchJson(urls.deviceCodeUrl, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
			"User-Agent": "GitHubCopilotChat/0.35.0",
		},
		body: new URLSearchParams({
			client_id: CLIENT_ID,
			scope: "read:user",
		}),
	});

	if (!data || typeof data !== "object") {
		throw new Error("Invalid device code response");
	}

	const deviceCode = (data as Record<string, unknown>).device_code;
	const userCode = (data as Record<string, unknown>).user_code;
	const verificationUri = (data as Record<string, unknown>).verification_uri;
	const interval = (data as Record<string, unknown>).interval;
	const expiresIn = (data as Record<string, unknown>).expires_in;

	if (
		typeof deviceCode !== "string" ||
		typeof userCode !== "string" ||
		typeof verificationUri !== "string" ||
		(interval !== undefined && typeof interval !== "number") ||
		typeof expiresIn !== "number"
	) {
		throw new Error("Invalid device code response fields");
	}

	// The verification URI is opened in the user's browser and to prevent `open` from
	// opening an executable or similar, we force it to be a URL.
	// 浏览器打开动作是外部副作用，必须先限制为 http/https URL，不能信任服务端返回的任意 scheme。
	let parsedUri: URL;
	try {
		parsedUri = new URL(verificationUri);
	} catch {
		throw new Error("Untrusted verification_uri in device code response");
	}
	if (parsedUri.protocol !== "https:" && parsedUri.protocol !== "http:") {
		throw new Error("Untrusted verification_uri in device code response");
	}

	return {
		device_code: deviceCode,
		user_code: userCode,
		verification_uri: parsedUri.href,
		interval,
		expires_in: expiresIn,
	};
}

async function pollForGitHubAccessToken(
	domain: string,
	device: DeviceCodeResponse,
	signal?: AbortSignal,
): Promise<string> {
	const urls = getUrls(domain);
	return pollOAuthDeviceCodeFlow<string>({
		intervalSeconds: device.interval,
		expiresInSeconds: device.expires_in,
		waitBeforeFirstPoll: true,
		// 遵循服务端 interval，首次也先等待；signal、过期时间和 slow_down 调整由通用轮询器统一处理。
		signal,
		poll: async () => {
			const raw = await fetchJson(urls.accessTokenUrl, {
				method: "POST",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/x-www-form-urlencoded",
					"User-Agent": "GitHubCopilotChat/0.35.0",
				},
				body: new URLSearchParams({
					client_id: CLIENT_ID,
					device_code: device.device_code,
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				}),
			});

			if (raw && typeof raw === "object" && typeof (raw as DeviceTokenSuccessResponse).access_token === "string") {
				return { status: "complete", value: (raw as DeviceTokenSuccessResponse).access_token };
			}

			if (raw && typeof raw === "object" && typeof (raw as DeviceTokenErrorResponse).error === "string") {
				const { error, error_description: description, interval } = raw as DeviceTokenErrorResponse;
				if (error === "authorization_pending") {
					// 用户尚未在浏览器确认，保持原轮询间隔继续等待。
					return { status: "pending" };
				}

				if (error === "slow_down") {
					// GitHub 可要求降低轮询频率；优先采用响应中给出的新间隔。
					return { status: "slow_down", intervalSeconds: typeof interval === "number" ? interval : undefined };
				}

				const descriptionSuffix = description ? `: ${description}` : "";
				return { status: "failed", message: `Device flow failed: ${error}${descriptionSuffix}` };
			}

			return { status: "failed", message: "Invalid device token response" };
		},
	});
}

async function refreshGitHubCopilotAccessToken(
	refreshToken: string,
	enterpriseDomain?: string,
): Promise<OAuthCredentials> {
	const domain = enterpriseDomain || "github.com";
	const urls = getUrls(domain);

	const raw = await fetchJson(urls.copilotTokenUrl, {
		// 此处 refreshToken 实际是 GitHub access token，用它向 copilot_internal 交换短期服务 token。
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${refreshToken}`,
			...COPILOT_HEADERS,
		},
	});

	if (!raw || typeof raw !== "object") {
		throw new Error("Invalid Copilot token response");
	}

	const token = (raw as Record<string, unknown>).token;
	const expiresAt = (raw as Record<string, unknown>).expires_at;

	if (typeof token !== "string" || typeof expiresAt !== "number") {
		throw new Error("Invalid Copilot token response fields");
	}

	return {
		refresh: refreshToken,
		access: token,
		// 提前五分钟视为过期，为时钟偏差和在途请求留出刷新余量。
		expires: expiresAt * 1000 - 5 * 60 * 1000,
		enterpriseUrl: enterpriseDomain,
	};
}

/**
 * Refresh GitHub Copilot token
 * 每次交换新 Copilot token 后同步刷新账户可选模型缓存，确保模型列表与当前授权策略一致。
 */
export async function refreshGitHubCopilotToken(
	refreshToken: string,
	enterpriseDomain?: string,
): Promise<OAuthCredentials> {
	const credentials = await refreshGitHubCopilotAccessToken(refreshToken, enterpriseDomain);
	return {
		...credentials,
		availableModelIds: await fetchAvailableGitHubCopilotModelIds(credentials.access, enterpriseDomain),
	};
}

/**
 * Enable a model for the user's GitHub Copilot account.
 * This is required for some models (like Claude, Grok) before they can be used.
 * policy 请求失败只表示该模型未启用，不应使整体登录流程因单个可选模型中断。
 */
async function enableGitHubCopilotModel(token: string, modelId: string, enterpriseDomain?: string): Promise<boolean> {
	const baseUrl = getGitHubCopilotBaseUrl(token, enterpriseDomain);
	const url = `${baseUrl}/models/${modelId}/policy`;

	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
				...COPILOT_HEADERS,
				"openai-intent": "chat-policy",
				"x-interaction-type": "chat-policy",
			},
			body: JSON.stringify({ state: "enabled" }),
		});
		return response.ok;
	} catch {
		return false;
	}
}

/**
 * Enable all known GitHub Copilot models that may require policy acceptance.
 * Called after successful login to ensure all models are available.
 * 各模型并行尝试启用，随后仍以 /models 返回的实际可选集合为准。
 */
async function enableAllGitHubCopilotModels(
	token: string,
	enterpriseDomain?: string,
	onProgress?: (model: string, success: boolean) => void,
): Promise<void> {
	const models = Object.values(GITHUB_COPILOT_MODELS);
	await Promise.all(
		models.map(async (model) => {
			const success = await enableGitHubCopilotModel(token, model.id, enterpriseDomain);
			onProgress?.(model.id, success);
		}),
	);
}

/**
 * Login with GitHub Copilot OAuth (device code flow)
 *
 * @param options.onDeviceCode - Callback with URL and user code
 * @param options.onPrompt - Callback to prompt user for input
 * @param options.onProgress - Optional progress callback
 * @param options.signal - Optional AbortSignal for cancellation
 *
 * 取消信号在用户输入后和设备码轮询期间生效；获得 GitHub token 后再交换 Copilot token 并建立模型可用性缓存。
 */
export async function loginGitHubCopilot(options: {
	onDeviceCode: (info: OAuthDeviceCodeInfo) => void;
	onPrompt: (prompt: { message: string; placeholder?: string; allowEmpty?: boolean }) => Promise<string>;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}): Promise<OAuthCredentials> {
	const input = await options.onPrompt({
		message: "GitHub Enterprise URL/domain (blank for github.com)",
		placeholder: "company.ghe.com",
		allowEmpty: true,
	});

	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}

	const trimmed = input.trim();
	const enterpriseDomain = normalizeDomain(input);
	if (trimmed && !enterpriseDomain) {
		throw new Error("Invalid GitHub Enterprise URL/domain");
	}
	const domain = enterpriseDomain || "github.com";

	const device = await startDeviceFlow(domain);
	options.onDeviceCode({
		userCode: device.user_code,
		verificationUri: device.verification_uri,
		intervalSeconds: device.interval,
		expiresInSeconds: device.expires_in,
	});

	const githubAccessToken = await pollForGitHubAccessToken(domain, device, options.signal);
	const credentials = await refreshGitHubCopilotAccessToken(githubAccessToken, enterpriseDomain ?? undefined);

	// Enable all models after successful login
	// 先尝试接受模型策略，再查询列表，避免刚启用的模型遗漏在持久化凭据中。
	options.onProgress?.("Enabling models...");
	await enableAllGitHubCopilotModels(credentials.access, enterpriseDomain ?? undefined);

	// Fetch availability after policy enable so newly enabled models are included,
	// while unavailable models are still filtered out.
	// availableModelIds 是账户快照，用于后续从生成模型目录中过滤当前账户不可选项。
	return {
		...credentials,
		availableModelIds: await fetchAvailableGitHubCopilotModelIds(credentials.access, enterpriseDomain ?? undefined),
	};
}

function copilotEnterpriseDomain(credential: OAuthCredential): string | undefined {
	const enterpriseUrl = credential.enterpriseUrl;
	if (typeof enterpriseUrl !== "string" || !enterpriseUrl) return undefined;
	return normalizeDomain(enterpriseUrl) ?? undefined;
}

export const githubCopilotOAuth: OAuthAuth = {
	name: "GitHub Copilot",

	async login(callbacks) {
		const credentials = await loginGitHubCopilot({
			onDeviceCode: (info) => callbacks.notify({ type: "device_code", ...info }),
			onPrompt: (prompt) =>
				callbacks.prompt({ type: "text", message: prompt.message, placeholder: prompt.placeholder }),
			onProgress: (message) => callbacks.notify({ type: "progress", message }),
			signal: callbacks.signal,
		});
		return { ...credentials, type: "oauth" };
	},

	async refresh(credential) {
		return {
			...(await refreshGitHubCopilotToken(credential.refresh, copilotEnterpriseDomain(credential))),
			type: "oauth",
		};
	},

	/**
	 * Per-credential baseUrl from the token's proxy endpoint replaces the old `modifyModels` rewriting.
	 * 每次请求鉴权都从当前凭据推导 baseUrl，避免模型对象持有刷新前 token 对应的旧路由。
	 */
	async toAuth(credential) {
		return {
			apiKey: credential.access,
			baseUrl: getGitHubCopilotBaseUrl(credential.access, copilotEnterpriseDomain(credential)),
		};
	},
};

export const githubCopilotOAuthProvider: OAuthProviderInterface = {
	id: "github-copilot",
	name: "GitHub Copilot",

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginGitHubCopilot({
			onDeviceCode: callbacks.onDeviceCode,
			onPrompt: callbacks.onPrompt,
			onProgress: callbacks.onProgress,
			signal: callbacks.signal,
		});
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		const creds = credentials as CopilotCredentials;
		return refreshGitHubCopilotToken(creds.refresh, creds.enterpriseUrl);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},

	modifyModels(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[] {
		const creds = credentials as CopilotCredentials;
		const domain = creds.enterpriseUrl ? (normalizeDomain(creds.enterpriseUrl) ?? undefined) : undefined;
		const baseUrl = getGitHubCopilotBaseUrl(creds.access, domain);
		// Older stored Pi auth entries do not have account-specific model IDs yet;
		// keep their existing generated-catalog behavior until the next refresh/login.
		// 兼容旧凭据时不做模型过滤；下一次 refresh/login 会补齐 availableModelIds 并启用精确过滤。
		const availableModelIds = "availableModelIds" in creds ? new Set(creds.availableModelIds) : undefined;

		return models.flatMap((m) => {
			if (m.provider !== "github-copilot") return [m];
			if (availableModelIds && !availableModelIds.has(m.id)) return [];
			return [{ ...m, baseUrl }];
		});
	},
};
