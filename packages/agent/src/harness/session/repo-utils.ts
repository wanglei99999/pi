import {
	type FileError,
	type Result,
	SessionError,
	type SessionMetadata,
	type SessionStorage,
	type SessionTreeEntry,
} from "../types.ts";
import { Session } from "./session.ts";
import { uuidv7 } from "./uuid.ts";

export function createSessionId(): string {
	// UUIDv7 gives new sessions randomized identifiers with useful creation-time ordering.
	// UUIDv7 为新 session 提供带随机性的 id，同时保留有用的创建时间顺序。
	return uuidv7();
}

export function createTimestamp(): string {
	return new Date().toISOString();
}

export function toSession<TMetadata extends SessionMetadata>(storage: SessionStorage<TMetadata>): Session<TMetadata> {
	// Wrap the storage without copying it; persistence, metadata, and leaf state remain owned by the same backend.
	// 直接包装 storage 而不复制；持久化、metadata 与 leaf 状态仍由同一 backend 管理。
	return new Session(storage);
}

export function getFileSystemResultOrThrow<TValue>(result: Result<TValue, FileError>, message: string): TValue {
	if (!result.ok) {
		// Preserve not_found for callers that can recover; collapse every other filesystem failure to storage.
		// 为可恢复调用方保留 not_found；其余文件系统故障统一转换为 storage。
		const code = result.error.code === "not_found" ? "not_found" : "storage";
		// Keep the original FileError as cause while adding the session operation context to the message.
		// 保留原始 FileError 作为 cause，同时在 message 中补充 session 操作上下文。
		throw new SessionError(code, `${message}: ${result.error.message}`, result.error);
	}
	return result.value;
}

export async function getEntriesToFork(
	storage: SessionStorage,
	options: { entryId?: string; position?: "before" | "at" },
): Promise<SessionTreeEntry[]> {
	// Without an entryId, fork the complete stored log rather than only the current active branch.
	// 未提供 entryId 时 fork 完整存储日志，而不仅是当前活动分支。
	if (!options.entryId) return storage.getEntries();
	const target = await storage.getEntry(options.entryId);
	if (!target) {
		throw new SessionError("invalid_fork_target", `Entry ${options.entryId} not found`);
	}
	let effectiveLeafId: string | null;
	if ((options.position ?? "before") === "at") {
		// `at` includes the target and accepts any entry type by making it the effective leaf.
		// `at` 将目标本身作为 effective leaf，因此会包含目标并接受任意 entry type。
		effectiveLeafId = target.id;
	} else {
		// `before` is intentionally limited to user messages and forks from their parent context.
		// `before` 仅允许 user message，并从其 parent context 开始 fork。
		if (target.type !== "message" || target.message.role !== "user") {
			throw new SessionError("invalid_fork_target", `Entry ${options.entryId} is not a user message`);
		}
		effectiveLeafId = target.parentId;
	}
	// A targeted fork contains only the root-to-leaf ancestry, excluding sibling branches and later entries.
	// 指定目标的 fork 仅包含 root-to-leaf 祖先路径，不包含 sibling branches 或后续 entries。
	return storage.getPathToRoot(effectiveLeafId);
}
