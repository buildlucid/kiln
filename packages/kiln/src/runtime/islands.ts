import type { Span } from "../source.js";
import { BLOCKED_NAMES } from "./exposure.js";
import { Markup } from "./markup.js";
import { closeOutlets, takeOutput } from "./outlets.js";
import {
	addSlotFlags,
	consume,
	fail,
	locating,
	markCaller,
	renderTemplate,
} from "./render.js";
import { childScope } from "./scope.js";
import {
	type CompiledTemplate,
	emptyOut,
	RenderState,
	type Run,
} from "./types.js";
import { isPlainObject, typeName } from "./values.js";

/*
 * Server islands.
 *
 * An island renders in place unless the render has an `islands` option. Either way the island writes a `<kiln-island>`
 * element holding its fallback:
 *
 * - `deferIslands(…)` records its template and props in the manifest under an id made from both. The host serves each
 *   id by rendering the manifest entry with `render`, and the element fetches that HTML.
 * - `streamIslands()` renders the island on its own while the page carries on, and `renderStream` sends its HTML after
 *   the page, in a `<template>` followed by a `<kiln-island fill>` that moves it into place.
 */

/** A value that survives JSON unchanged, which is what island props must be. */
export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

/** One deferred island: the template to render and the props to render it with. */
export type IslandEntry = {
	template: string;
	props: Record<string, JsonValue>;
};

/** Every island deferred in a build, by id. Hosts save it as JSON and look ids up in it. */
export type IslandManifest = Record<string, IslandEntry>;

/** The `islands` render option for static builds. Make it with `deferIslands`, and pass it to every render in a build. */
export type DeferredIslands = {
	readonly mode: "defer";
	/** The text before each island's id in its `src`, such as `"/_islands/"`. */
	readonly url: string;
	/** Whether Kiln writes the `<kiln-island>` script before the first island of each render. */
	readonly script: boolean;
	/** Every island deferred so far, by id. */
	readonly manifest: IslandManifest;
};

/**
 * Defers `island` tags in the renders it is passed to, recording each island in `manifest`.
 *
 * ```ts
 * const islands = deferIslands({ url: "/_islands/" });
 * const html = await kiln.render("pages/product", { product }, { islands });
 * await writeFile("build/islands.json", JSON.stringify(islands.manifest));
 * ```
 */
export const deferIslands = ({
	url,
	script = true,
}: {
	url: string;
	script?: boolean;
}): DeferredIslands => {
	if (typeof url !== "string") {
		throw new TypeError("deferIslands needs a url");
	}
	return { mode: "defer", url, script, manifest: {} };
};

/** The `islands` render option for `renderStream`. Make it with `streamIslands`. */
export type StreamedIslands = {
	readonly mode: "stream";
	/** Whether Kiln writes the `<kiln-island>` script before the first island of each render. */
	readonly script: boolean;
};

/**
 * Streams `island` tags in `renderStream`: the page is sent with each island's fallback, and each island's HTML follows
 * when it is ready. `render` and `renderBlock` can't stream, so they render islands in place.
 *
 * ```ts
 * const stream = await kiln.renderStream("pages/product", { product }, { islands: streamIslands() });
 * ```
 */
export const streamIslands = ({
	script = true,
}: {
	script?: boolean;
} = {}): StreamedIslands => ({ mode: "stream", script });

/** How a render treats `island` tags, when it doesn't render them in place. */
export type IslandMode = DeferredIslands | StreamedIslands;

/**
 * The source of the script that defines `<kiln-island>`. Serve it as a file when a Content Security Policy blocks
 * inline scripts, with `script: false`.
 *
 * - A deferred island's element fetches its `src`, and replaces itself with the response when it succeeds and is HTML.
 * - A streamed island's HTML arrives in a `<template>`, followed by `<kiln-island fill="n">`, which moves it in place of
 *   `<kiln-island stream="n">` once the template is parsed.
 *
 * Otherwise the fallback stays. Kept short and plain, since it is written into pages.
 */
export const islandScript =
	'customElements.get("kiln-island")||customElements.define("kiln-island",class extends HTMLElement{connectedCallback(){if(this.k)return;this.k=1;this.style.display="contents";const p=h=>document.createRange().createContextualFragment(h),f=this.getAttribute("fill"),s=this.getAttribute("src");if(f){const t=this.previousElementSibling,e=document.querySelector(`kiln-island[stream="${f}"]`);if(e&&t&&t.localName=="template")e.replaceWith(p(t.innerHTML)),t.remove();this.remove()}else if(s)fetch(s).then(r=>r.ok&&/^text\\/html/.test(r.headers.get("content-type"))?r.text():null).then(h=>{if(h!=null)this.replaceWith(p(h))},()=>{})}});';

/**
 * Copies an island's props as JSON values, or fails naming the first value that isn't one. Hashes may be maps, and
 * become plain objects.
 */
