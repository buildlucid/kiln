import { type Analysis, analyzeTemplate } from "./analyzer.js";
import { builtinFilters } from "./builtins/filters.js";
import { builtinFunctions, builtinTests } from "./builtins/functions.js";
import { checkReferences } from "./checker.js";
import { generateModule } from "./compiler/codegen.js";
import { compileTemplate } from "./compiler/compiler.js";
import {
	compilePrecompiled,
	isPrecompiled,
	type PrecompiledTemplate,
} from "./compiler/precompiled.js";
import { type Diagnostic, type KilnIssue, KilnRenderError } from "./errors.js";
import { resolveTemplateName } from "./names.js";
import type { EscapeStrategy } from "./parser/ast.js";
import { ESCAPE_STRATEGIES } from "./parser/ast.js";
import { addSlotFlags, isPromise, renderTemplate } from "./runtime/render.js";
import { childScope } from "./runtime/scope.js";
import {
	type AbortSignalLike,
	type CallableEntry,
	type CompiledTemplate,
	type EnvironmentCore,
	type RenderInfo,
	RenderState,
	type Scope,
	type TypeCheck,
} from "./runtime/types.js";
import { hashKeys, isPlainObject } from "./runtime/values.js";

export type { RenderInfo };

/** Where templates come from. Kiln calls `load` once per resolved name, until `invalidate`. */
export type Loader = {
	/**
	 * Returns the source for a resolved name, such as `pages/page.kiln`, or a precompiled module's default export, or
	 * `null` if it does not exist.
	 */
	load(
		name: string,
	):
		| string
		| PrecompiledTemplate
		| null
		| Promise<string | PrecompiledTemplate | null>;
	/** Returns every resolved name the loader holds. Rendering never calls it; tools such as `generateTypes` do. */
	list?(): string[] | Promise<string[]>;
};

/**
 * TypeScript types for host prop types, such as `Post`. Empty until the host adds to it:
 *
 * ```ts
 * declare module "@lucidcms/kiln" {
 * 	interface KilnTypes { Post: PostView }
 * }
 * ```
 */
// oxlint-disable-next-line typescript/no-empty-interface, typescript/no-empty-object-type -- filled in by declaration merging
export interface KilnTypes {}

/**
 * The data and block names of each template, keyed by name without `.kiln`. Empty until the file `generateTypes` writes fills it in, so `render` accepts any name and data.
 */
// oxlint-disable-next-line typescript/no-empty-interface, typescript/no-empty-object-type -- filled in by declaration merging
export interface KilnTemplates {}

/** The `types` option: a type guard for each type in `KilnTypes`, plus any other checks. */
export type TypeChecks = {
	[Name in keyof KilnTypes]: (value: unknown) => value is KilnTypes[Name];
} & Record<string, TypeCheck>;

/** A template name. Names from `KilnTemplates` complete in editors, and any other string is accepted. */
// oxlint-disable-next-line typescript/no-redundant-type-constituents -- `KilnTemplates` is empty until the host's generated file fills it in
export type TemplateName = (keyof KilnTemplates & string) | (string & {});

type TemplateEntry<Name extends string> = (
	Name extends `${infer Base}.kiln` ? Base : Name
) extends infer Key
	? Key extends keyof KilnTemplates
		? KilnTemplates[Key]
		: undefined
	: undefined;

/** The data `render` takes for a template. Any data for a name `KilnTemplates` doesn't list. */
export type TemplateContext<Name extends string> =
	TemplateEntry<Name> extends { context: infer Context }
		? Context
		: Record<string, unknown>;

/** The block names `renderBlock` takes for a template. Any name for a template `KilnTemplates` doesn't list. */
export type TemplateBlock<Name extends string> =
	TemplateEntry<Name> extends { blocks: infer Block } ? Block : string;

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
	/** Checks for host prop types, such as `Post`. Names start with a capital letter. */
	types?: TypeChecks;
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

