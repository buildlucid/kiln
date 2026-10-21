import type { Effects } from "../compiler/effects.js";
import type { Diagnostic, KilnSyntaxError } from "../errors.js";
import type { EscapeStrategy, TemplateNode } from "../parser/ast.js";
import type { Source, Span } from "../source.js";
import type { Sequence } from "./ahead.js";
import type { IslandMode } from "./islands.js";
import {
	type Addition,
	type LateAddition,
	type OutletMark,
	recordAddition,
} from "./outlets.js";
import { childScope, isWithin, type Scope, sectionScope } from "./scope.js";
import type { RenderStream } from "./stream.js";

/**
 * The part of `AbortSignal` Kiln reads. A real `AbortSignal` fits. With the listener methods, a render stops as soon as
 * the signal aborts, even while it waits for your code. Without them, it stops at its next step.
 */
export type AbortSignalLike = {
	readonly aborted: boolean;
	addEventListener?(type: "abort", listener: () => void): void;
	removeEventListener?(type: "abort", listener: () => void): void;
};

export type { Scope };

/**
 * An output buffer. Strings are appended to `s`.
 *
 * Every buffer is capped at `maxOutputLength`, including captures such as block `set` and macro bodies, so captured text is only counted against the render's output when it is printed.
 */
export type Out = {
	s: string;
	/** For output that runs ahead of a part that waits, the buffer it ends up in; null otherwise. See `ahead.ts`. */
	ahead: Ahead | null;
};

/**
 * The buffers running ahead of the parts writing to `base`, a buffer that runs ahead of nothing, such as the render's
 * output. `size` is their length together, which counts against `maxOutputLength` with the base's own.
 */
export type Ahead = { readonly base: Out; size: number };

/** An empty output buffer. Captures start with one too, since what they capture is printed as a value. */
export const emptyOut = (): Out => ({ s: "", ahead: null });

/** A compiled statement. Returns a promise only when it had to wait for async data. */
export type Stmt = (run: Run, scope: Scope, out: Out) => void | Promise<void>;

/** A compiled expression. Returns a promise only when a call returned one. */
export type Ev = (run: Run, scope: Scope) => unknown;

export type Compiled = {
	ev: Ev;
	/** Whether `ev` may return a promise. */
	async: boolean;
	/** For arrow functions: whether calling the arrow may return a promise. */
	arrowAsync?: boolean;
	/** For literals: the value, so callers can use it at compile time. */
	constant?: { value: unknown };
	/** For property reads with literal keys, such as `a.b.c`: the parts, so a longer path can extend it. */
	path?: { root: Compiled; steps: PathStep[] };
	/** For variables outside `default`, `??` and `is defined`: the name, so outputs can look it up in place. */
	variable?: string;
	/** For `test ? yes : no` with literal branches and a test that never waits: the parts, so outputs can emit the branches once. */
	choice?: { test: Ev; yes: unknown; no: unknown };
};

/** One literal key of a property path. */
export type PathStep = {
	/** The key, when an own property of a plain object can be read with it directly. Null for blocked names and numbers. */
	name: string | null;
	/** The full read, for everything else: arrays, maps, class instances, null and missing keys. */
	read: (run: Run, target: unknown) => unknown;
	span: Span;
};

export type BlockDef = {
	body: Stmt;
	strategy: EscapeStrategy | false;
	/**
	 * The body may set variables, so it renders in a scope of its own, which keeps them in the block. Bodies that
	 * don't render in the scope around them, which saves making one.
	 */
	sets: boolean;
};

/** The scope a block's body renders in: its own when it may set variables. */
export const blockScope = (def: BlockDef, scope: Scope): Scope =>
	def.sets ? childScope(scope) : scope;

/** A block definition bound to the render of the template that defined it. */
export type BlockEntry = { def: BlockDef; run: Run };

export type CompiledMacro = {
	name: string;
	params: { name: string; default: Compiled | null }[];
	body: Stmt;
	strategy: EscapeStrategy | false;
	template: CompiledTemplate;
};

