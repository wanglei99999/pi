import { getKeybindings } from "../keybindings.ts";
import { Loader } from "./loader.ts";

/**
 * Loader that can be cancelled with Escape.
 * 可通过 Escape 键取消的加载器。
 * Extends Loader with an AbortSignal for cancelling async operations.
 * 在 Loader 基础上增加 AbortSignal，用于取消异步操作。
 *
 * @example
 * const loader = new CancellableLoader(tui, cyan, dim, "Working...");
 * loader.onAbort = () => done(null);
 * doWork(loader.signal).then(done);
 */
export class CancellableLoader extends Loader {
	private abortController = new AbortController();

	/**
	 * Called when user presses Escape
	 * 用户按下 Escape 时调用。
	 */
	onAbort?: () => void;

	/**
	 * AbortSignal that is aborted when user presses Escape
	 * 用户按下 Escape 时触发中止的 AbortSignal。
	 */
	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	/**
	 * Whether the loader was aborted
	 * 加载器是否已中止。
	 */
	get aborted(): boolean {
		return this.abortController.signal.aborted;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.abortController.abort();
			this.onAbort?.();
		}
	}

	dispose(): void {
		this.stop();
	}
}
