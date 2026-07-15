import type { Model, Models } from "@earendil-works/pi-ai";

import type { AgentMessage } from "../../types.ts";
import {
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../messages.ts";
import type { BranchSummaryResult, Session, SessionTreeEntry } from "../types.ts";
import { BranchSummaryError, err, ok, type Result, SessionError } from "../types.ts";
import { estimateTokens, SUMMARIZATION_SYSTEM_PROMPT } from "./compaction.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	serializeConversation,
} from "./utils.ts";

/** File-operation details stored on generated branch summary entries. */
/** 生成的分支摘要条目中保存的文件操作明细，用于后续摘要继续累积。 */
export interface BranchSummaryDetails {
	/** Files read while exploring the summarized branch. */
	/** 探索该分支期间读取过的文件。 */
	readFiles: string[];
	/** Files modified while exploring the summarized branch. */
	/** 探索该分支期间修改过的文件。 */
	modifiedFiles: string[];
}

export type { FileOperations } from "./utils.ts";

/** Prepared branch content for summarization. */
/** 已按预算整理、可直接用于摘要的分支内容。 */
export interface BranchPreparation {
	/** Messages selected for the branch summary. */
	/** 按时间顺序选入分支摘要的消息。 */
	messages: AgentMessage[];
	/** File operations extracted from the branch. */
	/** 从整个分支提取并累积的文件操作。 */
	fileOps: FileOperations;
	/** Estimated token count for selected messages. */
	/** 所选消息的估算 token 总数。 */
	totalTokens: number;
}

/** Entries selected for branch summarization. */
/** 从即将离开的路径中选出的待摘要条目。 */
export interface CollectEntriesResult {
	/** Entries to summarize in chronological order. */
	/** 按时间顺序排列的待摘要条目。 */
	entries: SessionTreeEntry[];
	/** Deepest common ancestor between the previous leaf and target entry. */
	/** 旧叶节点与目标条目之间最深的共同祖先。 */
	commonAncestorId: string | null;
}

/** Options for generating a branch summary. */
/** 生成分支摘要所需的模型、取消信号和预算选项。 */
export interface GenerateBranchSummaryOptions {
	/** Provider collection the summarization request goes through; owns auth resolution. */
	/** 承载摘要请求并负责解析认证信息的提供商集合。 */
	models: Models;
	/** Model used for summarization. */
	/** 用于生成摘要的模型。 */
	model: Model<any>;
	/** Abort signal for the summarization request. */
	/** 用于取消摘要请求的信号。 */
	signal: AbortSignal;
	/** Optional instructions appended to or replacing the default prompt. */
	/** 追加到默认提示词或替换它的可选指令。 */
	customInstructions?: string;
	/** Replace the default prompt with custom instructions instead of appending them. */
	/** 为 true 时用自定义指令完全替换默认提示词，而不是追加。 */
	replaceInstructions?: boolean;
	/** Tokens reserved for prompt and model output. Defaults to 16384. */
	/** 为提示词开销和模型输出预留的 token，默认 16384。 */
	reserveTokens?: number;
}

/** Collect entries that should be summarized before navigating to a different session tree entry. */
/** 导航到另一会话树条目前，收集旧路径上需要摘要的条目。 */
export async function collectEntriesForBranchSummary(
	session: Session,
	oldLeafId: string | null,
	targetId: string,
): Promise<CollectEntriesResult> {
	if (!oldLeafId) {
		// 没有旧位置时不存在被放弃的分支，也无需寻找共同祖先。
		return { entries: [], commonAncestorId: null };
	}
	const oldPath = new Set((await session.getBranch(oldLeafId)).map((e) => e.id));
	const targetPath = await session.getBranch(targetId);
	// targetPath 从根到叶排列，反向查找可得到两条路径上最深的共同祖先。
	let commonAncestorId: string | null = null;
	for (let i = targetPath.length - 1; i >= 0; i--) {
		if (oldPath.has(targetPath[i].id)) {
			commonAncestorId = targetPath[i].id;
			break;
		}
	}
	const entries: SessionTreeEntry[] = [];
	let current: string | null = oldLeafId;

	while (current && current !== commonAncestorId) {
		// 从旧叶节点向上回溯，但不包含仍属于目标路径的共同祖先。
		const entry = await session.getEntry(current);
		if (!entry) throw new SessionError("invalid_session", `Entry ${current} not found`);
		entries.push(entry as SessionTreeEntry);
		current = entry.parentId;
	}
	// 回溯得到的是逆序条目，摘要输入需要恢复为实际对话顺序。
	entries.reverse();

	return { entries, commonAncestorId };
}
function getMessageFromEntry(entry: SessionTreeEntry): AgentMessage | undefined {
	switch (entry.type) {
		case "message":
			// 跳过工具结果，分支上下文和文件操作以 assistant 的工具调用为准，避免把协议结果当作独立对话回合。
			if (entry.message.role === "toolResult") return undefined;
			return entry.message;

		case "custom_message":
			return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp);

		case "branch_summary":
			return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);

		case "compaction":
			return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);
		case "thinking_level_change":
		case "model_change":
		case "active_tools_change":
		case "custom":
		case "label":
		case "session_info":
		case "leaf":
			return undefined;
	}
}

