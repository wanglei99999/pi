export function getPiUserAgent(version: string): string {
	// Report product, runtime, platform, and architecture without including host- or user-specific identifiers.
	// 上报产品、运行时、平台和架构，但不包含主机或用户专属标识。
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `pi/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
