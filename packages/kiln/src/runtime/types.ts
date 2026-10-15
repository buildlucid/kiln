import type { Diagnostic, KilnSyntaxError } from "../errors.js";
import type { EscapeStrategy, TemplateNode } from "../parser/ast.js";
import type { Source, Span } from "../source.js";

/** The part of `AbortSignal` Kiln reads. A real `AbortSignal` fits. */
export type AbortSignalLike = { readonly aborted: boolean };

/**
 * Variables visible at one point of a render. Scopes are null-prototype objects chained with `Object.create`, ending at the globals.
 */
export type Scope = { [key: string | symbol]: unknown };

/**
 * An output buffer. Strings are appended to `s`.
 *
 * Only the `root` buffer counts towards `maxOutputLength`; captures, such as block `set` and macro bodies, are each capped at that length instead, so captured text is not counted twice when it is printed.
 */
export type Out = { s: string; root?: boolean };

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
};

export type BlockDef = {
	body: Stmt;
	strategy: EscapeStrategy | false;
};

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
	macros: Map<string, CompiledMacro>;
	/** Resolved names of imported templates, by import slot. */
	imports: { name: string; span: Span }[];
	/** Every slot name the template outputs, so `slots` always has a key for each. */
	slotNames: string[];
};

/** Content a caller passed into a component slot, with the scope it renders in. */
export type SlotFill = { body: Stmt; run: Run; scope: Scope };

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
	size = 0;
	/** Nesting of `block()` and `parent()` calls, checked against `maxDepth`. */
	blockDepth = 0;
	readonly importsCache = new Map<CompiledTemplate, CompiledTemplate[]>();

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

/** One template being rendered: the template, its blocks, slots and imports. */
export class Run {
	blocks: Map<string, BlockEntry[]> = NO_BLOCKS;
	imports: CompiledTemplate[] = [];
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