export type CompiledTemplate = {
	name: string;
	source: Source;
	ast: TemplateNode;
	diagnostics: Diagnostic[];
	hasErrors: boolean;
	syntaxError: () => KilnSyntaxError;
	/** For a child template, runs only its top-level `set`, `props` and similar statements. */
	body: Stmt;
	/** The `props` tag, also run on its own when `renderBlock` reaches the top-most template. */
	props: Stmt | null;
	/** The `extends` expression, when the template has one. */
	parent: Compiled | null;
	parentSpan: Span;
	blocks: Map<string, BlockDef>;
	/** `blocks` as a list, made on first render, since a template's blocks never change once compiled. */
	blockList: readonly (readonly [string, BlockDef])[] | undefined;
	macros: Map<string, CompiledMacro>;
	/** Top-level `export` values by name, which only `evaluate` runs. */
	exports: Map<string, Compiled>;
	/** Resolved names of imported templates, by import slot. */
	imports: { name: string; span: Span }[];
	/** Templates this template's includes, components and layouts name, so each name is resolved once. */
	resolved: Map<string, TemplateRef>;
	/** For names made of a known prefix and a key, such as `"sections/" ~ type`: templates by prefix, then key. */
	keyed: Map<string, Map<string, TemplateRef>> | undefined;
	/** Every slot name the template outputs, so `slots` always has a key for each. */
	slotNames: string[];
	/**
	 * It extends nothing, defines no blocks and imports nothing, as most partials, so it renders without
	 * `renderTemplate`.
	 */
	plain: boolean;
	/** The top-level statements, which a page's top-level statements may gate while they wait. See `Gate`. */
	top: Sequence | null;
	/** For a page, what its top-level statements read and set, or null when its layout must wait for them. */
	early: (() => Effects | null) | null;
	/** A host component from the loader, which can't be extended or imported. See `compileHost`. */
	host?: true;
};

/**
 * A template name a template uses, resolved, and the template it found, while the environment's `generation` is the
 * same, so later renders skip loading it.
 */
export type TemplateRef = {
	resolved: string;
	template: CompiledTemplate | null;
	generation: number;
};

/** Content a caller passed into a component slot, with the scope it renders in. */
export type SlotFill = {
	body: Stmt;
	run: Run;
	scope: Scope;
	/** The body may set variables, so it renders in a scope of its own, as a block's does. See `BlockDef`. */
	sets: boolean;
};

/**
 * The scope a slot's fill renders in, from the slot's render `run`: its own when it may set variables. A fill from
 * outside the cached section rendering it gets a section of its own, so it can't change its caller's variables only
 * when the section isn't saved.
 */
export const fillScope = (fill: SlotFill, run: Run): Scope => {
	const section = run.capture?.section;
	if (section && !isWithin(fill.scope, section.scope)) {
		return sectionScope(fill.scope);
	}
	return fill.sets ? childScope(fill.scope) : fill.scope;
};

/** A built-in callable. Receives the current render first. */
export type Builtin = (run: Run, ...args: unknown[]) => unknown;

export type CallableEntry =
	| {
			kind: "builtin";
			call: Builtin;
			/** Parameter names after the filtered or tested value, so named arguments such as `round(precision: 2)` find their place. */
			params?: readonly string[];
			/** Collects named arguments that match no parameter into a trailing options hash, such as `Intl` options. */
			options?: boolean;
	  }
	| {
			kind: "host";
			name: string;
			call: (...args: unknown[]) => unknown;
			/** Made with `withRender`, so it receives `RenderInfo` first. */
			render: boolean;
	  };

/** Checks a value against a host type, such as `Post`. Hosts register these with the `types` option. */
export type TypeCheck = (value: unknown) => boolean;

/**
 * Where the `cache` tag saves output, given as the `cache` option. See `memoryCache`. Each method takes one object, so
 * more details can be added without breaking stores.
 */
export type KilnCache = {
	/** Returns the value saved under `key`, or null when there is none. */
	get(entry: {
		key: string;
	}): string | null | undefined | Promise<string | null | undefined>;
	/**
	 * Saves `value` under `key`. The value is Kiln's own string, holding the HTML and what the section added to outlets,
	 * to save as it is. `seconds` is the tag's `for` value, or null to let the store decide. `tags` are the section's
	 * tags from `RenderInfo.tagCache`, sorted, for a store that clears copies by tag.
	 */
	set(entry: {
		key: string;
		value: string;
		seconds: number | null;
		tags: string[];
	}): void | Promise<void>;
};