export const islandProps = (
	run: Run,
	span: Span,
	value: unknown,
): Record<string, JsonValue> => {
	const seen = new Set<object>();
	const invalid = (path: string, problem: string) =>
		fail(
			run,
			span,
			"type-error",
			`"island" props must be JSON values: null, booleans, numbers, strings, lists and hashes, but ${path === "" ? "they are" : `"${path}" is`} ${problem}`,
		);
	// Each list and hash is charged before it is copied, so props that share one object in many places can't make
	// unlimited work.
	const charge = (count: number) =>
		locating(run, span, () => consume(run, count));
	const copyHash = (
		hash: Record<string, unknown> | Map<unknown, unknown>,
		path: string,
	): Record<string, JsonValue> => {
		const result: Record<string, JsonValue> = {};
		const entries = hash instanceof Map ? [...hash] : Object.entries(hash);
		charge(entries.length);
		for (const [key, item] of entries) {
			if (typeof key !== "string") {
				throw invalid(path, "a hash with a key that isn't a string");
			}
			if (BLOCKED_NAMES.has(key)) continue;
			result[key] = copy(item, path === "" ? key : `${path}.${key}`);
		}
		return result;
	};
	const copy = (item: unknown, path: string): JsonValue => {
		if (item === null || item === undefined) return null;
		if (typeof item === "string" || typeof item === "boolean") return item;
		if (typeof item === "number") {
			if (Number.isFinite(item)) return item;
			throw invalid(path, String(item));
		}
		if (item instanceof Markup) {
			throw invalid(
				path,
				"markup. Pass the data, and build the markup in the island",
			);
		}
		if (
			!Array.isArray(item) &&
			!(item instanceof Map) &&
			!isPlainObject(item)
		) {
			throw invalid(path, `a ${typeName(item)}`);
		}
		if (seen.has(item)) throw invalid(path, "a value that contains itself");
		seen.add(item);
		if (Array.isArray(item)) charge(item.length);
		const result = Array.isArray(item)
			? item.map((entry, index) => copy(entry, `${path}[${index}]`))
			: copyHash(item, path);
		seen.delete(item);
		return result;
	};
	if (value === null || value === undefined) return {};
	if (!(value instanceof Map) && !isPlainObject(value)) {
		throw invalid("", `a ${typeName(value)}, not a hash`);
	}
	return copyHash(value, "");
};

/** A 64-bit hash of `text` as 16 hex digits: two 32-bit multiply-xor lanes, mixed together at the end. */
const hashId = (text: string): string => {
	let a = 0x811c9dc5;
	let b = 0x9e3779b9;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		a = Math.imul(a ^ code, 0x01000193);
		b = Math.imul(b ^ code, 0x5bd1e995);
	}
	a = Math.imul(a ^ (b >>> 15), 0x85ebca6b);
	b = Math.imul(b ^ (a >>> 13), 0xc2b2ae35);
	a ^= b >>> 16;
	b ^= a >>> 16;
	return (
		(a >>> 0).toString(16).padStart(8, "0") +
		(b >>> 0).toString(16).padStart(8, "0")
	);
};

/**
 * Records an island in the manifest and returns its id. The id comes from the template and props, so it is the same
 * on every page and in every build, and a page cached from an earlier build never asks for a different island.
 */
export const recordIsland = (
	run: Run,
	span: Span,
	islands: DeferredIslands,
	template: string,
	props: Record<string, JsonValue>,
): string => {
	const key = JSON.stringify([template, props]);
	const id = hashId(key);
	const { manifest } = islands;
	const existing = Object.hasOwn(manifest, id) ? manifest[id] : undefined;
	if (existing === undefined) manifest[id] = { template, props };
	else if (JSON.stringify([existing.template, existing.props]) !== key) {
		throw fail(
			run,
			span,
			"island-collision",
			`Two different islands have the id "${id}". Change one island's props slightly`,
		);
	}
	(run.state.deferred ??= []).push(id);
	return id;
};

/**
 * Starts rendering a streamed island on its own, with a render state of its own and the page's state, locale and
 * limits, as the host would render a deferred one. Returns its HTML wrapped to fill `<kiln-island stream="n">`.
 */
export const streamIsland = (
	run: Run,
	span: Span,
	template: CompiledTemplate,
	props: Record<string, JsonValue>,
	n: number,
): Promise<string> => {
	const page = run.state;
	const state = new RenderState(
		page.env,
		page.globals,
		page.maxSteps,
		page.maxSize,
		page.maxDepth,
		page.locale,
		page.timeZone,
		page.userState,
		page.signal,
	);
	const scope = childScope(page.globals);
	const passed = Object.keys(props);
	for (const key of passed) scope[key] = props[key] ?? null;
	addSlotFlags(scope, template, null);
	const out = emptyOut();
	state.root = out;
	return Promise.resolve()
		.then(() =>
			renderTemplate(
				state,
				template,
				scope,
				out,
				0,
				null,
				passed,
				null,
				null,
				template.parentSpan,
			),
		)
		.then(
			() => {
				closeOutlets(state);
				return `<template>${takeOutput(state, out.s)}</template><kiln-island fill="${n}"></kiln-island>`;
			},
			(error: unknown) => {
				throw markCaller(run, span, error);
			},
		);
};

export const ISLAND_CLOSING = "</kiln-island>";

export const ISLAND_SCRIPT = `<script>${islandScript}</script>`;
