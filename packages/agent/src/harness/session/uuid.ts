let lastTimestamp = -Infinity;
let sequence = 0;
// Process-local timestamp and sequence state make generated UUIDs monotonic even within one millisecond or after clock rollback.
// 进程内 timestamp 和 sequence 状态保证同一毫秒内或时钟回退后生成的 UUID 仍保持单调。

function fillRandomBytes(bytes: Uint8Array): void {
	// Prefer cryptographic randomness when available; Math.random is a compatibility fallback, not a security guarantee.
	// 优先使用密码学随机源；Math.random 仅用于兼容降级，不提供安全保证。
	const crypto = globalThis.crypto;
	if (crypto?.getRandomValues) {
		crypto.getRandomValues(bytes);
		return;
	}
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = Math.floor(Math.random() * 256);
	}
}

export function uuidv7(): string {
	// UUIDv7 places a 48-bit Unix millisecond timestamp first, so canonical strings sort primarily by creation time.
	// UUIDv7 将 48 位 Unix 毫秒时间戳放在开头，因此规范字符串主要按创建时间排序。
	const random = new Uint8Array(16);
	fillRandomBytes(random);
	const timestamp = Date.now();

	if (timestamp > lastTimestamp) {
		// Seed the per-timestamp sequence randomly to retain entropy while later calls increment deterministically.
		// 每个新时间戳随机初始化 sequence，保留熵；同一时间戳下的后续调用再确定性递增。
		sequence = random[6] * 0x1000000 + random[7] * 0x10000 + random[8] * 0x100 + random[9];
		lastTimestamp = timestamp;
	} else {
		// Reuse the last logical timestamp when the clock stalls or moves backward, preserving lexical monotonicity.
		// 时钟停滞或回退时继续使用上一个逻辑时间戳，以保持字典序单调。
		sequence = (sequence + 1) >>> 0;
		if (sequence === 0) {
			// A 32-bit sequence wrap advances logical time by one millisecond before reusing sequence zero.
			// 32 位 sequence 回绕时先把逻辑时间推进一毫秒，再复用 sequence zero。
			lastTimestamp++;
		}
	}

	const bytes = new Uint8Array(16);
	// Encode timestamp in big-endian order, then set the version 7 nibble and RFC variant bits around the sequence.
	// 时间戳按大端序编码，随后在 sequence 周围设置 version 7 半字节和 RFC variant 位。
	bytes[0] = (lastTimestamp / 0x10000000000) & 0xff;
	bytes[1] = (lastTimestamp / 0x100000000) & 0xff;
	bytes[2] = (lastTimestamp / 0x1000000) & 0xff;
	bytes[3] = (lastTimestamp / 0x10000) & 0xff;
	bytes[4] = (lastTimestamp / 0x100) & 0xff;
	bytes[5] = lastTimestamp & 0xff;
	bytes[6] = 0x70 | ((sequence >>> 28) & 0x0f);
	bytes[7] = (sequence >>> 20) & 0xff;
	bytes[8] = 0x80 | ((sequence >>> 14) & 0x3f);
	bytes[9] = (sequence >>> 6) & 0xff;
	bytes[10] = ((sequence & 0x3f) << 2) | (random[10] & 0x03);
	// The remaining low bits and trailing bytes stay random so IDs retain entropy beyond the monotonic sequence.
	// 剩余低位和尾部字节保持随机，使 ID 在单调 sequence 之外仍保留熵。
	bytes[11] = random[11];
	bytes[12] = random[12];
	bytes[13] = random[13];
	bytes[14] = random[14];
	bytes[15] = random[15];

	return formatUuid(bytes);
}

function formatUuid(bytes: Uint8Array): string {
	// Emit lowercase canonical UUID text with the standard 8-4-4-4-12 grouping; formatting performs no validation.
	// 输出小写规范 UUID 文本并使用标准 8-4-4-4-12 分组；格式化函数本身不执行校验。
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
	return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}
