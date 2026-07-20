/**
 * xAI OAuth device-code flow.
 * xAI 的 OAuth 设备码流程：只有 device-code 一条通道（无本地回调服务器），
 * 因此不依赖 node:http，流程为 请求设备码 → 展示 userCode/URL → 轮询令牌端点。
 */

import type { AuthInteraction, OAuthAuth, OAuthCredential } from "../types.ts";
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";

const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
// Refresh slightly before the reported expiry to avoid using a token that dies mid-request.
// 把过期时间提前 5 分钟记账，避免拿着"还差几秒过期"的令牌发请求、死在半路。
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;

type JsonObject = Record<string, unknown>;

type OAuthHttpResponse = {
	ok: boolean;
	status: number;
	body: JsonObject;
};

type XaiDeviceCode = {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete?: string;
	intervalSeconds?: number;
	expiresInSeconds: number;
};

function requiredString(body: JsonObject, field: string): string {
	const value = body[field];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Invalid xAI OAuth response field: ${field}`);
	}
	return value;
}

function positiveNumber(body: JsonObject, field: string): number {
	const value = body[field];
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`Invalid xAI OAuth response field: ${field}`);
	}
	return value;
}

// The verification URI is opened in the user's browser; force it to be an https URL
// so a malicious response cannot make `open` launch something else.
// 该 URI 会交给系统浏览器打开，强制 https 防止恶意响应借 `open` 执行其他协议（如 file:）。
function validateVerificationUri(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("Untrusted verification URI in xAI OAuth response");
	}
	if (url.protocol !== "https:") {
		throw new Error("Untrusted verification URI in xAI OAuth response");
	}
	return url.href;
}

async function postForm(url: string, fields: Record<string, string>, signal?: AbortSignal): Promise<OAuthHttpResponse> {
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams(fields),
			signal,
		});
	} catch (error) {
		if (signal?.aborted) {
			throw new Error("Login cancelled");
		}
		throw error;
	}

	let body: JsonObject;
	try {
		const parsed = (await response.json()) as unknown;
		body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : {};
	} catch {
		if (signal?.aborted) {
			throw new Error("Login cancelled");
		}
		throw new Error(`xAI OAuth returned invalid JSON (HTTP ${response.status})`);
	}
	return {
		ok: response.ok,
		status: response.status,
		body,
	};
}

function requestFailure(action: string, response: OAuthHttpResponse): Error {
	const error = typeof response.body.error === "string" ? response.body.error : undefined;
	const description =
		typeof response.body.error_description === "string" ? response.body.error_description : undefined;
	const detail = [error, description].filter(Boolean).join(": ");
	return new Error(`xAI OAuth ${action} failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
}

function parseDeviceCode(body: JsonObject): XaiDeviceCode {
	// RFC 8628 allows interval 0 (no minimum wait); fall back to the poller's
	// default instead of failing on non-positive or malformed values.
	// RFC 8628 允许 interval 为 0；非正数或畸形值不报错，交给轮询器用默认间隔。
	const interval = body.interval;
	const intervalSeconds =
		typeof interval === "number" && Number.isFinite(interval) && interval > 0 ? interval : undefined;
	const verificationUriComplete =
		typeof body.verification_uri_complete === "string" && body.verification_uri_complete.length > 0
			? validateVerificationUri(body.verification_uri_complete)
			: undefined;
	return {
		deviceCode: requiredString(body, "device_code"),
		userCode: requiredString(body, "user_code"),
		verificationUri: validateVerificationUri(requiredString(body, "verification_uri")),
		verificationUriComplete,
		intervalSeconds,
		expiresInSeconds: positiveNumber(body, "expires_in"),
	};
}

function credentialsFromTokenResponse(body: JsonObject, previousRefreshToken?: string): OAuthCredential {
	const access = requiredString(body, "access_token");
	// xAI may omit refresh_token on refresh when the token is not rotated.
	// 刷新时若令牌未轮换，响应可能不带 refresh_token，此时沿用旧的刷新令牌。
	const refresh =
		body.refresh_token === undefined && previousRefreshToken
			? previousRefreshToken
			: requiredString(body, "refresh_token");
	const expiresInSeconds =
		body.expires_in === undefined ? DEFAULT_TOKEN_LIFETIME_SECONDS : positiveNumber(body, "expires_in");
	return {
		type: "oauth",
		access,
		refresh,
		expires: Date.now() + expiresInSeconds * 1000 - REFRESH_SKEW_MS,
	};
}

async function requestDeviceCode(signal?: AbortSignal): Promise<XaiDeviceCode> {
	const response = await postForm(
		XAI_DEVICE_CODE_URL,
		{
			client_id: XAI_CLIENT_ID,
			scope: XAI_SCOPE,
			referrer: "pi",
		},
		signal,
	);
	if (!response.ok) {
		throw requestFailure("device authorization", response);
	}
	return parseDeviceCode(response.body);
}

async function pollForTokens(device: XaiDeviceCode, signal?: AbortSignal): Promise<OAuthCredential> {
	return pollOAuthDeviceCodeFlow<OAuthCredential>({
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
		waitBeforeFirstPoll: true,
		signal,
		poll: async () => {
			const response = await postForm(
				XAI_TOKEN_URL,
				{
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
					client_id: XAI_CLIENT_ID,
					device_code: device.deviceCode,
				},
				signal,
			);

			if (response.ok) {
				return { status: "complete", value: credentialsFromTokenResponse(response.body) };
			}

			const error = response.body.error;
			if (error === "authorization_pending") {
				return { status: "pending" };
			}
			if (error === "slow_down") {
				const interval = response.body.interval;
				return { status: "slow_down", intervalSeconds: typeof interval === "number" ? interval : undefined };
			}
			if (error === "access_denied" || error === "authorization_denied") {
				return { status: "failed", message: "xAI device authorization was denied" };
			}
			if (error === "expired_token") {
				return { status: "failed", message: "xAI device code expired" };
			}
			return { status: "failed", message: requestFailure("device token polling", response).message };
		},
	});
}

async function loginXai(interaction: AuthInteraction): Promise<OAuthCredential> {
	const device = await requestDeviceCode(interaction.signal);
	interaction.notify({
		type: "device_code",
		userCode: device.userCode,
		verificationUri: device.verificationUriComplete ?? device.verificationUri,
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
	});
	return pollForTokens(device, interaction.signal);
}

async function refreshXaiToken(refreshToken: string, signal?: AbortSignal): Promise<OAuthCredential> {
	const response = await postForm(
		XAI_TOKEN_URL,
		{
			grant_type: "refresh_token",
			client_id: XAI_CLIENT_ID,
			refresh_token: refreshToken,
		},
		signal,
	);
	if (!response.ok) {
		throw requestFailure("token refresh", response);
	}
	return credentialsFromTokenResponse(response.body, refreshToken);
}

// OAuthAuth 三件套的最小实现：login 走设备码，refresh 换新令牌，
// toAuth 直接把访问令牌当 API key 用（xAI 网关接受 Bearer access token）。
export const xaiOAuth: OAuthAuth = {
	name: "xAI (Grok/X subscription)",
	loginLabel: "Sign in with SuperGrok or X Premium",
	login: loginXai,
	refresh: (credential, signal) => refreshXaiToken(credential.refresh, signal),

	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};
