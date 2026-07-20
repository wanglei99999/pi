/**
 * Tool wrappers for extension-registered tools.
 * 扩展注册工具到核心 AgentTool 的适配层。
 *
 * These wrappers only adapt tool execution so extension tools receive the runner context.
 * 包装器只调整执行入口，为扩展工具注入 runner context；它不是安全沙箱或权限检查层。
 * Tool call and tool result interception is handled by AgentSession via agent-core hooks.
 * 工具调用和结果的拦截由 AgentSession 通过 agent-core hooks 处理，不在此处重复实现。
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import type { ExtensionRunner } from "./runner.ts";
import type { RegisteredTool } from "./types.ts";

/**
 * Wrap a RegisteredTool into an AgentTool.
 * 将单个 RegisteredTool 包装为核心运行时可执行的 AgentTool。
 * Uses the runner's createContext() for consistent context across tools and event handlers.
 * 每次执行通过 runner.createContext() 获取当前上下文，使工具和事件处理器看到一致的会话能力。
 */
export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool {
	// 仅把 definition 交给通用包装器；来源、注册信息和拦截生命周期仍由扩展运行时管理。
	const tool = wrapToolDefinition(registeredTool.definition, () => runner.createContext());
	const execute = tool.execute;
	return {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate) => {
			const activeBefore = runner.getActiveTools();
			const result = await execute(toolCallId, params, signal, onUpdate);
			const activeAfter = runner.getActiveTools();
			if (!activeBefore.every((name) => activeAfter.includes(name))) return result;

			const beforeNames = new Set(activeBefore);
			const addedToolNames = activeAfter.filter((name) => !beforeNames.has(name));
			if (addedToolNames.length === 0) return result;
			return {
				...result,
				addedToolNames: [...new Set([...(result.addedToolNames ?? []), ...addedToolNames])],
			};
		},
	};
}

/**
 * Wrap all registered tools into AgentTools.
 * 批量把已注册工具包装为 AgentTool。
 * Uses the runner's createContext() for consistent context across tools and event handlers.
 * 所有工具共享同一上下文工厂，但每次实际调用都会创建最新的 runner context，而非复用旧快照。
 */
export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: ExtensionRunner): AgentTool[] {
	return registeredTools.map((tool) => wrapRegisteredTool(tool, runner));
}
