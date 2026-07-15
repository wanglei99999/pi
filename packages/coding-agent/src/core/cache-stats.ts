import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "./session-manager.ts";

/**
 * Prompt-cache TTL: idle gaps longer than this are worth mentioning as the
 * likely cause of a miss. Anthropic's default cache TTL is 5 minutes.
 * 提示缓存空闲超过该时长时，UI 可将 TTL 过期作为未命中的可能原因；取值对应 Anthropic 默认 5 分钟。
 */
export const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Per-turn misses at or below this are cache breakpoint granularity noise.
 * 单轮未命中不超过该阈值时视为缓存断点粒度噪声，不计入浪费统计。
 */
const NOISE_FLOOR_TOKENS = 1024;

/**
 * A counted cache miss on a single assistant message.
 * 单条助手响应对应的有效缓存未命中及其成本、空闲时间和模型切换信息。
 */
export interface CacheMiss {
	/**
	 * Prompt tokens that were in the previous turn's prompt but not read from cache.
	 * 上一轮提示中已存在、但本轮没有从缓存读取的令牌数。
	 */
	missedTokens: number;
	/**
	 * Extra dollars paid vs. a full cache hit; 0 when pricing is unknown.
	 * 相比完整缓存命中多支付的成本；价格未知时为 0。
	 */
	missedCost: number;
	/**
	 * Milliseconds since the previous request (which last refreshed the cache).
	 * 距离上次刷新缓存的请求经过的毫秒数。
	 */
	idleMs: number;
	/**
	 * True when the model changed relative to the previous request.
	 * 相比上一请求发生模型切换时为 true。
	 */
	modelChanged: boolean;
}

export interface CacheWasteTotals {
	missedTokens: number;
	missedCost: number;
	/**
	 * Number of counted misses (turns above the noise floor).
	 * 超过噪声阈值并被计入的未命中轮次数。
	 */
	missCount: number;
}

/**
 * Minimal pricing lookup, satisfied by ModelRegistry. Cost is $/million tokens.
 * ModelRegistry 可满足的最小价格查询接口，价格单位为每百万令牌美元数。
 */
export interface ModelPriceSource {
	find(provider: string, modelId: string): { cost: { cacheRead: number } } | undefined;
}

/**
 * The last request seen by the scan; everything in its prompt should be cached.
 * 扫描到的上一请求；其提示内容理论上都应能在下一轮命中缓存。
 */
interface PreviousRequest {
	promptTokens: number;
	modelKey: string;
	timestamp: number;
	/**
	 * Sticky: some earlier request in this scan segment reported cache activity.
	 * Distinguishes a total miss on a cache-read-only provider (OpenAI-style,
	 * writes unreported) from a provider that never reports caching at all.
	 * 该粘性标记区分只报告缓存读取的提供商发生完全未命中，和提供商根本不报告缓存数据两种情况。
	 */
	reportedCache: boolean;
}

/**
 * Compute the cache miss for one assistant message relative to the previous
 * request. Returns undefined when nothing is counted: first turn, after a
 * reset, no cache activity ever reported (provider without cache support), or
 * miss below the noise floor.
 * 首轮、压缩重置后、从未报告缓存活动或未命中低于噪声阈值时均不计数。
 */
