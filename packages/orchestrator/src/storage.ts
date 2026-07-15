import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { getInstancesPath, getMachinePath, getOrchestratorDir } from "./config.ts";
import type { InstanceRecord, MachineRecord } from "./types.ts";

function ensureOrchestratorDir(): void {
	const orchestratorDir = getOrchestratorDir();
	// Create the shared storage directory lazily; recursive mode also tolerates already-created parent segments.
	// 延迟创建共享存储目录；recursive 模式也能容忍父级目录已经存在。
	if (!existsSync(orchestratorDir)) {
		mkdirSync(orchestratorDir, { recursive: true });
	}
}

export function loadMachine(): MachineRecord | undefined {
	const machinePath = getMachinePath();
	// A missing file means no registration, while malformed JSON and I/O failures remain visible to callers.
	// 文件不存在表示尚未注册；JSON 损坏或 I/O 失败则继续向调用方暴露。
	if (!existsSync(machinePath)) {
		return undefined;
	}

	const data = readFileSync(machinePath, "utf-8");
	return JSON.parse(data) as MachineRecord;
}

export function saveMachine(machine: MachineRecord): void {
	ensureOrchestratorDir();
	// This is a direct synchronous overwrite, not a temp-file rename; crash-level atomicity is not provided here.
	// 此处直接同步覆盖文件，并非临时文件 rename，因此不提供进程崩溃级原子性。
	writeFileSync(getMachinePath(), JSON.stringify(machine, null, 2));
}

export function deleteMachine(): void {
	const machinePath = getMachinePath();
	// Deletion is idempotent for an absent file, but other filesystem errors are intentionally not swallowed.
	// 文件不存在时删除操作具备幂等性；其他文件系统错误则不会被静默吞掉。
	if (!existsSync(machinePath)) {
		return;
	}
	rmSync(machinePath);
}

export function loadInstances(): InstanceRecord[] {
	const instancesPath = getInstancesPath();
	// Absence represents an empty set; present JSON is trusted as InstanceRecord[] without schema validation.
	// 文件不存在表示集合为空；文件存在时会将 JSON 直接信任为 InstanceRecord[]，不做 schema 校验。
	if (!existsSync(instancesPath)) {
		return [];
	}

	const data = readFileSync(instancesPath, "utf-8");
	return JSON.parse(data) as InstanceRecord[];
}

export function saveInstances(instances: InstanceRecord[]): void {
	ensureOrchestratorDir();
	// Like machine storage, the complete snapshot is overwritten synchronously without an atomic rename step.
	// 与 machine 存储相同，完整快照会被同步覆盖，不包含原子 rename 步骤。
	writeFileSync(getInstancesPath(), JSON.stringify(instances, null, 2));
}

export function getInstance(instanceId: string): InstanceRecord | undefined {
	// Reads always use a fresh disk snapshot; this module keeps no in-memory instance cache.
	// 每次读取都使用最新磁盘快照；此模块不维护内存 instance cache。
	return loadInstances().find((instance) => instance.id === instanceId);
}

export function upsertInstance(instance: InstanceRecord): void {
	// Upsert rewrites the whole collection and matches only exact id equality, preserving position on replacement.
	// upsert 会重写整个集合，仅按 id 精确匹配，并在替换时保留原数组位置。
	const instances = loadInstances();
	const index = instances.findIndex((existing) => existing.id === instance.id);
	if (index === -1) {
		instances.push(instance);
		saveInstances(instances);
		return;
	}

	instances[index] = instance;
	saveInstances(instances);
}

export function removeInstance(instanceId: string): void {
	// Instance updates are read-modify-write without locking; concurrent writers therefore use last-write-wins semantics.
	// instance 更新采用无锁 read-modify-write，并发写入因此遵循最后写入者覆盖语义。
	const instances = loadInstances().filter((instance) => instance.id !== instanceId);
	saveInstances(instances);
}
