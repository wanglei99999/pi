/**
 * Branch summarization for tree navigation.
 * 用于会话树导航的分支摘要。
 *
 * When navigating to a different point in the session tree, this generates
 * a summary of the branch being left so context isn't lost.
 * 会话树导航到其他位置时，为即将离开的分支生成摘要，避免上下文丢失。
 */

import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../messages.ts";
import type { ReadonlySessionManager, SessionEntry } from "../session-manager.ts";
import { estimateTokens } from "./compaction.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
} from "./utils.ts";

// ============================================================================
// Types
// 类型
// ============================================================================

export interface BranchSummaryResult {
	summary?: string;
	readFiles?: string[];
	modifiedFiles?: string[];
	aborted?: boolean;
	error?: string;
}

/** Details stored in BranchSummaryEntry.details for file tracking */
/** 存储在 BranchSummaryEntry.details 中、用于文件跟踪的详细信息。 */
export interface BranchSummaryDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

export type { FileOperations } from "./utils.ts";

export interface BranchPreparation {
	/** Messages extracted for summarization, in chronological order */
	/** 按时间顺序排列、为生成摘要而提取的消息。 */
	messages: AgentMessage[];
	/** File operations extracted from tool calls */
	/** 从工具调用中提取的文件操作。 */
	fileOps: FileOperations;
	/** Total estimated tokens in messages */
	/** 消息的估算 token 总数。 */
	totalTokens: number;
}

export interface CollectEntriesResult {
	/** Entries to summarize, in chronological order */
	/** 按时间顺序排列的待摘要条目。 */
	entries: SessionEntry[];
	/** Common ancestor between old and new position, if any */
	/** 旧位置与新位置的共同祖先（如果存在）。 */
	commonAncestorId: string | null;
}

export interface GenerateBranchSummaryOptions {
	/** Model to use for summarization */
	/** 用于生成摘要的模型。 */
	model: Model<any>;
	/** API key for the model */
	apiKey?: string;
	/** Request headers for the model */
	/** 模型请求头。 */
	headers?: Record<string, string>;
	/** Provider-scoped environment values for the model */
	/** 作用域限定到提供商的模型环境变量。 */
	env?: Record<string, string>;
	/** Abort signal for cancellation */
	/** 用于取消操作的中止信号。 */
	signal: AbortSignal;
	/** Optional custom instructions for summarization */
	/** 可选的摘要自定义指令。 */
	customInstructions?: string;
	/** If true, customInstructions replaces the default prompt instead of being appended */
	/** 为 true 时，customInstructions 将替换默认提示词，而不是追加到其后。 */
	replaceInstructions?: boolean;
	/** Tokens reserved for prompt + LLM response (default 16384) */
	/** 为提示词与 LLM 响应预留的 token 数（默认 16384）。 */
	reserveTokens?: number;
	/** Optional session stream function. Used to preserve SDK request behavior without mutating agent state. */
	/** 可选的会话流函数，用于在不修改代理状态的情况下保持 SDK 请求行为。 */
	streamFn?: StreamFn;
}

// ============================================================================
// Entry Collection
// 条目收集
// ============================================================================

/**
 * Collect entries that should be summarized when navigating from one position to another.
 *
 * Walks from oldLeafId back to the common ancestor with targetId, collecting entries
 * along the way. Does NOT stop at compaction boundaries - those are included and their
 * summaries become context.
 *
 * @param session - Session manager (read-only access)
 * @param oldLeafId - Current position (where we're navigating from)
 * @param targetId - Target position (where we're navigating to)
 * @returns Entries to summarize and the common ancestor
 * 收集从一个位置导航到另一个位置时应生成摘要的条目。
 *
 * 从 oldLeafId 向共同祖先回溯，沿途收集条目。遇到压缩边界时不会停止，
 * 因为这些边界也会被纳入，其摘要将成为上下文的一部分。
 */
