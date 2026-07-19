import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	Tool,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";

/**
 * Stream function used by the agent loop. `Models.streamSimple` satisfies
 * this shape.
 *
 * Contract:
 * - Must not throw or return a rejected promise for request/model/runtime failures.
 * - Must return an AssistantMessageEventStream.
 * - Failures must be encoded in the returned stream via protocol events and a
 *   final AssistantMessage with stopReason "error" or "aborted" and errorMessage.
 * Agent 循环使用的流函数；`Models.streamSimple` 符合此类型。
 * 约定：请求、模型或运行时失败时不得抛出异常或返回被拒绝的 Promise；必须返回
 * AssistantMessageEventStream，并通过协议事件及最终 AssistantMessage 表达失败。
 */
export type StreamFn = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/**
 * Configuration for how tool calls from a single assistant message are executed.
 *
 * - "sequential": each tool call is prepared, executed, and finalized before the next one starts.
 * - "parallel": tool calls are prepared sequentially, then allowed tools execute concurrently.
 *   `tool_execution_end` is emitted in tool completion order after each tool is finalized,
 *   while tool-result message artifacts are emitted later in assistant source order.
 * 配置单条助手消息中的工具调用执行方式："sequential" 逐个完整执行，
 * "parallel" 先顺序准备，再并发执行允许的工具；完成事件按完成顺序发送，
 * 工具结果消息则稍后按助手消息中的原始顺序发送。
 */
export type ToolExecutionMode = "sequential" | "parallel";

/**
 * Controls how many queued user messages are injected when the agent loop reaches a queue drain point.
 *
 * - "all": drain and inject every queued message at that point.
 * - "one-at-a-time": drain and inject only the oldest queued message, leaving the rest queued for later drain points.
 * 控制 Agent 循环到达队列取出点时注入多少条用户消息："all" 取出全部，
 * "one-at-a-time" 只取出最早的一条，其余留待后续取出点处理。
 */
export type QueueMode = "all" | "one-at-a-time";

/** A single tool call content block emitted by an assistant message. */
/** 助手消息发送的单个工具调用内容块。 */
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/**
 * Result returned from `beforeToolCall`.
 *
 * Returning `{ block: true }` prevents the tool from executing. The loop emits an error tool result instead.
 * `reason` becomes the text shown in that error result. If omitted, a default blocked message is used.
 * `beforeToolCall` 的返回结果。返回 `{ block: true }` 会阻止执行，并由循环发送错误工具结果；
 * `reason` 会作为错误文本，省略时使用默认的阻止消息。
 */
export interface BeforeToolCallResult {
	block?: boolean;
	reason?: string;
}

/**
 * Partial override returned from `afterToolCall`.
 *
 * Merge semantics are field-by-field:
 * - `content`: if provided, replaces the tool result content array in full
 * - `details`: if provided, replaces the tool result details value in full
 * - `isError`: if provided, replaces the tool result error flag
 * - `terminate`: if provided, replaces the early-termination hint
 *
 * Omitted fields keep the original executed tool result values.
 * There is no deep merge for `content` or `details`.
 * `afterToolCall` 返回的部分覆盖值。各字段独立合并：提供的字段完整替换原值，
 * 省略的字段保留已执行工具的原值；`content` 与 `details` 不进行深度合并。
 */
export interface AfterToolCallResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
	/**
	 * Hint that the agent should stop after the current tool batch.
	 * Early termination only happens when every finalized tool result in the batch sets this to true.
	 * 提示 Agent 在当前工具批次后停止；仅当批次中每个最终工具结果都将其设为 true 时才提前终止。
	 */
	terminate?: boolean;
}

/** Context passed to `beforeToolCall`. */
/** 传给 `beforeToolCall` 的上下文。 */
export interface BeforeToolCallContext {
	/** The assistant message that requested the tool call. */
	/** 发起工具调用的助手消息。 */
	assistantMessage: AssistantMessage;
	/** The raw tool call block from `assistantMessage.content`. */
	/** 来自 `assistantMessage.content` 的原始工具调用块。 */
	toolCall: AgentToolCall;
	/** Validated tool arguments for the target tool schema. */
	/** 按目标工具架构校验后的参数。 */
	args: unknown;
	/** Current agent context at the time the tool call is prepared. */
	/** 准备工具调用时的当前 Agent 上下文。 */
	context: AgentContext;
}

