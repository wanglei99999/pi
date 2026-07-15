export interface DiagnosticErrorInfo {
	name?: string;
	message: string;
	stack?: string;
	code?: string | number;
}

export interface AssistantMessageDiagnostic {
	type: string;
	timestamp: number;
	error?: DiagnosticErrorInfo;
	details?: Record<string, unknown>;
}

export function formatThrownValue(value: unknown): string {
	// Normalize JavaScript's unrestricted thrown values into a displayable diagnostic message.
	// 将 JavaScript 可抛出的任意值规范化为可展示的诊断消息。
	if (value instanceof Error) return value.message || value.name;
	if (typeof value === "string") return value;
	return String(value);
}

export function extractDiagnosticError(error: unknown): DiagnosticErrorInfo {
	// Preserve common Error metadata while accepting non-Error throws without losing their value.
	// 保留常见 Error 元数据，同时兼容非 Error 抛出值且不丢失其内容。
	if (!(error instanceof Error)) return { name: "ThrownValue", message: formatThrownValue(error) };
	const code = (error as Error & { code?: unknown }).code;
	return {
		name: error.name || undefined,
		message: error.message || error.name,
		stack: error.stack,
		code: typeof code === "string" || typeof code === "number" ? code : undefined,
	};
}

export function createAssistantMessageDiagnostic(
	type: string,
	error: unknown,
	details?: Record<string, unknown>,
): AssistantMessageDiagnostic {
	// Timestamp diagnostics at capture time so multiple failures retain their causal order.
	// 在捕获时记录时间戳，使多个失败保留因果顺序。
	return { type, timestamp: Date.now(), error: extractDiagnosticError(error), details };
}

export function appendAssistantMessageDiagnostic<T extends { diagnostics?: AssistantMessageDiagnostic[] }>(
	message: T,
	diagnostic: AssistantMessageDiagnostic,
): void {
	// Replace the array instead of mutating it in place so observers can detect a diagnostic update.
	// 通过替换数组而非原地修改，使观察者能够检测到诊断更新。
	message.diagnostics = [...(message.diagnostics ?? []), diagnostic];
}