/** Prepare branch entries for summarization within an optional token budget. */
/** 在可选 token 预算内准备分支消息，同时累积不受裁剪影响的文件操作。 */
export function prepareBranchEntries(entries: SessionTreeEntry[], tokenBudget: number = 0): BranchPreparation {
	const messages: AgentMessage[] = [];
	const fileOps = createFileOps();
	let totalTokens = 0;
	// 第一遍读取 pi 生成摘要的 details；即使正文因预算被裁掉，嵌套分支的文件轨迹也不能丢失。
	for (const entry of entries) {
		if (entry.type === "branch_summary" && !entry.fromHook && entry.details) {
			const details = entry.details as BranchSummaryDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) {
					fileOps.edited.add(f);
				}
			}
		}
	}
	// 第二遍从最新消息向旧消息选择，分支过长时优先保留离开分支前的最近上下文。
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getMessageFromEntry(entry);
		if (!message) continue;
		extractFileOpsFromMessage(message, fileOps);

		const tokens = estimateTokens(message);
		if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
			// 摘要条目浓缩了更早上下文；当前预算使用不足 90% 时允许整条纳入，然后停止继续向前扩展。
			if (entry.type === "compaction" || entry.type === "branch_summary") {
				if (totalTokens < tokenBudget * 0.9) {
					messages.unshift(message);
					totalTokens += tokens;
				}
			}
			break;
		}

		messages.unshift(message);
		totalTokens += tokens;
	}

	return { messages, fileOps, totalTokens };
}

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

/** Generate a summary for abandoned branch entries. */
/** 为已离开的分支生成可在返回时注入上下文的结构化摘要。 */
export async function generateBranchSummary(
	entries: SessionTreeEntry[],
	options: GenerateBranchSummaryOptions,
): Promise<Result<BranchSummaryResult, BranchSummaryError>> {
	const { models, model, signal, customInstructions, replaceInstructions, reserveTokens = 16384 } = options;
	const contextWindow = model.contextWindow || 128000;
	// 可选正文预算等于上下文窗口减去系统提示、包装文本和最多 2048 token 输出所需的预留空间。
	const tokenBudget = contextWindow - reserveTokens;

	const { messages, fileOps } = prepareBranchEntries(entries, tokenBudget);

	if (messages.length === 0) {
		return ok({ summary: "No content to summarize", readFiles: [], modifiedFiles: [] });
	}
	const llmMessages = convertToLlm(messages);
	// 先转换为 LLM 消息，再序列化为带角色标签的普通文本，使工具调用成为记录而非可执行协议项。
	const conversationText = serializeConversation(llmMessages);
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
	const response = await models.completeSimple(
		// 摘要请求绕过代理状态机，但仍由 Models 统一处理认证、提供商调用和取消信号。
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		{ signal, maxTokens: 2048 },
	);
	if (response.stopReason === "aborted") {
		return err(new BranchSummaryError("aborted", response.errorMessage || "Branch summary aborted"));
	}
	if (response.stopReason === "error") {
		return err(
			new BranchSummaryError(
				"summarization_failed",
				`Branch summary failed: ${response.errorMessage || "Unknown error"}`,
			),
		);
	}

	let summary = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	summary = BRANCH_SUMMARY_PREAMBLE + summary;
	// 前言明确这是离开分支的历史摘要，避免返回主路径后被误解为用户的新指令。
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	return ok({
		summary: summary || "No summary generated",
		readFiles,
		modifiedFiles,
	});
}
