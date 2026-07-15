import type { PathMetadata } from "./package-manager.ts";

export type SourceScope = "user" | "project" | "temporary";
export type SourceOrigin = "package" | "top-level";

export interface SourceInfo {
	path: string;
	source: string;
	scope: SourceScope;
	origin: SourceOrigin;
	baseDir?: string;
}

export function createSourceInfo(path: string, metadata: PathMetadata): SourceInfo {
	// Preserve package-manager provenance verbatim so diagnostics and UI agree on resource ownership.
	// 原样保留包管理器来源信息，使诊断与 UI 对资源归属保持一致。
	return {
		path,
		source: metadata.source,
		scope: metadata.scope,
		origin: metadata.origin,
		baseDir: metadata.baseDir,
	};
}

export function createSyntheticSourceInfo(
	path: string,
	options: {
		source: string;
		scope?: SourceScope;
		origin?: SourceOrigin;
		baseDir?: string;
	},
): SourceInfo {
	// Synthetic resources default to temporary top-level ownership because no package metadata exists.
	// 合成资源没有包元数据，因此默认归属临时顶层来源。
	return {
		path,
		source: options.source,
		scope: options.scope ?? "temporary",
		origin: options.origin ?? "top-level",
		baseDir: options.baseDir,
	};
}
