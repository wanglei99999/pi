/**
 * Tool HTML renderer for custom tools in HTML export.
 * HTML 导出中自定义工具的渲染适配器。
 *
 * Renders custom tool calls and results to HTML by invoking their TUI renderers
 * and converting the ANSI output to HTML.
 * 复用工具的 TUI 渲染器生成 ANSI 行，再转换为可嵌入导出文档的 HTML。
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderContext } from "../extensions/types.ts";
import { ansiLinesToHtml } from "./ansi-to-html.ts";

export interface ToolHtmlRendererDeps {
	/** Function to look up tool definition by name */
	/** 按名称查找扩展工具定义。 */
	getToolDefinition: (name: string) => ToolDefinition | undefined;
	/** Theme for styling */
	/** 提供与交互式 TUI 一致的颜色和样式主题。 */
	theme: Theme;
	/** Working directory for render context */
	/** 传入工具渲染上下文的工作目录。 */
	cwd: string;
	/** Terminal width for rendering (default: 100) */
	/** 模拟终端渲染宽度，默认 100 列；组件会按此宽度换行。 */
	width?: number;
}

export interface ToolHtmlRenderer {
	/** Render a tool call to HTML. Returns undefined if tool has no custom renderer. */
	/** 把工具调用渲染为 HTML；无自定义渲染器时返回 undefined 交由通用逻辑处理。 */
	renderCall(toolCallId: string, toolName: string, args: unknown): string | undefined;
	/** Render a tool result to collapsed/expanded HTML. Returns undefined if tool has no custom renderer. */
	/** 同时生成折叠和展开结果；无自定义渲染器时返回 undefined。 */
	renderResult(
		toolCallId: string,
		toolName: string,
		result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
		details: unknown,
		isError: boolean,
	): { collapsed?: string; expanded?: string } | undefined;
}

/**
 * Create a tool HTML renderer.
 * 创建工具 HTML 渲染器。
 *
 * The renderer looks up tool definitions and invokes their renderCall/renderResult
 * methods, converting the resulting TUI Component output (ANSI) to HTML.
 * 渲染器查找工具定义并调用 renderCall/renderResult，将 TUI Component 的 ANSI 输出转换为 HTML。
 */
const ANSI_ESCAPE_REGEX = /\x1b\[[\d;]*m/g;

function isBlankRenderedLine(line: string): boolean {
	// 判断空行前先移除 SGR 样式序列，避免只有颜色重置码的行被误认为可见内容。
	return line.replace(ANSI_ESCAPE_REGEX, "").trim().length === 0;
}

function trimRenderedResultLines(lines: string[]): string[] {
	// 只裁掉结果首尾的视觉空行，保留组件正文内部用于布局的空行。
	let start = 0;
	let end = lines.length;
	while (start < end && isBlankRenderedLine(lines[start])) start++;
	while (end > start && isBlankRenderedLine(lines[end - 1])) end--;
	return lines.slice(start, end);
}

export function createToolHtmlRenderer(deps: ToolHtmlRendererDeps): ToolHtmlRenderer {
	const { getToolDefinition, theme, cwd, width = 100 } = deps;

	// 按 toolCallId 保留组件、参数和扩展自定义状态，使调用、折叠结果与展开结果构成同一渲染生命周期。
	const renderedCallComponents = new Map<string, Component>();
	const renderedResultComponents = new Map<string, Component>();
	const renderedStates = new Map<string, any>();
	const renderedArgs = new Map<string, unknown>();

	const getState = (toolCallId: string): any => {
		let state = renderedStates.get(toolCallId);
		if (!state) {
			state = {};
			renderedStates.set(toolCallId, state);
		}
		return state;
	};

	const createRenderContext = (
		toolCallId: string,
		lastComponent: Component | undefined,
		expanded: boolean,
		isPartial: boolean,
		isError: boolean,
	): ToolRenderContext => {
		// HTML 导出是一次性静态渲染：invalidate 无需调度重绘，执行与参数状态则固定为已开始、已完整。
		return {
			args: renderedArgs.get(toolCallId),
			toolCallId,
			invalidate: () => {},
			lastComponent,
			state: getState(toolCallId),
			cwd,
			executionStarted: true,
			argsComplete: true,
			isPartial,
			expanded,
			// 禁用终端内联图片控制序列；导出文档中的图片由 HTML 内容层单独处理。
			showImages: false,
			isError,
		};
	};

	return {
		renderCall(toolCallId: string, toolName: string, args: unknown): string | undefined {
			try {
				renderedArgs.set(toolCallId, args);
				const toolDef = getToolDefinition(toolName);
				if (!toolDef?.renderCall) {
					return undefined;
				}

				// 调用阶段使用 isPartial 状态，允许扩展沿用 TUI 中“工具仍在执行”的展示样式。
				const component = toolDef.renderCall(
					args,
					theme,
					createRenderContext(toolCallId, renderedCallComponents.get(toolCallId), false, true, false),
				);
				renderedCallComponents.set(toolCallId, component);
				// 先按模拟终端宽度生成 ANSI 行，再由统一转换器保留主题样式并转义为 HTML。
				const lines = component.render(width);
				return ansiLinesToHtml(lines);
			} catch {
				// On error, return undefined so HTML export can fall back to structured result rendering
				// 自定义渲染失败时返回 undefined，让 HTML 导出退回结构化工具调用展示。
				return undefined;
			}
		},

		renderResult(
			toolCallId: string,
			toolName: string,
			result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
			details: unknown,
			isError: boolean,
		): { collapsed?: string; expanded?: string } | undefined {
			try {
				const toolDef = getToolDefinition(toolName);
				if (!toolDef?.renderResult) {
					return undefined;
				}

				// Build AgentToolResult from content array
				// 从会话保存的内容数组重建扩展渲染器期望的 AgentToolResult 形状。
				// Cast content since session storage uses generic object types
				// 会话存储使用通用对象类型，此处仅在适配边界恢复文本/图片联合类型。
				const agentToolResult = {
					content: result as (TextContent | ImageContent)[],
					details,
					isError,
				};

				// Render collapsed
				// 先生成折叠视图，并保存组件供随后展开渲染作为 lastComponent 复用。
				const collapsedComponent = toolDef.renderResult(
					agentToolResult,
					{ expanded: false, isPartial: false },
					theme,
					createRenderContext(toolCallId, renderedResultComponents.get(toolCallId), false, false, isError),
				);
				renderedResultComponents.set(toolCallId, collapsedComponent);
				const collapsed = ansiLinesToHtml(trimRenderedResultLines(collapsedComponent.render(width)));

				// Render expanded
				// 展开视图复用同一 toolCallId 的参数和 state，确保扩展工具的有状态渲染保持一致。
				const expandedComponent = toolDef.renderResult(
					agentToolResult,
					{ expanded: true, isPartial: false },
					theme,
					createRenderContext(toolCallId, renderedResultComponents.get(toolCallId), true, false, isError),
				);
				renderedResultComponents.set(toolCallId, expandedComponent);
				const expanded = ansiLinesToHtml(trimRenderedResultLines(expandedComponent.render(width)));

				return {
					// 折叠内容为空或与展开内容相同时省略副本，导出端只需使用 expanded。
					...(collapsed && collapsed !== expanded ? { collapsed } : {}),
					expanded,
				};
			} catch {
				// On error, return undefined so HTML export can fall back to structured result rendering
				// 结果渲染异常同样降级到通用结构化展示，不让单个扩展破坏整份导出。
				return undefined;
			}
		},
	};
}