/** What the runtime needs from the environment. */
export interface EnvironmentCore {
	readonly globals: Scope;
	readonly strict: boolean;
	readonly debug: boolean;
	readonly autoescape: EscapeStrategy | false;
	readonly functions: ReadonlyMap<string, CallableEntry>;
	readonly filters: ReadonlyMap<string, CallableEntry>;
	readonly tests: ReadonlyMap<string, CallableEntry>;
	readonly types: ReadonlyMap<string, TypeCheck>;
	/** The store for the `cache` tag. Without one, the tag renders its content every time. */
	readonly cache: KilnCache | null;
	/** App and build identity included in fragment cache keys. */
	readonly cacheNamespace: string;
	/** Goes up whenever `invalidate` drops templates, so templates found earlier are looked up again. */
	readonly generation: number;
	load(
		name: string,
	): CompiledTemplate | null | Promise<CompiledTemplate | null>;
}

export type RenderInfo<State = unknown> = {
	state: State;
	locale: string;
	timeZone: string;
	/** Resolved name of the template making the call. */
	template: string;
	signal: AbortSignalLike | undefined;
	/**
	 * Tags the cached section the call runs in, and every cached section around it, so a store can clear its copies
	 * when that data changes. Does nothing outside a cached section.
	 */
	tagCache(...tags: string[]): void;
	/**
	 * Adds HTML to an outlet, as `add to` does where the call happens. `once` adds it only the first time the render
	 * sees that key, which never clashes with an `add to once` tag.
	 */
	addTo(outlet: string, html: string, options?: { once?: string }): void;
};

/** Counters and settings for one call to `render`. */
export class RenderState {
	steps = 0;
	/** Parts of the render running ahead of a part that waits, and not joined yet. See `ahead.ts`. */
	ahead = 0;
	/** `add to` tags that ran ahead, which a `flush` must check came after it. See `checkLate`. */
	late: LateAddition[] | null = null;
	/** Imports loaded so far this render, by importing template. Made when a template first imports. */
	importsCache: Map<CompiledTemplate, CompiledTemplate[]> | null = null;
	/** The render's output, where outlets mark their places. Captures such as `set` write elsewhere. */
	root: Out | null = null;
	/** Outlets reached so far, by name, in the order reached. See `outlets.ts`. */
	outlets: Map<string, OutletMark> | null = null;
	/** How much of `root` has been taken as final output, and how many outlets' content with it. See `takeOutput`. */
	taken = 0;
	takenOutlets = 0;
	/** Sends output while the render waits, for `renderStream`. */
	stream: RenderStream | null = null;
	/** Every `add to` that ran outside any capture, and the captures started there, in order. See `Capture`. */
	additions: (Addition | Capture)[] | null = null;
	/** The first content of each `once` tag that added. */
	once: Map<string, string> | null = null;
	/** Whether `island` tags are deferred or streamed, or null to render them in place. */
	islands: IslandMode | null = null;
	/** The HTML of each streamed island, filling `<kiln-island stream="n">` at index n - 1, for `renderStream` to send. */
	streamed: Promise<string>[] | null = null;
	/** Whether the `<kiln-island>` script is in the render's output yet. */
	islandScript = false;

	constructor(
		readonly env: EnvironmentCore,
		readonly globals: Scope,
		readonly maxSteps: number,
		readonly maxSize: number,
		readonly maxDepth: number,
		readonly locale: string,
		readonly timeZone: string,
		readonly userState: unknown,
		readonly signal: AbortSignalLike | undefined,
	) {}
}

/** A part of a render that others run ahead of, and the part before it, if that one is run ahead of too. */
export type Behind = {
	readonly part: Promise<void>;
	readonly previous: Behind | null;
};

/**
 * A cached section rendering: its scope, whose content can't change variables outside it, the islands it deferred, and
 * its tags from `RenderInfo.tagCache`.
 */
export type Section = {
	readonly scope: Scope;
	readonly deferred: string[];
	readonly tags: Set<string>;
};

/**
 * A part of a render that keeps the `add to` content it adds in a log of its own: a cached section, or a macro,
 * `block()` or `parent()` call, which can render alongside others while promises are pending. Each capture takes its
 * place in the log around it when it starts, so outlets get content in the template's order however the parts finish,
 * and a cached section saves only its own. A render's `Run` carries the capture it is in.
 */
export class Capture {
	/** The additions made in it, and the captures started in it, in order. Made when the first is. */
	additions: (Addition | Capture)[] | null = null;

