// These lifecycle values form the serializable coordinator snapshot; live process availability is tracked separately.
// 这些生命周期值构成可序列化的 coordinator 快照；实际进程是否存活由其他运行时状态单独跟踪。
export type InstanceStatus = "starting" | "online" | "stopping" | "stopped" | "error";

// The machine record is durable local identity and recent presence metadata, excluding heartbeat timers and retry state.
// machine 记录保存持久化的本地身份及最近 presence 元数据，不包含心跳定时器和重试状态。
export interface MachineRecord {
	id: string;
	createdAt: string;
	lastSeenAt?: string;
	label?: string;
}

// Radius returns scheduling and expiry policy with registrations; callers own the timers that apply this policy.
// Radius 在注册时返回调度与过期策略；应用这些策略的定时器由调用方持有。
export interface RadiusRegistration {
	heartbeatIntervalMs: number;
	expiresInMs: number;
}

// An instance record is the persistable and API-facing Pi snapshot, not the container for RPC processes or subscriptions.
// instance 记录是可持久化且面向 API 的 Pi 快照，不承载 RPC 进程或订阅等运行时资源。
export interface InstanceRecord {
	id: string;
	status: InstanceStatus;
	cwd: string;
	createdAt: string;
	lastSeenAt?: string;
	label?: string;
	// Session fields are synchronized from the running Pi, while radiusPiId links that local instance to remote presence.
	// session 字段由运行中的 Pi 同步；radiusPiId 则把本地 instance 关联到远端 presence。
	sessionId?: string;
	sessionFile?: string;
	radiusPiId?: string;
}