export function collectEntriesForBranchSummary(
	session: ReadonlySessionManager,
	oldLeafId: string | null,
	targetId: string,
): CollectEntriesResult {
	// If no old position, nothing to summarize
	// 如果没有旧位置，就没有需要摘要的内容。
	if (!oldLeafId) {
		return { entries: [], commonAncestorId: null };
	}

	// Find common ancestor (deepest node that's on both paths)
	// 查找共同祖先（同时位于两条路径上的最深节点）。
	const oldPath = new Set(session.getBranch(oldLeafId).map((e) => e.id));
	const targetPath = session.getBranch(targetId);

	// targetPath is root-first, so iterate backwards to find deepest common ancestor
	// targetPath 从根开始排列，因此反向遍历以找到最深的共同祖先。
	let commonAncestorId: string | null = null;
	for (let i = targetPath.length - 1; i >= 0; i--) {
		if (oldPath.has(targetPath[i].id)) {
			commonAncestorId = targetPath[i].id;
			break;
		}
	}

	// Collect entries from old leaf back to common ancestor
	// 从旧叶节点向共同祖先回溯并收集条目。
	const entries: SessionEntry[] = [];
	let current: string | null = oldLeafId;

	while (current && current !== commonAncestorId) {
		const entry = session.getEntry(current);
		if (!entry) break;
		entries.push(entry);
		current = entry.parentId;
	}

	// Reverse to get chronological order
	// 反转为时间顺序。
	entries.reverse();

	return { entries, commonAncestorId };
}

// ============================================================================
// Entry to Message Conversion
// 条目到消息的转换
// ============================================================================

/**
 * Extract AgentMessage from a session entry.
 * Similar to getMessageFromEntry in compaction.ts but also handles compaction entries.
 * 从会话条目中提取 AgentMessage。
 * 与 compaction.ts 中的 getMessageFromEntry 类似，但也处理压缩条目。
 */
function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	switch (entry.type) {
		case "message":
			// Skip tool results - context is in assistant's tool call
			// 跳过工具结果，其上下文已包含在助手的工具调用中。
			if (entry.message.role === "toolResult") return undefined;
			return entry.message;

		case "custom_message":
			return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp);

		case "branch_summary":
			return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);

		case "compaction":
			return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);

		// These don't contribute to conversation content
		// 这些条目不会为对话内容提供信息。
		case "thinking_level_change":
		case "model_change":
		case "custom":
		case "label":
		case "session_info":
			return undefined;
	}
}

/**
 * Prepare entries for summarization with token budget.
 *
 * Walks entries from NEWEST to OLDEST, adding messages until we hit the token budget.
 * This ensures we keep the most recent context when the branch is too long.
 *
 * Also collects file operations from:
 * - Tool calls in assistant messages
 * - Existing branch_summary entries' details (for cumulative tracking)
 *
 * @param entries - Entries in chronological order
 * @param tokenBudget - Maximum tokens to include (0 = no limit)
 * 按 token 预算准备待摘要条目。
 *
 * 从最新条目向最旧条目遍历并添加消息，直到达到 token 预算。
 * 分支过长时，这能确保保留最近的上下文。
 *
 * 同时从助手消息的工具调用和已有 branch_summary 条目的 details 中收集文件操作。
 */
export function prepareBranchEntries(entries: SessionEntry[], tokenBudget: number = 0): BranchPreparation {
	const messages: AgentMessage[] = [];
	const fileOps = createFileOps();
	let totalTokens = 0;

	// First pass: collect file ops from ALL entries (even if they don't fit in token budget)
	// This ensures we capture cumulative file tracking from nested branch summaries
	// Only extract from pi-generated summaries (fromHook !== true), not extension-generated ones
	// 第一遍：从所有条目收集文件操作，即使条目超出 token 预算。
	// 这样可以累积跟踪嵌套分支摘要中的文件；仅提取 pi 生成的摘要，不处理扩展生成的摘要。
	for (const entry of entries) {
		if (entry.type === "branch_summary" && !entry.fromHook && entry.details) {
			const details = entry.details as BranchSummaryDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				// Modified files go into both edited and written for proper deduplication
				// 将修改过的文件同时计入 edited 和 written，以便正确去重。
				for (const f of details.modifiedFiles) {
					fileOps.edited.add(f);
				}
			}
		}
	}

	// Second pass: walk from newest to oldest, adding messages until token budget
	// 第二遍：从最新到最旧遍历，在 token 预算内添加消息。
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getMessageFromEntry(entry);
		if (!message) continue;

		// Extract file ops from assistant messages (tool calls)
		// 从助手消息（工具调用）中提取文件操作。
		extractFileOpsFromMessage(message, fileOps);

		const tokens = estimateTokens(message);

		// Check budget before adding
		// 添加前检查预算。
		if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
			// If this is a summary entry, try to fit it anyway as it's important context
			// 如果是摘要条目，则尽量纳入，因为它是重要上下文。
			if (entry.type === "compaction" || entry.type === "branch_summary") {
				if (totalTokens < tokenBudget * 0.9) {
					messages.unshift(message);
					totalTokens += tokens;
				}
			}
			// Stop - we've hit the budget
			// 已达到预算，停止处理。
			break;
		}

		messages.unshift(message);
		totalTokens += tokens;
	}

	return { messages, fileOps, totalTokens };
}

