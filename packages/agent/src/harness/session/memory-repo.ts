import { type Session, SessionError, type SessionMetadata, type SessionRepo } from "../types.ts";
import { InMemorySessionStorage } from "./memory-storage.ts";
import { createSessionId, createTimestamp, getEntriesToFork, toSession } from "./repo-utils.ts";

export class InMemorySessionRepo implements SessionRepo<SessionMetadata, { id?: string }, void> {
	// Repository state is isolated to this object and process lifetime; no sessions are discovered from persistent storage.
	// repository 状态仅属于当前对象和进程生命周期；不会从持久化存储中发现 session。
	private sessions = new Map<string, Session<SessionMetadata>>();

	async create(options: { id?: string } = {}): Promise<Session<SessionMetadata>> {
		const metadata: SessionMetadata = {
			id: options.id ?? createSessionId(),
			createdAt: createTimestamp(),
		};
		const storage = new InMemorySessionStorage({ metadata });
		const session = toSession(storage);
		// Map assignment defines the in-memory id boundary: an explicitly reused id replaces the repository entry.
		// Map 赋值定义内存 id 边界：显式复用 id 会替换 repository 中的对应条目。
		this.sessions.set(metadata.id, session);
		return session;
	}

	async open(metadata: SessionMetadata): Promise<Session<SessionMetadata>> {
		// Open resolves by metadata.id only and returns the same live Session object rather than a reconstructed copy.
		// open 仅按 metadata.id 查找，并返回同一个活动 Session 对象，而不是重建副本。
		const session = this.sessions.get(metadata.id);
		if (!session) {
			throw new SessionError("not_found", `Session not found: ${metadata.id}`);
		}
		return session;
	}

	async list(): Promise<SessionMetadata[]> {
		// Listing reflects the current Map snapshot and insertion order, matching only sessions known to this repo instance.
		// list 反映当前 Map 快照及插入顺序，仅包含此 repo instance 已知的 session。
		return Promise.all([...this.sessions.values()].map((session) => session.getMetadata()));
	}

	async delete(metadata: SessionMetadata): Promise<void> {
		// Delete is idempotent and removes repository reachability; previously returned Session references remain usable.
		// delete 具备幂等性，只移除 repository 可达性；此前返回的 Session 引用仍可继续使用。
		this.sessions.delete(metadata.id);
	}

	async fork(
		sourceMetadata: SessionMetadata,
		options: { entryId?: string; position?: "before" | "at"; id?: string },
	): Promise<Session<SessionMetadata>> {
		const source = await this.open(sourceMetadata);
		// Reuse the shared fork-range rules so memory and persistent repositories select the same source history.
		// 复用共享 fork 范围规则，使内存与持久化 repository 选择相同的源历史。
		const forkedEntries = await getEntriesToFork(source.getStorage(), options);
		const metadata: SessionMetadata = {
			id: options.id ?? createSessionId(),
			createdAt: createTimestamp(),
		};
		const storage = new InMemorySessionStorage({ metadata, entries: forkedEntries });
		// The fork gets independent storage and metadata; later appends do not move or extend the source session.
		// fork 获得独立 storage 与 metadata；后续追加不会移动或扩展源 session。
		const session = toSession(storage);
		this.sessions.set(metadata.id, session);
		return session;
	}
}
