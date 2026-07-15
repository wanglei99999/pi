import type { Component } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

/**
 * Dynamic border component that adjusts to viewport width.
 * 根据当前视口宽度动态生成边框的组件。
 *
 * Note: When used from extensions loaded via jiti, the global `theme` may be undefined
 * because jiti creates a separate module cache. Always pass an explicit color
 * function when using DynamicBorder in components exported for extension use.
 * 注意：扩展经 jiti 加载时会使用独立模块缓存，全局 `theme` 可能未初始化。
 * 导出给扩展使用的组件应显式传入 color 函数，避免依赖宿主模块实例中的主题状态。
 */
export class DynamicBorder implements Component {
	private color: (str: string) => string;

	constructor(color: (str: string) => string = (str) => theme.fg("border", str)) {
		// 默认函数在每次 render 时读取当前 theme；显式注入则隔离扩展与宿主的主题模块实例。
		this.color = color;
	}

	invalidate(): void {
		// No cached state to invalidate currently
		// 当前不缓存宽度或渲染结果，因此主题/布局刷新无需清理内部状态。
	}

	render(width: number): string[] {
		// 至少输出一个单元宽度，避免极窄布局产生空组件并破坏垂直结构。
		return [this.color("─".repeat(Math.max(1, width)))];
	}
}
