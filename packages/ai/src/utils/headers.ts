import type { ProviderHeaders } from "../types.ts";

export function headersToRecord(headers: Headers): Record<string, string> {
	// Snapshot platform Headers into plain data before passing response metadata across package boundaries.
	// 将平台 Headers 快照为普通数据，再跨包传递响应元数据。
	const result: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		result[key] = value;
	}
	return result;
}

export function providerHeadersToRecord(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
	// Null values mean “suppress this header”; omit them instead of stringifying null.
	// null 值表示“抑制该 header”，因此直接省略而不是字符串化。
	if (!headers) return undefined;
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (value !== null) result[key] = value;
	}
	// Returning undefined for an empty result avoids installing an unnecessary defaultHeaders object.
	// 空结果返回 undefined，避免创建无意义的 defaultHeaders 对象。
	return Object.keys(result).length > 0 ? result : undefined;
}
