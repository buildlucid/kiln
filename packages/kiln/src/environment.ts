import { type Analysis, analyzeTemplate } from "./analyzer.js";
import { builtinFilters } from "./builtins/filters.js";
import { builtinFunctions, builtinTests } from "./builtins/functions.js";
import { compileTemplate } from "./compiler/compiler.js";
import { type Diagnostic, type KilnIssue, KilnRenderError } from "./errors.js";
import { resolveTemplateName } from "./names.js";
import type { EscapeStrategy } from "./parser/ast.js";
import { ESCAPE_STRATEGIES } from "./parser/ast.js";
import { addSlotFlags, isPromise, renderTemplate } from "./runtime/render.js";
import {
	type AbortSignalLike,
	type CallableEntry,
	type CompiledTemplate,
	type EnvironmentCore,
	type RenderInfo,
	RenderState,
	type Scope,
} from "./runtime/types.js";
import { hashKeys, isPlainObject, setOwn } from "./runtime/values.js";

export type { RenderInfo };

/** Where templates come from. Kiln calls `load` once per resolved name, until `invalidate`. */
export type Loader = {
	/** Returns the source for a resolved name, such as `pages/page.kiln`, or `null` if it does not exist. */
	load(name: string): string | null | Promise<string | null>;
};

const renderAware: unique symbol = Symbol("kiln.renderAware");

/** A host function that receives `RenderInfo` before its arguments. Create it with `withRender`. */
export type RenderAware<State> = {
	readonly [renderAware]: true;
	readonly call: (render: RenderInfo<State>, ...args: never) => unknown;
};

/** A function, filter or test a host registers. Parameter types are the host's to declare. */
export type KilnCallable<State = undefined> =
	| ((...args: never) => unknown)
	| RenderAware<State>;

export type Limits = {
	/** Characters of output, counted as string length. */
	maxOutputLength: number;
	/** Tags, outputs, loop iterations and calls executed. */
	maxSteps: number;
	/** Nested includes, components, macro calls and layouts. */
	maxDepth: number;
};

export type KilnOptions<State = undefined> = {
	loader: Loader;
	functions?: Record<string, KilnCallable<State>>;
	filters?: Record<string, KilnCallable<State>>;
	tests?: Record<string, KilnCallable<State>>;
	globals?: Record<string, unknown>;
	/** Undefined variables and missing properties are errors. Default `true`. */
	strict?: boolean;
	/** Default escaping strategy for `{{ }}`. Default `"html"`. */
	autoescape?: EscapeStrategy | false;
	/** Default `Intl` locale. Default `"en"`. */
	locale?: string;
	/** Default time zone for `formatDate`. Default `"UTC"`. */
	timeZone?: string;
	/** Enables `dump`. Default `false`. */
	debug?: boolean;
	limits?: Partial<Limits>;
};

type BaseRenderOptions = {
	locale?: string;
	timeZone?: string;
	/** Stops the render when aborted. A real `AbortSignal` works. */
	signal?: AbortSignalLike;
};

/** `state` is required when the environment was created with a `State` type. */
export type RenderOptions<State = undefined> = BaseRenderOptions &
	(undefined extends State ? { state?: State } : { state: State });

type RenderOptionsArgument<State> = undefined extends State
	? [options?: RenderOptions<State>]
	: [options: RenderOptions<State>];

export type Kiln<State = undefined> = {
	/** Renders a template. Rejects with `KilnSyntaxError` or `KilnRenderError`. */
	render(
		name: string,
		context?: Record<string, unknown>,
		...options: RenderOptionsArgument<State>
	): Promise<string>;
	/**
	 * Renders one block of a template, such as a fragment for an htmx or fetch request. Child templates' top-level statements run first, as in `render`.
	 */
	renderBlock(
		name: string,
		block: string,
		context?: Record<string, unknown>,
		...options: RenderOptionsArgument<State>
	): Promise<string>;
	/** Parses and checks a template without rendering it. Pass `source` to check unsaved text. */
	check(name: string, source?: string): Promise<Diagnostic[]>;
	/** Reports what a template uses: variables, props, functions, filters, tests, templates, blocks and macros. */
	analyze(name: string, source?: string): Promise<Analysis>;
	/** Drops one compiled template, or all of them, from the cache. */
	invalidate(name?: string): void;
};

/**
 * Wraps a host function so it receives request-specific `RenderInfo` first, including the `state` passed to `render`.
 *
 * ```ts
 * document: withRender((render, collection: string) => fetchDocument(collection, render.state.locale))
 * ```
 */