	constructor(
		/** The log of the capture or render it started in. */
		readonly outer: (Addition | Capture)[],
		/** The innermost cached section it is in, or null. */
		readonly section: Section | null,
		/**
		 * For a capture that runs ahead of parts that wait, or is inside one: the last of those parts, whose promises
		 * settle once every part of the render before it is done. Null otherwise. See `ahead.ts`.
		 */
		readonly behind: Behind | null,
	) {}
}

/** The log that additions made in `run` go to: its capture's, or the render's. */
export const additionLog = (run: Run): (Addition | Capture)[] => {
	const capture = run.capture;
	return capture ? (capture.additions ??= []) : (run.state.additions ??= []);
};

/** Starts a capture inside `run`'s. With `section`, it is a cached section. */
export const startCapture = (run: Run, section?: Section): Capture => {
	const outer = additionLog(run);
	const capture = new Capture(
		outer,
		section ?? run.capture?.section ?? null,
		run.capture?.behind ?? null,
	);
	outer.push(capture);
	return capture;
};

/**
 * Ends a capture that started inside `run`'s. One that added nothing leaves the log around it when it is last there,
 * as it is unless captures overlap, and a cached section's islands and tags join the section around it.
 */
export const endCapture = (run: Run, capture: Capture): void => {
	const outer = capture.outer;
	if (capture.additions === null && outer.at(-1) === capture) outer.pop();
	const section = run.capture?.section;
	if (section && capture.section && capture.section !== section) {
		for (const id of capture.section.deferred) section.deferred.push(id);
		for (const tag of capture.section.tags) section.tags.add(tag);
	}
};

/** Where errors from `addTo` point: the template making the call, as host code has no place in it. */
const HOST_SPAN = { start: 0, end: 0 };

const NO_BLOCKS = new Map<string, BlockEntry[]>();
/** The imports of a template that imports nothing, shared. */
export const NO_IMPORTS: readonly CompiledTemplate[] = [];

/** One template being rendered: the template, its blocks, slots and imports. */
export class Run {
	blocks: Map<string, BlockEntry[]> = NO_BLOCKS;
	imports: readonly CompiledTemplate[] = NO_IMPORTS;
	#info: RenderInfo | undefined;

	constructor(
		readonly state: RenderState,
		readonly template: CompiledTemplate,
		readonly depth: number,
		readonly slots: Map<string, SlotFill> | null,
		/** Variable names the caller passed, for `props` checks. */
		readonly passed: readonly string[] | null,
		/** The capture it renders in, or null. */
		readonly capture: Capture | null = null,
		/** Nesting of the `block()` and `parent()` calls this renders inside, checked against `maxDepth`. */
		readonly blockDepth = 0,
	) {}

	/**
	 * This render inside `capture`, for content that renders where a capture other than its own is open, such as a
	 * block placed in a cached section or a fill in a macro. `blockDepth` is the nesting of `block()` calls where the
	 * content is placed, since content from elsewhere carries on the chain of calls that placed it.
	 */
	within(capture: Capture | null, blockDepth = this.blockDepth): Run {
		if (capture === this.capture && blockDepth === this.blockDepth) return this;
		const run = new Run(
			this.state,
			this.template,
			this.depth,
			this.slots,
			this.passed,
			capture,
			blockDepth,
		);
		run.blocks = this.blocks;
		run.imports = this.imports;
		return run;
	}

	get info(): RenderInfo {
		this.#info ??= {
			state: this.state.userState,
			locale: this.state.locale,
			timeZone: this.state.timeZone,
			template: this.template.name,
			signal: this.state.signal,
			tagCache: (...tags) => {
				const section = this.capture?.section;
				for (const tag of tags) {
					if (typeof tag !== "string") {
						throw new TypeError("Cache tags must be strings");
					}
					section?.tags.add(tag);
				}
			},
			addTo: (outlet, html, options) => {
				if (typeof outlet !== "string" || typeof html !== "string") {
					throw new TypeError(
						"addTo needs an outlet name and HTML, as strings",
					);
				}
				const once = options?.once;
				// Template names can't hold a null character, so these keys never match an `add to once` tag's.
				recordAddition(this, HOST_SPAN, {
					outlet,
					html,
					once: once === undefined ? null : `\0${once}`,
				});
			},
		};
		return this.#info;
	}
}
