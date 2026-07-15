import { stream, streamSimple } from "./api/bedrock-converse-stream.ts";

// Static Bun override exposing the same stream contract as the lazy Node-facing Bedrock module.
// Bun 静态覆盖模块，暴露与 Node 侧延迟 Bedrock 模块相同的 stream 契约。
export const bedrockProviderModule = {
	stream,
	streamSimple,
};