/** Context passed to `afterToolCall`. */
/** 传给 `afterToolCall` 的上下文。 */
export interface AfterToolCallContext {
	/** The assistant message that requested the tool call. */
	/** 发起工具调用的助手消息。 */
	assistantMessage: AssistantMessage;
	/** The raw tool call block from `assistantMessage.content`. */
	/** 来自 `assistantMessage.content` 的原始工具调用块。 */
	toolCall: AgentToolCall;
	/** Validated tool arguments for the target tool schema. */
	/** 按目标工具架构校验后的参数。 */
	args: unknown;
	/** The executed tool result before any `afterToolCall` overrides are applied. */
	/** 应用任何 `afterToolCall` 覆盖前的工具执行结果。 */
	result: AgentToolResult<any>;
	/** Whether the executed tool result is currently treated as an error. */
	/** 当前是否将工具执行结果视为错误。 */
	isError: boolean;
	/** Current agent context at the time the tool call is finalized. */
	/** 完成工具调用时的当前 Agent 上下文。 */
	context: AgentContext;
}

/** Context passed to `shouldStopAfterTurn`. */
/** 传给 `shouldStopAfterTurn` 的上下文。 */
export interface ShouldStopAfterTurnContext {
	/** The assistant message that completed the turn. */
	/** 完成本轮的助手消息。 */
	message: AssistantMessage;
	/** Tool result messages passed to the preceding `turn_end` event. */
	/** 传给上一条 `turn_end` 事件的工具结果消息。 */
	toolResults: ToolResultMessage[];
	/** Current agent context after the turn's assistant message and tool results have been appended. */
	/** 追加本轮助手消息和工具结果后的当前 Agent 上下文。 */
	context: AgentContext;
	/** Messages that this loop invocation will return if it exits at this point. Prompt runs include the initial prompt messages; continuation runs do not include pre-existing context messages. */
	/** 若此时退出，本次循环调用将返回的消息；提示运行包含初始提示消息，继续运行不包含既有上下文消息。 */
	newMessages: AgentMessage[];
}

/** Replacement runtime state used by the agent loop before starting another provider request. */
/** Agent 循环发起下一次提供商请求前使用的替换运行时状态。 */
export interface AgentLoopTurnUpdate {
	/** Context for the next provider request. */
	/** 下一次提供商请求的上下文。 */
	context?: AgentContext;
	/** Model for the next provider request. */
	/** 下一次提供商请求使用的模型。 */
	model?: Model<any>;
	/** Thinking level for the next provider request. */
	/** 下一次提供商请求使用的思考级别。 */
	thinkingLevel?: ThinkingLevel;
}

export interface PrepareNextTurnContext extends ShouldStopAfterTurnContext {}