/** The data and options after a template name: the data is optional when every key is, and the options when `State` allows it. */
type RenderArguments<Context, State> = [
	// oxlint-disable-next-line typescript/no-empty-object-type -- `{}` is the data with no keys
	...({} extends Context ? [context?: Context] : [context: Context]),
	...(undefined extends State
		? [options?: RenderOptions<State>]
		: [options: RenderOptions<State>]),
];

export type Kiln<State = undefined> = {
	/** Renders a template. Rejects with `KilnSyntaxError` or `KilnRenderError`. */
	render<Name extends TemplateName>(
		name: Name,
		...args: RenderArguments<TemplateContext<Name>, State>
	): Promise<string>;
	/**
	 * Renders one block of a template, such as a fragment for an htmx or fetch request. Child templates' top-level statements run first, as in `render`.
	 */
	renderBlock<Name extends TemplateName>(
		name: Name,
		block: TemplateBlock<Name>,
		...args: RenderArguments<TemplateContext<Name>, State>
	): Promise<string>;
	/** Parses and checks a template without rendering it. Pass `source` to check unsaved text. */
	check(name: string, source?: string): Promise<Diagnostic[]>;
	/** Reports what a template uses: variables, props, functions, filters, tests, templates, blocks and macros. */
	analyze(name: string, source?: string): Promise<Analysis>;
	/**
	 * Compiles a template to the source of a JavaScript module, at build time. Loaders return the module's default
	 * export in place of the source. Rejects with `KilnSyntaxError` when the template has problems.
	 */
	precompile(name: string, source?: string): Promise<string>;
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
const TYPE_NAME = /^[A-Z][A-Za-z0-9_]*$/;
const TEST_NAME = /^[A-Za-z_][A-Za-z0-9_]*( [A-Za-z_][A-Za-z0-9_]*)?$/;
const RESERVED = {
	function: new Set(["parent", "block"]),
	filter: new Set(["default", "raw", "escape"]),
	test: new Set(["defined"]),
};

const builtinMaps = new WeakMap<
	Record<string, CallableEntry>,
	ReadonlyMap<string, CallableEntry>
>();

/** Built-ins of one kind as a map, made once and shared by environments that add none of their own. */
const builtinMap = (
	builtins: Record<string, CallableEntry>,
): ReadonlyMap<string, CallableEntry> => {
	let map = builtinMaps.get(builtins);
	if (!map) {
		map = new Map(Object.entries(builtins));
		builtinMaps.set(builtins, map);
	}
	return map;
};

const registry = <State>(
	kind: "function" | "filter" | "test",
	builtins: Record<string, CallableEntry>,
	host: Record<string, KilnCallable<State>> | undefined,
): ReadonlyMap<string, CallableEntry> => {
	const shared = builtinMap(builtins);
	if (!host || Object.keys(host).length === 0) return shared;
	const entries = new Map(shared);
	for (const [name, value] of Object.entries(host)) {
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
	readonly functions: ReadonlyMap<string, CallableEntry>;
	readonly filters: ReadonlyMap<string, CallableEntry>;
	readonly tests: ReadonlyMap<string, CallableEntry>;
	readonly types: Map<string, TypeCheck>;
	readonly globals: Scope;
	readonly limits: Limits;
	readonly locale: string;
	readonly timeZone: string;
	readonly #loader: Loader;
	readonly #cache = new Map<
		string,
		CompiledTemplate | null | Promise<CompiledTemplate | null>
	>();
	/** Names passed to `render`, resolved. */
	readonly #names = new Map<string, string>();
	generation = 0;

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
		this.types = new Map();
		for (const [name, check] of Object.entries<TypeCheck>(
			options.types ?? {},
		)) {
			if (!TYPE_NAME.test(name)) {
				throw new TypeError(
					`"${name}" is not a valid type name. Type names start with a capital letter`,
				);
			}
			if (typeof check !== "function") {
				throw new TypeError(`type "${name}" must be a function`);
			}
			this.types.set(name, check);
		}

		const globals = childScope(null);
		const provided = options.globals ?? {};
		if (!isPlainObject(provided))
			throw new TypeError("globals must be a plain object");
		for (const key of hashKeys(provided)) globals[key] = provided[key] ?? null;
		this.globals = globals;
	}

	load(
		name: string,
	): CompiledTemplate | null | Promise<CompiledTemplate | null> {
		const cached = this.#cache.get(name);
		if (cached !== undefined) return cached;

		const compile = (source: string | PrecompiledTemplate | null) => {
			if (source === null) return null;
			if (typeof source === "string") {
				return compileTemplate(this, name, source);
			}
			if (isPrecompiled(source)) return compilePrecompiled(this, name, source);
			throw new TypeError(`Loader returned a ${typeof source} for "${name}"`);
		};

		const loaded = this.#loader.load(name);
		if (isPromise(loaded)) {
			// An invalidate while this load is in flight replaces or drops the
			// entry, so only touch the cache if it still holds this load.
			const pending: Promise<CompiledTemplate | null> = loaded.then(
				(source) => {
					const template = compile(source);
					if (this.#cache.get(name) === pending)
						this.#cache.set(name, template);
					return template;
				},
				(error: unknown) => {
					if (this.#cache.get(name) === pending) this.#cache.delete(name);
					throw error;
				},
			);
			this.#cache.set(name, pending);
			return pending;
		}
		const template = compile(loaded);
		this.#cache.set(name, template);
		return template;
	}

	invalidate(name?: string): void {
		if (name === undefined) this.#cache.clear();
		else this.#cache.delete(resolveTemplateName(name));
		this.generation++;
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
		let resolved = this.#names.get(name);
		if (resolved === undefined) {
			try {
				resolved = resolveTemplateName(name);
			} catch (error) {
				const issue = error as KilnIssue;
				throw new KilnRenderError(issue.code, issue.message, name);
			}
			// Names may come from requests, so the cache can't grow without limit.
			if (this.#names.size >= 1000) this.#names.clear();
			this.#names.set(name, resolved);
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

		const scope = childScope(this.globals);
		const passed = hashKeys(context);
		for (const key of passed) scope[key] = context[key] ?? null;
		addSlotFlags(scope, template, null);

		const out = { s: "" };
		const result = renderTemplate(
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
			block,
		);
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
	type Options = BaseRenderOptions & { state?: State };
	// The typed signatures only narrow what callers may pass, so these take the plain shapes.
	const render = (
		name: string,
		context?: Record<string, unknown>,
		renderOptions?: Options,
	) => env.render(name, context, renderOptions ?? {});
	const renderBlock = (
		name: string,
		block: string,
		context?: Record<string, unknown>,
		renderOptions?: Options,
	) => {
		if (typeof block !== "string") {
			throw new TypeError("renderBlock needs a block name");
		}
		return env.render(name, context, renderOptions ?? {}, block);
	};
	return {
		render: render as Kiln<State>["render"],
		renderBlock: renderBlock as Kiln<State>["renderBlock"],
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
			const references = await checkReferences(env, template);
			return [...template.diagnostics, ...references].sort(
				(a, b) => a.start.offset - b.start.offset,
			);
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
		precompile: async (name, source) => {
			const template = await env.compileFor(name, source);
			if (!template) {
				throw new KilnRenderError(
					"missing-template",
					`Template "${resolveTemplateName(name)}" was not found`,
					resolveTemplateName(name),
				);
			}
			if (template.hasErrors) throw template.syntaxError();
			return generateModule(env, template.ast, template.source.text);
		},
		invalidate: (name) => env.invalidate(name),
	};
};

/**
 * A loader for templates held in memory, keyed by name. Keys without an extension get `.kiln`. Each template is its
 * source or a precompiled module's default export.
 *
 * Works on every runtime, including Cloudflare Workers.
 */
export const memoryLoader = (
	templates:
		| Record<string, string | PrecompiledTemplate>
		| Map<string, string | PrecompiledTemplate>,
): Omit<Loader, "list"> & { list(): string[] } => {
	const map = new Map<string, string | PrecompiledTemplate>();
	const entries =
		templates instanceof Map ? templates : Object.entries(templates);
	for (const [name, source] of entries) {
		map.set(resolveTemplateName(name), source);
	}
	return { load: (name) => map.get(name) ?? null, list: () => [...map.keys()] };
};
