/**
 * PKCE utilities using Web Crypto API.
 * Works in both Node.js 20+ and browsers.
 */
/**
 * 基于 Web Crypto API 的 PKCE 工具，可同时用于 Node.js 20+ 和浏览器环境。
 */

/**
 * Encode bytes as base64url string.
 */
/**
 * 将字节编码为 base64url 字符串。
 */
function base64urlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * Generate PKCE code verifier and challenge.
 * Uses Web Crypto API for cross-platform compatibility.
 */
/**
 * 生成 PKCE code verifier 和 challenge，并通过 Web Crypto API 保持跨平台兼容性。
 */
export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	// Generate random verifier
	// 生成具备足够熵的随机 verifier。
	const verifierBytes = new Uint8Array(32);
	crypto.getRandomValues(verifierBytes);
	const verifier = base64urlEncode(verifierBytes);

	// Compute SHA-256 challenge
	// 按 PKCE 约定计算 verifier 的 SHA-256 challenge。
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const challenge = base64urlEncode(new Uint8Array(hashBuffer));

	return { verifier, challenge };
}