export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model<any>;

	/**
	 * Converts AgentMessage[] to LLM-compatible Message[] before each LLM call.
	 *
	 * Each AgentMessage must be converted to a UserMessage, AssistantMessage, or ToolResultMessage
	 * that the LLM can understand. AgentMessages that cannot be converted (e.g., UI-only notifications,
	 * status messages) should be filtered out.
	 *
	 * Contract: must not throw or reject. Return a safe fallback value instead.
	 * Throwing interrupts the low-level agent loop without producing a normal event sequence.
	 * 每次调用 LLM 前将 AgentMessage[] 转换为 LLM 可理解的 Message[]；无法转换的消息应过滤掉。
	 * 此函数不得抛出异常或拒绝 Promise，应返回安全的回退值，否则会中断底层循环的正常事件序列。
	 *
	 * @example
	 * ```typescript
	 * convertToLlm: (messages) => messages.flatMap(m => {
	 *   if (m.role === "custom") {
	 *     // Convert custom message to user message
	 *     return [{ role: "user", content: m.content, timestamp: m.timestamp }];
	 *   }
	 *   if (m.role === "notification") {
	 *     // Filter out UI-only messages
	 *     return [];
	 *   }
	 *   // Pass through standard LLM messages
	 *   return [m];
	 * })
	 * ```
	 */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/**
	 * Optional transform applied to the context before `convertToLlm`.
	 *
	 * Use this for operations that work at the AgentMessage level:
	 * - Context window management (pruning old messages)
	 * - Injecting context from external sources
	 *
	 * Contract: must not throw or reject. Return the original messages or another
	 * safe fallback value instead.
	 * 在 `convertToLlm` 之前对 AgentMessage 上下文应用的可选转换，可用于裁剪旧消息或注入外部上下文。
	 * 此函数不得抛出异常或拒绝 Promise，应返回原消息或其他安全回退值。
	 *
	 * @example
	 * ```typescript
	 * transformContext: async (messages) => {
	 *   if (estimateTokens(messages) > MAX_TOKENS) {
	 *     return pruneOldMessages(messages);
	 *   }
	 *   return messages;
	 * }
	 * ```
	 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	/**
	 * Resolves an API key dynamically for each LLM call.
	 *
	 * Useful for short-lived OAuth tokens (e.g., GitHub Copilot) that may expire
	 * during long-running tool execution phases.
	 *
	 * Contract: must not throw or reject. Return undefined when no key is available.
	 * 为每次 LLM 调用动态解析 API 密钥，适用于长时间工具执行期间可能过期的短期 OAuth 令牌。
	 * 此函数不得抛出异常或拒绝 Promise；没有可用密钥时返回 undefined。
	 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	/**
	 * Called after each turn fully completes and `turn_end` has been emitted.
	 *
	 * If it returns true, the loop emits `agent_end` and exits before polling steering or follow-up queues,
	 * without starting another LLM call. The current assistant response and any tool executions finish normally.
	 *
	 * Use this to request a graceful stop after the current turn, e.g. before context gets too full.
	 *
	 * Contract: must not throw or reject. Throwing interrupts the low-level agent loop without producing a normal event sequence.
	 * 每轮完全结束且已发送 `turn_end` 后调用。返回 true 时，循环会发送 `agent_end` 并退出，
	 * 不再轮询引导或后续队列；当前助手响应和工具执行仍会正常完成。
	 */
	shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;

	/**
	 * Called after `turn_end` and before the loop decides whether another provider request should start.
	 * Return replacement context/model/thinking state to affect the next turn in this run.
	 * Return undefined to keep using the current context/config.
	 * 在 `turn_end` 后、循环决定是否发起下一次提供商请求前调用。
	 * 返回替换的上下文、模型或思考状态以影响本次运行的下一轮；返回 undefined 则保留当前配置。
	 */
	prepareNextTurn?: (
		context: PrepareNextTurnContext,
	) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;

	/**
	 * Returns steering messages to inject into the conversation mid-run.
	 *
	 * Called after the current assistant turn finishes executing its tool calls, unless `shouldStopAfterTurn` exits first.
	 * If messages are returned, they are added to the context before the next LLM call.
	 * Tool calls from the current assistant message are not skipped.
	 *
	 * Use this for "steering" the agent while it's working.
	 *
	 * Contract: must not throw or reject. Return [] when no steering messages are available.
	 * 返回要在运行中途注入对话的引导消息。当前助手轮次完成工具调用后调用；
	 * 返回的消息会在下一次 LLM 调用前加入上下文。不得抛出异常或拒绝 Promise，无消息时返回 []。
	 */
	getSteeringMessages?: () => Promise<AgentMessage[]>;

	/**
	 * Returns follow-up messages to process after the agent would otherwise stop.
	 *
	 * Called when the agent has no more tool calls and no steering messages.
	 * If messages are returned, they're added to the context and the agent
	 * continues with another turn.
	 *
	 * Use this for follow-up messages that should wait until the agent finishes.
	 *
	 * Contract: must not throw or reject. Return [] when no follow-up messages are available.
	 * 返回在 Agent 原本将停止后处理的后续消息。没有更多工具调用和引导消息时调用；
	 * 返回消息后 Agent 会继续下一轮。不得抛出异常或拒绝 Promise，无消息时返回 []。
	 */
	getFollowUpMessages?: () => Promise<AgentMessage[]>;

	/**
	 * Tool execution mode.
	 * - "sequential": execute tool calls one by one
	 * - "parallel": preflight tool calls sequentially, then execute allowed tools concurrently;
	 *   emit `tool_execution_end` in tool completion order after each tool is finalized,
	 *   then emit tool-result message artifacts later in assistant source order
	 *
	 * Default: "parallel"
	 * 工具执行模式："sequential" 逐个执行；"parallel" 先顺序预检，再并发执行允许的工具。
	 * 默认值为 "parallel"。
	 */
	toolExecution?: ToolExecutionMode;

	/**
	 * Called before a tool is executed, after arguments have been validated.
	 *
	 * Return `{ block: true }` to prevent execution. The loop emits an error tool result instead.
	 * The hook receives the agent abort signal and is responsible for honoring it.
	 * 参数校验后、工具执行前调用。返回 `{ block: true }` 可阻止执行；钩子会收到 Agent 中止信号，
	 * 并负责响应该信号。
	 */
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;

	/**
	 * Called after a tool finishes executing, before `tool_execution_end` and tool-result message events are emitted.
	 *
	 * Return an `AfterToolCallResult` to override parts of the executed tool result:
	 * - `content` replaces the full content array
	 * - `details` replaces the full details payload
	 * - `isError` replaces the error flag
	 * - `terminate` replaces the early-termination hint
	 *
	 * Any omitted fields keep their original values. No deep merge is performed.
	 * The hook receives the agent abort signal and is responsible for honoring it.
	 * 工具执行结束后、发送完成事件和工具结果消息前调用。可返回 AfterToolCallResult 覆盖结果字段；
	 * 未提供的字段保留原值，不进行深度合并。钩子会收到 Agent 中止信号并负责响应。
	 */
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
}