// ============================================================================
// Summary Generation
// 摘要生成
// ============================================================================

const BRANCH_SUMMARY_PREAMBLE = `The user explored a different conversation branch before returning here.
Summary of that exploration:

`;

const BRANCH_SUMMARY_PROMPT = `Create a structured summary of this conversation branch for context when returning later.

Use this EXACT format:

## Goal
[What was the user trying to accomplish in this branch?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Work that was started but not finished]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next to continue this work]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/**
 * Generate a summary of abandoned branch entries.
 *
 * @param entries - Session entries to summarize (chronological order)
 * @param options - Generation options
 * 为被放弃的分支条目生成摘要。
 */
export async function generateBranchSummary(
	entries: SessionEntry[],
	options: GenerateBranchSummaryOptions,
): Promise<BranchSummaryResult> {
	const {
		model,
		apiKey,
		headers,
		env,
		signal,
		customInstructions,
		replaceInstructions,
		reserveTokens = 16384,
		streamFn,
	} = options;

	// Token budget = context window minus reserved space for prompt + response
	// token 预算等于上下文窗口减去为提示词和响应预留的空间。
	const contextWindow = model.contextWindow || 128000;
	const tokenBudget = contextWindow - reserveTokens;

	const { messages, fileOps } = prepareBranchEntries(entries, tokenBudget);

	if (messages.length === 0) {
		return { summary: "No content to summarize" };
	}

	// Transform to LLM-compatible messages, then serialize to text
	// Serialization prevents the model from treating it as a conversation to continue
	// 转换为 LLM 兼容消息后再序列化为文本，防止模型将其视为需要继续的对话。
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);

	// Build prompt
	// 构建提示词。
	let instructions: string;
	if (replaceInstructions && customInstructions) {
		instructions = customInstructions;
	} else if (customInstructions) {
		instructions = `${BRANCH_SUMMARY_PROMPT}\n\nAdditional focus: ${customInstructions}`;
	} else {
		instructions = BRANCH_SUMMARY_PROMPT;
	}
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${instructions}`;

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	// Call LLM for summarization. Prefer the session stream function so SDK
	// request behavior (timeouts, retries, attribution headers) stays consistent
	// without running through agent state/events.
	// 调用 LLM 生成摘要。优先使用会话流函数，使 SDK 的超时、重试、归属请求头等行为保持一致，
	// 同时避免经过代理状态和事件流程。
	const context = { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages };
	const requestOptions: SimpleStreamOptions = { apiKey, headers, env, signal, maxTokens: 2048 };
	const response = streamFn
		? await (await streamFn(model, context, requestOptions)).result()
		: await completeSimple(model, context, requestOptions);

	// Check if aborted or errored
	// 检查请求是否被中止或发生错误。
	if (response.stopReason === "aborted") {
		return { aborted: true };
	}
	if (response.stopReason === "error") {
		return { error: response.errorMessage || "Summarization failed" };
	}

	let summary = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");

	// Prepend preamble to provide context about the branch summary
	// 在摘要前添加说明，为分支摘要提供上下文。
	summary = BRANCH_SUMMARY_PREAMBLE + summary;

	// Compute file lists and append to summary
	// 计算文件列表并追加到摘要。
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	return {
		summary: summary || "No summary generated",
		readFiles,
		modifiedFiles,
	};
}
