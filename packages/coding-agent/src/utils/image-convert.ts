import { applyExifOrientation } from "./exif-orientation.ts";
import { loadPhoton } from "./photon.ts";

export async function convertImageBytesToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
	const photon = await loadPhoton();
	if (!photon) {
		// Photon not available, can't convert
		// Photon 不可用时无法转换，由调用方决定是否降级为非图片展示。
		return null;
	}

	try {
		const rawImage = photon.PhotonImage.new_from_byteslice(bytes);
		// 在导出 PNG 字节前应用 EXIF 方向，确保终端显示方向与常规图片查看器一致。
		const image = applyExifOrientation(photon, rawImage, bytes);
		// 方向修正可能返回新的 PhotonImage，此时原始 WASM 对象不再使用，应立即释放。
		if (image !== rawImage) rawImage.free();
		try {
			return new Uint8Array(image.get_bytes());
		} finally {
			// PhotonImage 持有 WASM 内存，导出完成或抛错后都必须释放。
			image.free();
		}
	} catch {
		// Conversion failed
		// 转换失败统一返回 null，避免底层解码错误泄漏到终端渲染流程。
		return null;
	}
}

/**
 * Convert image to PNG format for terminal display.
 * Kitty graphics protocol requires PNG format (f=100).
 * 将图片转换为终端显示所需的 PNG 格式。
 * Kitty graphics protocol 要求使用 PNG 格式（f=100）。
 */
export async function convertToPng(
	base64Data: string,
	mimeType: string,
): Promise<{ data: string; mimeType: string } | null> {
	// Already PNG, no conversion needed
	// 已是 PNG 时直接保留原始 base64 数据，避免无损格式的重复解码与编码。
	if (mimeType === "image/png") {
		return { data: base64Data, mimeType };
	}

	const bytes = new Uint8Array(Buffer.from(base64Data, "base64"));
	const pngBytes = await convertImageBytesToPng(bytes);
	if (!pngBytes) {
		return null;
	}

	return {
		data: Buffer.from(pngBytes).toString("base64"),
		mimeType: "image/png",
	};
}
