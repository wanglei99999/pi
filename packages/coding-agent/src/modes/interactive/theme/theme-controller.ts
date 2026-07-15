import type { TUI } from "@earendil-works/pi-tui";
import type { SettingsManager } from "../../../core/settings-manager.ts";
import {
	detectTerminalBackgroundFromEnv,
	detectTerminalBackgroundTheme,
	detectTerminalThemeForAuto,
	initTheme,
	parseAutoThemeSetting,
	resolveThemeSetting,
	setTheme,
	setThemeInstance,
	type TerminalTheme,
	type Theme,
} from "./theme.ts";

type ThemeResult = { success: boolean; error?: string };

export class InteractiveThemeController {
	private readonly ui: TUI;
	private readonly settingsManager: SettingsManager;
	private readonly showError: (message: string) => void;
	private readonly onChanged: () => void;
	private terminalTheme: TerminalTheme = detectTerminalBackgroundFromEnv().theme;
	private activeThemeName: string | undefined;
	private autoSyncEnabled = false;

	constructor(ui: TUI, settingsManager: SettingsManager, showError: (message: string) => void, onChanged: () => void) {
		this.ui = ui;
		this.settingsManager = settingsManager;
		this.showError = showError;
		this.onChanged = onChanged;
		this.activeThemeName = resolveThemeSetting(this.settingsManager.getThemeSetting(), this.terminalTheme);
		initTheme(this.activeThemeName, true);
		this.ui.onTerminalColorSchemeChange((terminalTheme) => this.applyTerminalTheme(terminalTheme));
	}

	async applyFromSettings(): Promise<void> {
		// Resolve explicit and auto settings before probing the terminal; probing is only needed when settings do not decide.
		// 先解析显式与 auto 设置；仅在设置无法决定主题时才探测终端。
		const themeSetting = this.settingsManager.getThemeSetting();
		const autoTheme = parseAutoThemeSetting(themeSetting);
		if (autoTheme) {
			this.terminalTheme = await detectTerminalThemeForAuto({ ui: this.ui, timeoutMs: 100 });
			this.setAutoSync(true);
			this.applyThemeName(this.terminalTheme === "light" ? autoTheme.lightTheme : autoTheme.darkTheme, true);
			return;
		}

		this.setAutoSync(false);
		if (themeSetting !== undefined) {
			this.applyThemeName(themeSetting, true);
			return;
		}

		const detection = await detectTerminalBackgroundTheme({ ui: this.ui, timeoutMs: 100 });
		this.terminalTheme = detection.theme;
		if (!this.applyThemeName(detection.theme).success) return;
		// Persist detection only when confidence is high; uncertain guesses remain session-local.
		// 仅在探测置信度高时持久化；不确定的推断只在当前会话生效。
		if (detection.confidence === "high") {
			this.settingsManager.setTheme(detection.theme);
			await this.settingsManager.flush();
		}
	}

	setThemeName(themeName: string, showError = false): ThemeResult {
		this.setAutoSync(false);
		return this.applyThemeName(themeName, showError);
	}

	setThemeInstance(themeInstance: Theme): ThemeResult {
		this.setAutoSync(false);
		setThemeInstance(themeInstance);
		this.activeThemeName = "<in-memory>";
		this.notifyChanged();
		return { success: true };
	}

	preview(themeSettingOrName: string): void {
		// Preview swaps the rendered theme without changing settings or the committed active theme name.
		// 预览只替换当前渲染主题，不修改设置，也不提交 activeThemeName。
		const themeName = resolveThemeSetting(themeSettingOrName, this.terminalTheme) ?? this.activeThemeName;
		if (!themeName) return;
		if (setTheme(themeName, true).success) {
			this.ui.invalidate();
			this.ui.requestRender();
		}
	}

	disableAutoSync(): void {
		this.setAutoSync(false);
	}

	getTerminalTheme(): TerminalTheme {
		return this.terminalTheme;
	}

	private applyThemeName(themeName: string, showError = false): ThemeResult {
		// setTheme owns the dark-theme fallback; the controller mirrors that resolved state and reports optionally.
		// dark 主题回退由 setTheme 负责；控制器同步记录回退后的状态，并按需报告错误。
		const result = setTheme(themeName, true);
		this.activeThemeName = result.success ? themeName : "dark";
		this.notifyChanged();
		if (!result.success && showError) {
			this.showError(`Failed to load theme "${themeName}": ${result.error}\nFell back to dark theme.`);
		}
		return result;
	}

	private notifyChanged(): void {
		// Invalidate component caches here; the host callback decides when to schedule the actual redraw.
		// 此处只使组件缓存失效；实际重绘时机由宿主回调决定。
		this.ui.invalidate();
		this.onChanged();
	}

	private setAutoSync(enabled: boolean): void {
		if (this.autoSyncEnabled === enabled) return;
		this.autoSyncEnabled = enabled;
		this.ui.setTerminalColorSchemeNotifications(enabled);
	}

	private applyTerminalTheme(terminalTheme: TerminalTheme): void {
		if (!this.autoSyncEnabled) return;
		this.terminalTheme = terminalTheme;
		const autoTheme = parseAutoThemeSetting(this.settingsManager.getThemeSetting());
		if (!autoTheme) {
			this.setAutoSync(false);
			return;
		}
		const themeName = terminalTheme === "light" ? autoTheme.lightTheme : autoTheme.darkTheme;
		if (themeName !== this.activeThemeName) {
			this.applyThemeName(themeName);
		}
	}
}
