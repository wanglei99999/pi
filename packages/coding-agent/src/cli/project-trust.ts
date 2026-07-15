import chalk from "chalk";
import type { ProjectTrustContext } from "../core/extensions/types.ts";
import type { AppMode } from "../core/project-trust.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { showStartupInput, showStartupSelector } from "./startup-ui.ts";

export function createProjectTrustContext(options: {
	cwd: string;
	mode: AppMode;
	settingsManager: SettingsManager;
	hasUI: boolean;
}): ProjectTrustContext {
	// Adapt CLI modes to the extension-facing trust context without granting UI access implicitly.
	// 将 CLI 模式适配为扩展可见的信任上下文，但不会隐式授予 UI 访问能力。
	return {
		cwd: options.cwd,
		mode: options.mode === "interactive" ? "tui" : options.mode,
		hasUI: options.hasUI,
		ui: {
			select: async (title, selectOptions) => {
				// Trust selection is available only in an interactive TUI; non-interactive callers receive no choice.
				// 信任选项仅在交互式 TUI 中可用；非交互调用方不会获得选择结果。
				if (!options.hasUI) {
					return undefined;
				}
				if (options.mode !== "interactive") {
					return undefined;
				}
				return showStartupSelector(
					// The startup selector owns terminal setup and teardown; this adapter only maps values.
					// 启动选择器负责终端的启动与清理；此适配层只映射选项值。
					options.settingsManager,
					title,
					selectOptions.map((option) => ({ label: option, value: option })),
				);
			},
			confirm: async (title, message) => {
				// Returning false on unavailable or cancelled UI keeps trust prompts fail-closed.
				// UI 不可用或取消时返回 false，使信任提示保持默认拒绝。
				if (!options.hasUI) {
					return false;
				}
				if (options.mode !== "interactive") {
					return false;
				}
				return (
					(await showStartupSelector(options.settingsManager, `${title}\n${message}`, [
						{ label: "Yes", value: true },
						{ label: "No", value: false },
					])) ?? false
				);
			},
			input: async (title, placeholder) => {
				// Input results are transient; persistence remains the responsibility of the trust decision owner.
				// 输入结果仅为临时值；持久化仍由信任决策的所有者负责。
				if (!options.hasUI) {
					return undefined;
				}
				if (options.mode !== "interactive") {
					return undefined;
				}
				return showStartupInput(options.settingsManager, title, placeholder);
			},
			notify: (message, type = "info") => {
				if (options.mode !== "interactive") {
					const color = type === "error" ? chalk.red : type === "warning" ? chalk.yellow : chalk.cyan;
					console.error(color(message));
				}
			},
		},
	};
}