function detectMiss(
	prev: PreviousRequest | undefined,
	message: AssistantMessage,
	models: ModelPriceSource,
): CacheMiss | undefined {
	const usage = message.usage;
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	// A zero-cache turn only counts when cache activity was reported before:
	// on cache-read-only providers that is a total miss, while on providers
	// that never report caching it means nothing.
	// 只有此前确认提供商会报告缓存时，零缓存用量才代表完全未命中；否则无法判断其是否支持缓存。
	if (!prev || promptTokens <= 0 || (usage.cacheRead + usage.cacheWrite === 0 && !prev.reportedCache)) {
		return undefined;
	}

	const missedTokens = Math.min(prev.promptTokens, promptTokens) - usage.cacheRead;
	if (missedTokens <= NOISE_FLOOR_TOKENS) return undefined;

	// Extra cost = missed tokens billed at the actual paid rate (input/cacheWrite,
	// incl. write premium) instead of the cache-read rate. Missed tokens can only
	// land in the input or cacheWrite buckets, so the paid rate comes straight
	// from this message's own cost breakdown.
	// 额外成本按本轮 input/cacheWrite 的实际付费单价与 cacheRead 单价之差计算，包含缓存写入溢价。
	const paidTokens = usage.input + usage.cacheWrite;
	const paidPerToken = paidTokens > 0 ? (usage.cost.input + usage.cost.cacheWrite) / paidTokens : 0;
	const readPerToken =
		usage.cacheRead > 0
			? usage.cost.cacheRead / usage.cacheRead
			: (models.find(message.provider, message.model)?.cost.cacheRead ?? 0) / 1_000_000;

	return {
		missedTokens,
		missedCost: missedTokens * Math.max(0, paidPerToken - readPerToken),
		idleMs: Math.max(0, message.timestamp - prev.timestamp),
		modelChanged: `${message.provider}/${message.model}` !== prev.modelKey,
	};
}

function asPreviousRequest(message: AssistantMessage, reportedCache: boolean): PreviousRequest | undefined {
	const usage = message.usage;
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	if (promptTokens <= 0) return undefined;
	return {
		promptTokens,
		modelKey: `${message.provider}/${message.model}`,
		timestamp: message.timestamp,
		reportedCache: reportedCache || usage.cacheRead + usage.cacheWrite > 0,
	};
}

function scan(
	entries: SessionEntry[],
	models: ModelPriceSource,
): { prev: PreviousRequest | undefined; totals: CacheWasteTotals; misses: Map<AssistantMessage, CacheMiss> } {
	let prev: PreviousRequest | undefined;
	const totals: CacheWasteTotals = { missedTokens: 0, missedCost: 0, missCount: 0 };
	const misses = new Map<AssistantMessage, CacheMiss>();

	for (const entry of entries) {
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			// The context legitimately changed; the next turn's prompt is new content,
			// not re-billed content. Model switches are NOT exempt: they re-bill the
			// full prompt and should be counted.
			// 压缩或分支摘要会合法改变上下文，因此下一轮不是重复计费；模型切换则仍会重计完整提示，不能豁免。
			prev = undefined;
			continue;
		}
		if (entry.type === "message" && entry.message.role === "assistant") {
			const miss = detectMiss(prev, entry.message, models);
			if (miss) {
				totals.missedTokens += miss.missedTokens;
				totals.missedCost += miss.missedCost;
				totals.missCount += 1;
				misses.set(entry.message, miss);
			}
			prev = asPreviousRequest(entry.message, prev?.reportedCache ?? false) ?? prev;
		}
	}
	return { prev, totals, misses };
}

/**
 * Cumulative cache waste across a session: prompt tokens that should have been
 * cache reads (they were in the previous turn's prompt) but were re-billed.
 * 汇总整个会话中理论应命中缓存、却再次按输入或缓存写入计费的提示令牌与成本。
 */
export function computeCacheWaste(entries: SessionEntry[], models: ModelPriceSource): CacheWasteTotals {
	return scan(entries, models).totals;
}

/**
 * All counted cache misses across a session, keyed by the assistant message
 * (by reference) that paid for them. Used to re-derive transcript notices when
 * rebuilding the chat from entries (resume, post-compaction rebuild).
 * 以实际承担费用的助手消息引用为键收集未命中，用于恢复会话或压缩后重建聊天时重新生成提示。
 */
export function collectCacheMisses(
	entries: SessionEntry[],
	models: ModelPriceSource,
): Map<AssistantMessage, CacheMiss> {
	return scan(entries, models).misses;
}

/**
 * Detect a cache miss on a just-completed assistant message.
 * `entries` must not yet contain `message` (message_end fires before persistence).
 * 检测刚完成但尚未持久化的助手消息；message_end 先于写入发生，因此 entries 中不能已经包含该消息。
 */
export function detectCacheMiss(
	entries: SessionEntry[],
	message: AssistantMessage,
	models: ModelPriceSource,
): CacheMiss | undefined {
	return detectMiss(scan(entries, models).prev, message, models);
}