/**
 * Thinking/reasoning level for models that support it.
 * Note: "xhigh" and "max" are only supported by selected model families. Use model
 * thinking-level metadata from @earendil-works/pi-ai to detect support for a concrete model.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Extensible interface for custom app messages.
 * Apps can extend via declaration merging:
 * 可扩展的自定义应用消息接口；应用可以通过声明合并进行扩展。
 *
 * @example
 * ```typescript
 * declare module "@mariozechner/agent" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 * ```
 */
export interface CustomAgentMessages {
	// Empty by default - apps extend via declaration merging
	// 默认为空，由应用通过声明合并扩展
}

/**
 * AgentMessage: Union of LLM messages + custom messages.
 * This abstraction allows apps to add custom message types while maintaining
 * type safety and compatibility with the base LLM messages.
 * AgentMessage 是 LLM 消息与自定义消息的联合类型；此抽象允许应用添加自定义消息类型，
 * 同时保持类型安全和与基础 LLM 消息的兼容性。
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

/**
 * Public agent state.
 *
 * `tools` and `messages` use accessor properties so implementations can copy
 * assigned arrays before storing them.
 * Agent 的公共状态。`tools` 与 `messages` 使用访问器属性，使实现可以在保存赋值数组前复制它们。
 */
export interface AgentState {
	/** System prompt sent with each model request. */
	/** 每次模型请求发送的系统提示。 */
	systemPrompt: string;
	/** Active model used for future turns. */
	/** 后续轮次使用的活动模型。 */
	model: Model<any>;
	/** Requested reasoning level for future turns. */
	/** 后续轮次请求的推理级别。 */
	thinkingLevel: ThinkingLevel;
	/** Available tools. Assigning a new array copies the top-level array. */
	/** 可用工具；赋入新数组时会复制顶层数组。 */
	set tools(tools: AgentTool<any>[]);
	get tools(): AgentTool<any>[];
	/** Conversation transcript. Assigning a new array copies the top-level array. */
	/** 对话记录；赋入新数组时会复制顶层数组。 */
	set messages(messages: AgentMessage[]);
	get messages(): AgentMessage[];
	/**
	 * True while the agent is processing a prompt or continuation.
	 *
	 * This remains true until awaited `agent_end` listeners settle.
	 * Agent 正在处理提示或继续操作时为 true；直到等待中的 `agent_end` 监听器完成前都会保持 true。
	 */
	readonly isStreaming: boolean;
	/** Partial assistant message for the current streamed response, if any. */
	/** 当前流式响应的部分助手消息（如有）。 */
	readonly streamingMessage?: AgentMessage;
	/** Tool call ids currently executing. */
	/** 当前正在执行的工具调用 ID。 */
	readonly pendingToolCalls: ReadonlySet<string>;
	/** Error message from the most recent failed or aborted assistant turn, if any. */
	/** 最近一次失败或中止的助手轮次所产生的错误消息（如有）。 */
	readonly errorMessage?: string;
}