export const withRender = <State, Args extends unknown[], Result>(
	fn: (render: RenderInfo<State>, ...args: Args) => Result,
): RenderAware<State> => ({
	[renderAware]: true,
	call: fn as unknown as RenderAware<State>["call"],
});

const DEFAULT_LIMITS: Limits = {
	maxOutputLength: 5_000_000,
	maxSteps: 1_000_000,
	maxDepth: 64,
};

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TEST_NAME = /^[A-Za-z_][A-Za-z0-9_]*( [A-Za-z_][A-Za-z0-9_]*)?$/;
const RESERVED = {
	function: new Set(["parent", "block"]),
	filter: new Set(["default", "raw", "escape"]),
	test: new Set(["defined"]),
};

const registry = <State>(
	kind: "function" | "filter" | "test",
	builtins: Record<string, CallableEntry>,
	host: Record<string, KilnCallable<State>> | undefined,
): Map<string, CallableEntry> => {
	const entries = new Map<string, CallableEntry>(Object.entries(builtins));
	for (const [name, value] of Object.entries(host ?? {})) {
		if (!(kind === "test" ? TEST_NAME : NAME).test(name)) {
			throw new TypeError(`"${name}" is not a valid ${kind} name`);
		}
		if (RESERVED[kind].has(name)) {
			throw new TypeError(`"${name}" is a reserved ${kind} name`);
		}
		if (typeof value === "function") {
			entries.set(name, {
				kind: "host",
				name,
				call: value as (...args: unknown[]) => unknown,
				render: false,
			});
		} else if (
			typeof value === "object" &&
			value !== null &&
			renderAware in value
		) {
			entries.set(name, {
				kind: "host",
				name,
				call: value.call as (...args: unknown[]) => unknown,
				render: true,
			});
		} else {
			throw new TypeError(`${kind} "${name}" must be a function`);
		}
	}
	return entries;
};

class Environment<State> implements EnvironmentCore {
	readonly strict: boolean;
	readonly debug: boolean;
	readonly autoescape: EscapeStrategy | false;
	readonly functions: Map<string, CallableEntry>;
	readonly filters: Map<string, CallableEntry>;
	readonly tests: Map<string, CallableEntry>;
	readonly globals: Scope;
	readonly limits: Limits;
	readonly locale: string;
	readonly timeZone: string;
	readonly #loader: Loader;
	readonly #cache = new Map<
		string,
		CompiledTemplate | null | Promise<CompiledTemplate | null>
	>();

	constructor(options: KilnOptions<State>) {
		if (typeof options.loader?.load !== "function") {
			throw new TypeError("createKiln needs a loader with a load(name) method");
		}
		if (
			options.autoescape !== undefined &&
			options.autoescape !== false &&
			!ESCAPE_STRATEGIES.includes(options.autoescape)
		) {
			throw new TypeError(
				`Unknown escaping strategy "${String(options.autoescape)}"`,
			);
		}
		this.#loader = options.loader;
		this.strict = options.strict ?? true;
		this.debug = options.debug ?? false;
		this.autoescape = options.autoescape ?? "html";
		this.locale = options.locale ?? "en";
		this.timeZone = options.timeZone ?? "UTC";
		this.limits = { ...DEFAULT_LIMITS, ...options.limits };
		this.functions = registry("function", builtinFunctions, options.functions);
		this.filters = registry("filter", builtinFilters, options.filters);
		this.tests = registry("test", builtinTests, options.tests);

		const globals = Object.create(null) as Record<string, unknown>;
		const provided = options.globals ?? {};
		if (!isPlainObject(provided))
			throw new TypeError("globals must be a plain object");
		for (const key of hashKeys(provided)) setOwn(globals, key, provided[key]);
		this.globals = globals;
	}

	load(
		name: string,
	): CompiledTemplate | null | Promise<CompiledTemplate | null> {
		const cached = this.#cache.get(name);
		if (cached !== undefined) return cached;

		const finish = (source: string | null) => {
			if (source !== null && typeof source !== "string") {
				throw new TypeError(`Loader returned a ${typeof source} for "${name}"`);
			}
			const template =
				source === null ? null : compileTemplate(this, name, source);
			this.#cache.set(name, template);
			return template;
		};

		const loaded = this.#loader.load(name);
		if (isPromise(loaded)) {
			const pending = loaded.then(finish, (error: unknown) => {
				this.#cache.delete(name);
				throw error;
			});
			this.#cache.set(name, pending);
			return pending;
		}
		return finish(loaded);
	}

