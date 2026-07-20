import { join } from "node:path";
import type { ModelsStore, ModelsStoreEntry } from "@earendil-works/pi-ai";
import { getAgentDir } from "../config.ts";
import { type AuthStorageBackend, FileAuthStorageBackend } from "./auth-storage.ts";

type StoredModels = Record<string, ModelsStoreEntry>;

export class InMemoryCodingAgentModelsStore implements ModelsStore {
	private readonly entries = new Map<string, ModelsStoreEntry>();

	async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
		return this.entries.get(providerId);
	}

	async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
		this.entries.set(providerId, entry);
	}

	async delete(providerId: string): Promise<void> {
		this.entries.delete(providerId);
	}
}

/** Locked JSON-backed storage for dynamically refreshed provider catalogs. */
/**
 * 动态模型目录的文件持久化（默认 ~/.pi/agent/models-store.json）。
 * 复用 auth-storage 的文件锁后端：多个 pi 进程同时刷新目录时读改写不互相覆盖。
 */
export class FileModelsStore implements ModelsStore {
	private readonly storage: AuthStorageBackend;

	constructor(path: string = join(getAgentDir(), "models-store.json")) {
		this.storage = new FileAuthStorageBackend(path);
	}

	private parse(content: string | undefined): StoredModels {
		return content ? (JSON.parse(content) as StoredModels) : {};
	}

	async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
		return this.storage.withLock((content) => ({
			result: structuredClone(this.parse(content)[providerId]),
		}));
	}

	async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
		await this.storage.withLockAsync(async (content) => {
			const current = this.parse(content);
			current[providerId] = structuredClone(entry);
			return { result: undefined, next: JSON.stringify(current, null, 2) };
		});
	}

	async delete(providerId: string): Promise<void> {
		await this.storage.withLockAsync(async (content) => {
			const current = this.parse(content);
			delete current[providerId];
			return { result: undefined, next: JSON.stringify(current, null, 2) };
		});
	}
}
