// The web APIs streaming uses beyond ECMAScript, which Node 24 and Cloudflare Workers both have. Declared here so the
// core package compiles without DOM or Node types. Hosts' own declarations apply to the published types.

interface ReadableStreamDefaultController<R> {
	enqueue(chunk: R): void;
	close(): void;
	error(reason?: unknown): void;
}

interface ReadableStream<R> {
	readonly locked: boolean;
}

declare var ReadableStream: {
	new <R>(source: {
		start?(controller: ReadableStreamDefaultController<R>): void;
		cancel?(reason?: unknown): void;
	}): ReadableStream<R>;
};

interface TextEncoder {
	encode(input: string): Uint8Array;
}

declare var TextEncoder: { new (): TextEncoder };

declare function setTimeout(callback: () => void, ms: number): number;
declare function clearTimeout(id: number): void;
