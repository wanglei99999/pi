import type {
	AgentSessionEvent,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
} from "@earendil-works/pi-coding-agent";
import type { InstanceStatus } from "../types.ts";

export interface SpawnRequest {
	// spawn carries per-instance launch overrides; omitted provider/model values are resolved by the daemon.
	// spawn 携带单实例启动覆盖；省略 provider/model 时由 daemon 解析默认值。
	type: "spawn";
	cwd: string;
	label?: string;
	provider?: string;
	model?: string;
}

export interface ListRequest {
	type: "list";
}

export interface StopRequest {
	type: "stop";
	instanceId: string;
}

export interface StatusRequest {
	type: "status";
	instanceId: string;
}

export interface RpcRequest {
	// rpc is a one-shot bridge: one RpcCommand produces one RpcBridgeResponse over a short-lived connection.
	// rpc 是一次性桥接：单个 RpcCommand 通过短连接产生单个 RpcBridgeResponse。
	type: "rpc";
	instanceId: string;
	command: RpcCommand;
}

export interface RpcStreamRequest {
	// rpc_stream is an upgrade handshake; RpcReadyResponse switches the socket to bidirectional stream messages.
	// rpc_stream 是升级握手；RpcReadyResponse 会把 socket 切换为双向流消息。
	type: "rpc_stream";
	instanceId: string;
}

export interface RequestMap {
	// The discriminant-to-interface map is the source for both the request union and request/response type correlation.
	// 判别字段到接口的映射同时生成请求联合类型，并建立请求/响应类型关联。
	spawn: SpawnRequest;
	list: ListRequest;
	stop: StopRequest;
	status: StatusRequest;
	rpc: RpcRequest;
	rpc_stream: RpcStreamRequest;
}

export type OrchestratorRequest = RequestMap[keyof RequestMap];

export interface InstanceSummary {
	// This is a transport snapshot, so lifecycle-dependent session fields remain optional until the instance reports them.
	// 这是传输层快照，因此依赖生命周期的 session 字段在实例上报前保持可选。
	id: string;
	status: InstanceStatus;
	cwd: string;
	label?: string;
	sessionId?: string;
	sessionFile?: string;
	radiusPiId?: string;
}

export interface ResponseBase {
	// ok/error is shared by typed responses; command-specific payload fields stay optional on failure.
	// ok/error 由所有类型化响应共享；命令专属 payload 在失败时保持可选。
	ok: boolean;
	error?: string;
}

export interface SpawnResponse extends ResponseBase {
	type: "spawn_result";
	instance?: InstanceSummary;
}

export interface ListResponse extends ResponseBase {
	type: "list_result";
	instances?: InstanceSummary[];
}

export interface StopResponse extends ResponseBase {
	type: "stop_result";
	instanceId?: string;
}

export interface StatusResponse extends ResponseBase {
	type: "status_result";
	instance?: InstanceSummary;
}

export interface RpcBridgeResponse extends ResponseBase {
	type: "rpc_result";
	response: RpcResponse;
}

export interface RpcReadyResponse extends ResponseBase {
	// rpc_ready acknowledges only the stream upgrade; subsequent messages use RpcServerMessage rather than ResponseMap.
	// rpc_ready 只确认流升级；后续消息使用 RpcServerMessage，而不再通过 ResponseMap。
	type: "rpc_ready";
	instance?: InstanceSummary;
}

export interface ErrorResponse extends ResponseBase {
	// ErrorResponse is the universal failure alternative for every orchestrator request.
	// ErrorResponse 是所有 orchestrator 请求共用的失败分支。
	type: "error";
	ok: false;
	error: string;
}

export interface ResponseMap {
	// Keys intentionally mirror RequestMap so ResponseFor can preserve the response type for a concrete request.
	// key 刻意与 RequestMap 对齐，使 ResponseFor 能为具体请求保留对应响应类型。
	spawn: SpawnResponse;
	list: ListResponse;
	stop: StopResponse;
	status: StatusResponse;
	rpc: RpcBridgeResponse;
	rpc_stream: RpcReadyResponse;
}

export type OrchestratorResponse = ResponseMap[keyof ResponseMap] | ErrorResponse;
// After stream upgrade, clients send commands or UI responses; they do not resend orchestrator control requests.
// 流升级后，客户端只发送 command 或 UI response，不再发送 orchestrator 控制请求。
export type RpcClientMessage = RpcCommand | RpcExtensionUIResponse;
// Server stream traffic multiplexes the ready frame, RPC replies, session events, UI requests, and errors.
// 服务端流量复用 ready 帧、RPC reply、session event、UI request 和 error。
export type RpcServerMessage =
	| RpcReadyResponse
	| RpcResponse
	| AgentSessionEvent
	| RpcExtensionUIRequest
	| ErrorResponse;
export type ProtocolMessage = OrchestratorRequest | OrchestratorResponse | RpcClientMessage | RpcServerMessage;

// This conditional type is compile-time only; runtime parsing still relies on the type discriminant and handler validation.
// 该条件类型仅在编译期生效；运行时解析仍依赖 type 判别字段和 handler 校验。
export type ResponseFor<T extends OrchestratorRequest> = T extends { type: infer K }
	? K extends keyof ResponseMap
		? ResponseMap[K] | ErrorResponse
		: ErrorResponse
	: ErrorResponse;

export function encodeMessage(message: ProtocolMessage): string {
	// Every message is one JSONL frame; the trailing newline is the sole transport delimiter.
	// 每条消息编码为一个 JSONL 帧；末尾换行是唯一传输分隔符。
	return `${JSON.stringify(message)}\n`;
}

export function parseRequestLine(line: string): OrchestratorRequest {
	// Parsing validates JSON syntax but does not perform schema validation; downstream routing validates supported shapes.
	// 解析只校验 JSON 语法，不执行 schema 验证；支持的结构由后续路由校验。
	const value = JSON.parse(line) as OrchestratorRequest;
	return value;
}

export function parseResponseLine(line: string): OrchestratorResponse {
	const value = JSON.parse(line) as OrchestratorResponse;
	return value;
}
