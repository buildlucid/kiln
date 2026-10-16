import { closeOutlets, takeOutput } from "./outlets.js";
import type { Out, RenderState } from "./types.js";

/**
 * Sends a streamed render's output as it becomes final, for `renderStream`.
 *
 * Host code that returns a promise calls `wait`. The send happens once the render is really waiting, after the
 * microtasks already queued, so promises that settle at once share one send instead of making many small ones.
 */
export class RenderStream {
	#timer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		readonly state: RenderState,
		readonly root: Out,
		/** Sends a part of the page. Must not throw, since it runs from a timer. */
		readonly send: (text: string) => void,
	) {}

	/** The render is about to wait for host code. */
	wait(): void {
		this.#timer ??= setTimeout(() => {
			this.#timer = null;
			this.flush();
		}, 0);
	}

	/** Sends the output that is final so far. */
	flush(): void {
		const text = takeOutput(this.state, this.root.s);
		if (text !== "") this.send(text);
	}

	/** Sends the rest of the output, once the render has finished. */
	end(): void {
		this.stop();
		closeOutlets(this.state);
		this.flush();
	}

	/** Cancels a pending send. */
	stop(): void {
		if (this.#timer === null) return;
		clearTimeout(this.#timer);
		this.#timer = null;
	}
}
