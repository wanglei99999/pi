import type { SettingsManager } from "./settings-manager.ts";

function isTruthyEnvFlag(value: string | undefined): boolean {
	// Only the documented affirmative forms enable telemetry; every other defined value acts as an explicit disable.
	// 仅文档约定的肯定形式会启用 telemetry；其他已定义值均表示显式禁用。
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

// This side-effect-free policy check runs before event or client work; callers own event boundaries and failure isolation.
// 此无副作用策略检查在事件或客户端工作前执行；事件边界与失败隔离由调用方负责。
export function isInstallTelemetryEnabled(
	settingsManager: SettingsManager,
	telemetryEnv: string | undefined = process.env.PI_TELEMETRY,
): boolean {
	// Environment presence overrides persisted settings, allowing process-level opt-out without rewriting configuration.
	// 环境变量只要存在便覆盖持久化设置，从而无需改写配置即可按进程禁用。
	return telemetryEnv !== undefined ? isTruthyEnvFlag(telemetryEnv) : settingsManager.getEnableInstallTelemetry();
}