	invalidate(name?: string): void {
		if (name === undefined) this.#cache.clear();
		else this.#cache.delete(resolveTemplateName(name));
	}

	/** Compiles unsaved source, or loads the template, for `check` and `analyze`. */
	async compileFor(
		name: string,
		source?: string,
	): Promise<CompiledTemplate | null> {
		const resolved = resolveTemplateName(name);
		if (source !== undefined) return compileTemplate(this, resolved, source);
		return await this.load(resolved);
	}

	/** Renders a template, or only one of its blocks when `block` is given. */
	async render(
		name: string,
		context: Record<string, unknown> = {},
		options: BaseRenderOptions & { state?: State } = {},
		block?: string,
	): Promise<string> {
		let resolved: string;
		try {
			resolved = resolveTemplateName(name);
		} catch (error) {
			const issue = error as KilnIssue;
			throw new KilnRenderError(issue.code, issue.message, name);
		}
		let template = this.load(resolved);
		if (isPromise(template)) template = await template;
		if (!template) {
			throw new KilnRenderError(
				"missing-template",
				`Template "${resolved}" was not found`,
				resolved,
			);
		}
		if (template.hasErrors) throw template.syntaxError();
		if (!isPlainObject(context)) {
			throw new TypeError("render context must be a plain object");
		}

		const state = new RenderState(
			this,
			this.globals,
			this.limits.maxSteps,
			this.limits.maxOutputLength,
			this.limits.maxDepth,
			options.locale ?? this.locale,
			options.timeZone ?? this.timeZone,
			options.state,
			options.signal,
		);
		if (options.signal?.aborted) {
			throw new KilnRenderError("aborted", "Render was aborted", resolved);
		}

		const scope = Object.create(this.globals) as Scope;
		const passed = hashKeys(context);
		for (const key of passed)
			setOwn(scope as Record<string, unknown>, key, context[key]);
		addSlotFlags(scope, template, null);

		const out = { s: "", root: true };
		const result = renderTemplate(state, template, scope, out, {
			depth: 0,
			slots: null,
			passed,
			inherited: null,
			caller: null,
			block,
		});
		if (result !== undefined) await result;
		return out.s;
	}
}

/**
 * Creates a Kiln environment: the loader, functions, filters, tests, globals and options every render uses.
 *
 * ```ts
 * const kiln = createKiln({ loader: memoryLoader({ "page.kiln": "<h1>{{ title }}</h1>" }) });
 * const html = await kiln.render("page", { title: "Home" });
 * ```
 */
export const createKiln = <State = undefined>(
	options: KilnOptions<State>,
): Kiln<State> => {
	const env = new Environment<State>(options);
	return {
		render: (name, context, ...rest) =>
			env.render(
				name,
				context,
				(rest[0] ?? {}) as BaseRenderOptions & { state?: State },
			),
		renderBlock: (name, block, context, ...rest) => {
			if (typeof block !== "string") {
				throw new TypeError("renderBlock needs a block name");
			}
			return env.render(
				name,
				context,
				(rest[0] ?? {}) as BaseRenderOptions & { state?: State },
				block,
			);
		},
		check: async (name, source) => {
			const template = await env.compileFor(name, source);
			if (!template) {
				const position = { offset: 0, line: 1, column: 1 };
				return [
					{
						code: "missing-template",
						message: `Template "${resolveTemplateName(name)}" was not found`,
						severity: "error",
						template: resolveTemplateName(name),
						start: position,
						end: position,
					},
				];
			}
			return template.diagnostics;
		},
		analyze: async (name, source) => {
			const template = await env.compileFor(name, source);
			if (!template) {
				throw new KilnRenderError(
					"missing-template",
					`Template "${resolveTemplateName(name)}" was not found`,
					resolveTemplateName(name),
				);
			}
			return analyzeTemplate(template, env.globals);
		},
		invalidate: (name) => env.invalidate(name),
	};
};

/**
 * A loader for templates held in memory, keyed by name. Keys without an extension get `.kiln`.
 *
 * Works on every runtime, including Cloudflare Workers.
 */
export const memoryLoader = (
	templates: Record<string, string> | Map<string, string>,
): Loader => {
	const map = new Map<string, string>();
	const entries =
		templates instanceof Map ? templates : Object.entries(templates);
	for (const [name, source] of entries) {
		map.set(resolveTemplateName(name), source);
	}
	return { load: (name) => map.get(name) ?? null };
};