/** Final or partial result produced by a tool. */
/** 工具生成的最终或部分结果。 */
export interface AgentToolResult<T> {
	/** Text or image content returned to the model. */
	/** 返回给模型的文本或图像内容。 */
	content: (TextContent | ImageContent)[];
	/** Arbitrary structured details for logs or UI rendering. */
	/** 用于日志或 UI 渲染的任意结构化详情。 */
	details: T;
	/** Names of tools introduced by this result and available from this transcript point onward. */
	addedToolNames?: string[];
	/**
	 * Hint that the agent should stop after the current tool batch.
	 * Early termination only happens when every finalized tool result in the batch sets this to true.
	 * 提示 Agent 在当前工具批次后停止；仅当批次中所有最终结果均设为 true 时才提前终止。
	 */
	terminate?: boolean;
}

/**
 * Callback used by tools to stream partial execution updates.
 *
 * The callback is scoped to the current `execute()` invocation. Calls made after
 * the tool promise settles are ignored.
 * 工具用于流式发送部分执行更新的回调。回调仅对当前 `execute()` 调用有效；
 * 工具 Promise 完成后的调用会被忽略。
 */
export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;

/** Tool definition used by the agent runtime. */
/** Agent 运行时使用的工具定义。 */
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
	/** Human-readable label for UI display. */
	/** 用于 UI 显示的易读标签。 */
	label: string;
	/**
	 * Optional compatibility shim for raw tool-call arguments before schema validation.
	 * Must return an object that matches `TParameters`.
	 * 在架构校验前处理原始工具调用参数的可选兼容层；必须返回符合 `TParameters` 的对象。
	 */
	prepareArguments?: (args: unknown) => Static<TParameters>;
	/** Execute the tool call. Throw on failure instead of encoding errors in `content`. */
	/** 执行工具调用；失败时抛出异常，不要将错误编码到 `content` 中。 */
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
	/**
	 * Per-tool execution mode override.
	 * - "sequential": this tool must execute one at a time with other tool calls.
	 * - "parallel": this tool can execute concurrently with other tool calls.
	 *
	 * If omitted, the default execution mode applies.
	 * 单个工具的执行模式覆盖；省略时使用默认执行模式。
	 */
	executionMode?: ToolExecutionMode;
}

/** Context snapshot passed into the low-level agent loop. */
/** 传入底层 Agent 循环的上下文快照。 */
export interface AgentContext {
	/** System prompt included with the request. */
	/** 请求中包含的系统提示。 */
	systemPrompt: string;
	/** Transcript visible to the model. */
	/** 模型可见的对话记录。 */
	messages: AgentMessage[];
	/** Tools available for this run. */
	/** 本次运行可用的工具。 */
	tools?: AgentTool<any>[];
}

/**
 * Events emitted by the Agent for UI updates.
 *
 * `agent_end` is the last event emitted for a run, but awaited `Agent.subscribe()`
 * listeners for that event are still part of run settlement. The agent becomes
 * idle only after those listeners finish.
 * Agent 为 UI 更新发送的事件。`agent_end` 是一次运行的最后一个事件，但等待中的
 * `Agent.subscribe()` 监听器仍属于运行完成过程；只有这些监听器完成后 Agent 才进入空闲状态。
 */
export type AgentEvent =
	// Agent lifecycle
	// Agent 生命周期
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	// Turn lifecycle - a turn is one assistant response + any tool calls/results
	// 轮次生命周期——一轮包含一次助手响应及其工具调用/结果
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	// Message lifecycle - emitted for user, assistant, and toolResult messages
	// 消息生命周期——针对 user、assistant 和 toolResult 消息发送
	| { type: "message_start"; message: AgentMessage }
	// Only emitted for assistant messages during streaming
	// 仅在助手消息流式传输期间发送
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	// Tool execution lifecycle
	// 工具执行生命周期
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
