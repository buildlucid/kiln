import type { Diagnostic, KilnSyntaxError } from "../errors.js";
import type { EscapeStrategy, TemplateNode } from "../parser/ast.js";
import type { Source, Span } from "../source.js";
import { childScope, type Scope } from "./scope.js";

/** The part of `AbortSignal` Kiln reads. A real `AbortSignal` fits. */
export type AbortSignalLike = { readonly aborted: boolean };

export type { Scope };

/**
 * An output buffer. Strings are appended to `s`.
 *
 * Every buffer is capped at `maxOutputLength`, including captures such as block `set` and macro bodies, so captured text is only counted against the render's output when it is printed.
 */
export type Out = { s: string };

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
	blockList?: readonly (readonly [string, BlockDef])[];
	macros: Map<string, CompiledMacro>;
	/** Resolved names of imported templates, by import slot. */
	imports: { name: string; span: Span }[];
	/** Templates this template's includes, components and layouts name, so each name is resolved once. */
	resolved: Map<string, TemplateRef>;
	/** For names made of a known prefix and a key, such as `"sections/" ~ type`: templates by prefix, then key. */
	keyed?: Map<string, Map<string, TemplateRef>>;
	/** Every slot name the template outputs, so `slots` always has a key for each. */
	slotNames: string[];
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

/** The scope a slot's fill renders in: its own when it may set variables. */
export const fillScope = (fill: SlotFill): Scope =>
	fill.sets ? childScope(fill.scope) : fill.scope;

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

/** What the runtime needs from the environment. */
export interface EnvironmentCore {
	readonly strict: boolean;
	readonly debug: boolean;
	readonly autoescape: EscapeStrategy | false;
	readonly functions: ReadonlyMap<string, CallableEntry>;
	readonly filters: ReadonlyMap<string, CallableEntry>;
	readonly tests: ReadonlyMap<string, CallableEntry>;
	readonly types: ReadonlyMap<string, TypeCheck>;
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
};

/** Counters and settings for one call to `render`. */
export class RenderState {
	steps = 0;
	/** Nesting of `block()` and `parent()` calls, checked against `maxDepth`. */
	blockDepth = 0;
	/** Imports loaded so far this render, by importing template. Made when a template first imports. */
	importsCache: Map<CompiledTemplate, CompiledTemplate[]> | null = null;

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
	) {}

	get info(): RenderInfo {
		this.#info ??= {
			state: this.state.userState,
			locale: this.state.locale,
			timeZone: this.state.timeZone,
			template: this.template.name,
			signal: this.state.signal,
		};
		return this.#info;
	}
}
