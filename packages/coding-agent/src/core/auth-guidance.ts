import { join } from "node:path";
import { getDocsPath } from "../config.ts";

const UNKNOWN_PROVIDER = "unknown";

export function getProviderLoginHelp(): string {
	// Keep authentication guidance centralized so every missing-credential path points to the same login and docs flow.
	// 集中维护认证指导，使所有缺少凭证的路径都指向同一套 login 与 docs 流程。
	return [
		"Use /login to log into a provider via OAuth or API key. See:",
		`  ${join(getDocsPath(), "providers.md")}`,
		`  ${join(getDocsPath(), "models.md")}`,
	].join("\n");
}

export function formatNoModelsAvailableMessage(): string {
	// This state means discovery produced no usable models, not merely that selection is missing.
	// 此状态表示 discovery 未得到可用 models，而不只是尚未选择 model。
	return `No models available. ${getProviderLoginHelp()}`;
}

export function formatNoModelSelectedMessage(): string {
	// Selection guidance is appended only after authentication help because a model may not exist until login succeeds.
	// 先提供认证帮助，再追加选择指导，因为 login 成功前可能根本没有可选 model。
	return `No model selected.\n\n${getProviderLoginHelp()}\n\nThen use /model to select a model.`;
}

export function formatNoApiKeyFoundMessage(provider: string): string {
	// Treat the sentinel provider specially so the internal placeholder is never shown as a user-facing provider name.
	// 对 sentinel provider 做特殊处理，避免将内部占位值显示成面向用户的 provider 名称。
	const providerDisplay = provider === UNKNOWN_PROVIDER ? "the selected model" : provider;
	// This helper only formats guidance; provider detection and credential lookup remain caller responsibilities.
	// 此 helper 只负责格式化指导；provider 检测与凭证查找仍由调用方负责。
	return `No API key found for ${providerDisplay}.\n\n${getProviderLoginHelp()}`;
}
