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
import {
	type Diagnostic,
	KilnIssue,
	KilnRenderError,
	KilnSyntaxError,
} from "./errors.js";
import {
	checkHtml,
	type HtmlCheckLevels,
	type HtmlChecks,
	resolveHtmlChecks,
} from "./html/index.js";
import { resolveTemplateName } from "./names.js";
import type { EscapeStrategy } from "./parser/ast.js";
import { ESCAPE_STRATEGIES } from "./parser/ast.js";
import type { IslandMode } from "./runtime/islands.js";
import { closeOutlets, takeOutput } from "./runtime/outlets.js";
import {
	addSlotFlags,
	isPromise,
	renderTemplate,
	silence,
} from "./runtime/render.js";
import { childScope } from "./runtime/scope.js";
import { RenderStream } from "./runtime/stream.js";
import {
	type AbortSignalLike,
	type CallableEntry,
	type CompiledTemplate,
	type EnvironmentCore,
	type KilnCache,
	emptyOut,
	type Out,
	type RenderInfo,
	RenderState,
	type Scope,
	type TypeCheck,
} from "./runtime/types.js";
import { hashKeys, isPlainObject, typeName } from "./runtime/values.js";

export type { RenderInfo };

/**
 * Where templates come from. Kiln calls `load` once per resolved name that exists, until `invalidate`, and remembers
 * a limited number of missing names.
 */
export type Loader = {
	/**
	 * Returns the source for a resolved name, such as `pages/page.kiln`, or a precompiled module's default export, or
	 * `null` if it does not exist. May return a promise or another thenable.
	 */
	load(
		name: string,
	):
		| string
		| PrecompiledTemplate
		| null
		| PromiseLike<string | PrecompiledTemplate | null>;
	/** Returns every resolved name the loader holds. Rendering never calls it; tools such as `generateTypes` do. */
	list?(): string[] | Promise<string[]>;
};

/**
 * TypeScript types for host prop types, such as `Post`. Empty until the host adds to it:
 *
 * ```ts
 * declare module "@lucidkiln/core" {
 * 	interface KilnTypes { Post: PostView }
 * }
 * ```
 */
// oxlint-disable-next-line typescript/no-empty-interface, typescript/no-empty-object-type -- filled in by declaration merging
export interface KilnTypes {}

/**
 * Project-wide template defaults, keyed by name without `.kiln`. An explicit schema on `createKiln` replaces these.
 */
// oxlint-disable-next-line typescript/no-empty-interface, typescript/no-empty-object-type -- filled in by declaration merging
export interface KilnTemplates {}

/** The template and host-type maps for one environment. `generateTypes` writes a schema for each template root. */
export type KilnSchema = {
	templates: Record<string, { context: object; blocks: string }>;
	types: object;
};

type DefaultSchema = {
	templates: { [Name in keyof KilnTemplates]: KilnTemplates[Name] };
	types: KilnTypes;
};

/** The `types` option: a type guard for each host type, plus any other checks. */
export type TypeChecks<Types extends object = KilnTypes> = {
	[Name in keyof Types]: (value: unknown) => value is Types[Name];
} & Record<string, TypeCheck>;

/** A template name. Known names complete in editors, and any other string is accepted. */
// oxlint-disable-next-line typescript/no-redundant-type-constituents -- known names may be empty before types are generated
export type TemplateName<Templates extends object = KilnTemplates> =
	| (keyof Templates & string)
	| (string & {});

type TemplateEntry<Name extends string, Templates extends object> = (
	Name extends `${infer Base}.kiln` ? Base : Name
) extends infer Key
	? Key extends keyof Templates
		? Templates[Key]
		: undefined
	: undefined;

/** The data `render` takes for a template. Any data for a name its template map doesn't list. */
export type TemplateContext<
	Name extends string,
	Templates extends object = KilnTemplates,
> =
	TemplateEntry<Name, Templates> extends { context: infer Context }
		? Context
		: Record<string, unknown>;

/** The block names `renderBlock` takes for a template. Any name for a template its map doesn't list. */
export type TemplateBlock<
	Name extends string,
	Templates extends object = KilnTemplates,
> =
	TemplateEntry<Name, Templates> extends { blocks: infer Block }
		? Block
		: string;

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

export type KilnOptions<
	State = undefined,
	Schema extends KilnSchema = DefaultSchema,
> = {
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
	/** Where the `cache` tag saves output, such as `memoryCache()`. Without it, the tag renders every time. */
	cache?: KilnCache;
	/** App and build identity added to fragment cache keys. Default `""`. */
	cacheNamespace?: string;
	limits?: Partial<Limits>;
	/** Which HTML rules `check` reports, and at what level. Default `true`, every rule as a warning. */
	htmlChecks?: HtmlChecks;
} & (keyof Schema["types"] extends never
	? { types?: TypeChecks<Schema["types"]> }
	: { types: TypeChecks<Schema["types"]> });

type BaseRenderOptions = {
	locale?: string;
	timeZone?: string;
	/** Stops the render when aborted. A real `AbortSignal` works. */
	signal?: AbortSignalLike;
	/**
	 * Defers `island` tags with `deferIslands`, or streams them with `streamIslands` in `renderStream`. Without it,
	 * islands render in place.
	 */
	islands?: IslandMode;
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

export type Kiln<
	State = undefined,
	Schema extends KilnSchema = DefaultSchema,
> = {
	/** Renders a template. Rejects with `KilnSyntaxError` or `KilnRenderError`. */
	render<Name extends TemplateName<Schema["templates"]>>(
		name: Name,
		...args: RenderArguments<TemplateContext<Name, Schema["templates"]>, State>
	): Promise<string>;
	/**
	 * Renders one block of a template, such as a fragment for an htmx or fetch request. Child templates' top-level statements run first, as in `render`.
	 */
	renderBlock<Name extends TemplateName<Schema["templates"]>>(
		name: Name,
		block: TemplateBlock<Name, Schema["templates"]>,
		...args: RenderArguments<TemplateContext<Name, Schema["templates"]>, State>
	): Promise<string>;
	/**
	 * Renders a template as a stream of UTF-8 bytes, sending each part as soon as it is final. Resolves once the first
	 * part is ready, or rejects as `render` would when the render fails before then. A later failure errors the stream.
	 */
	renderStream<Name extends TemplateName<Schema["templates"]>>(
		name: Name,
		...args: RenderArguments<TemplateContext<Name, Schema["templates"]>, State>
	): Promise<ReadableStream<Uint8Array>>;
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

/** The default limits with the host's on top. A limit left out or `undefined` keeps its default. */
const checkLimits = (limits: Partial<Limits> | undefined): Limits => {
	const result = { ...DEFAULT_LIMITS };
	if (limits === undefined) return result;
	for (const key of Object.keys(DEFAULT_LIMITS) as (keyof Limits)[]) {
		const value: unknown = limits[key];
		if (value === undefined) continue;
		if (typeof value !== "number" || !(value > 0)) {
			throw new TypeError(`limits.${key} must be a number above 0`);
		}
		result[key] = value;
	}
	return result;
};

/** How many missing template names an environment remembers, so it doesn't ask its loader again on every render. */
const MAX_MISSING = 1000;

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as { then?: unknown }).then === "function";

/** Resolves a name passed to the API, failing with a `KilnRenderError` for an invalid one. */
const resolveName = (name: string): string => {
	if (typeof name !== "string") {
		throw new TypeError(
			`Template name must be a string, but got a ${typeName(name)}`,
		);
	}
	try {
		return resolveTemplateName(name);
	} catch (error) {
		if (!(error instanceof KilnIssue)) throw error;
		throw new KilnRenderError(error.code, error.message, name);
	}
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

class Environment<State, Schema extends KilnSchema> implements EnvironmentCore {
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
	readonly cache: KilnCache | null;
	readonly cacheNamespace: string;
	readonly htmlChecks: HtmlCheckLevels;
	readonly #loader: Loader;
	readonly #cache = new Map<
		string,
		CompiledTemplate | Promise<CompiledTemplate | null>
	>();
	/** Names the loader didn't find. Names may come from requests, so only a limited number are remembered. */
	readonly #missing = new Set<string>();
	/** Names passed to `render`, resolved. */
	readonly #names = new Map<string, string>();
	generation = 0;

	constructor(options: KilnOptions<State, Schema>) {
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
		if (
			options.cache !== undefined &&
			(typeof options.cache?.get !== "function" ||
				typeof options.cache.set !== "function")
		) {
			throw new TypeError("createKiln needs a cache with get and set methods");
		}
		if (
			options.cacheNamespace !== undefined &&
			typeof options.cacheNamespace !== "string"
		) {
			throw new TypeError("cacheNamespace must be a string");
		}
		this.#loader = options.loader;
		this.cache = options.cache ?? null;
		this.cacheNamespace = options.cacheNamespace ?? "";
		this.strict = options.strict ?? true;
		this.debug = options.debug ?? false;
		this.autoescape = options.autoescape ?? "html";
		this.locale = options.locale ?? "en";
		this.timeZone = options.timeZone ?? "UTC";
		this.limits = checkLimits(options.limits);
		this.htmlChecks = resolveHtmlChecks(options.htmlChecks);
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
		if (this.#missing.has(name)) return null;

		const compile = (source: string | PrecompiledTemplate | null) => {
			if (source === null) return null;
			if (typeof source === "string") {
				return compileTemplate(this, name, source);
			}
			if (isPrecompiled(source)) return compilePrecompiled(this, name, source);
			throw new TypeError(
				`Loader returned a ${typeName(source)} for "${name}", not a string, a precompiled template or null`,
			);
		};
		const keep = (template: CompiledTemplate | null) => {
			if (template !== null) this.#cache.set(name, template);
			else {
				if (this.#missing.size >= MAX_MISSING) this.#missing.clear();
				this.#missing.add(name);
			}
		};

		const result = this.#loader.load(name);
		// A loader may return a thenable, such as a promise from another realm.
		const loaded = isThenable(result) ? Promise.resolve(result) : result;
		if (loaded instanceof Promise) {
			// An invalidate while this load is in flight replaces or drops the
			// entry, so only touch the cache if it still holds this load. A load
			// or compile that fails is forgotten, so the next render tries again.
			const pending: Promise<CompiledTemplate | null> = loaded
				.then(compile)
				.then(
					(template) => {
						if (this.#cache.get(name) === pending) {
							this.#cache.delete(name);
							keep(template);
						}
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
		keep(template);
		return template;
	}

	invalidate(name?: string): void {
		if (name === undefined) {
			this.#cache.clear();
			this.#missing.clear();
		} else {
			const resolved = resolveName(name);
			this.#cache.delete(resolved);
			this.#missing.delete(resolved);
		}
		this.generation++;
	}

	/** Compiles unsaved source, or loads the template, for `check` and `analyze`. */
	async compileFor(
		name: string,
		source?: string,
	): Promise<CompiledTemplate | null> {
		const resolved = resolveName(name);
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
		let render = this.#prepare(name, context, options);
		if (isPromise(render)) render = await render;
		const result = this.#run(render, block);
		if (result !== undefined) {
			await untilAborted(result, render.state.signal, render.resolved);
		}
		const { state, out } = render;
		// The signal may have been aborted while the last call was pending, after the render's last check.
		if (state.signal?.aborted) throw aborted(render.resolved);
		closeOutlets(state);
		const output = takeOutput(state, out.s);
		if (output.length > state.maxSize) throw tooLong(render);
		return output;
	}

	/**
	 * Renders a template as a stream, sending its output as it becomes final. Resolves once the first part is ready,
	 * or rejects when the render fails before then. A later failure errors the stream.
	 */
	async renderStream(
		name: string,
		context: Record<string, unknown> = {},
		options: BaseRenderOptions & { state?: State } = {},
	): Promise<ReadableStream<Uint8Array>> {
		let render = this.#prepare(name, context, options);
		if (isPromise(render)) render = await render;
		const { state, out } = render;
		const encoder = new TextEncoder();
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			start: (c) => {
				controller = c;
			},
			cancel: () => {
				cancelled = true;
			},
		});

		return new Promise((resolve, reject) => {
			let opened = false;
			let failed = false;
			let length = 0;
			const open = () => {
				if (opened) return;
				opened = true;
				resolve(stream);
			};
			const failWith = (error: unknown) => {
				if (failed) return;
				failed = true;
				output.stop();
				state.signal?.removeEventListener?.("abort", stop);
				if (!opened) reject(error);
				else if (!cancelled) controller.error(error);
			};
			// An abort ends the stream at once, even while the page or an island waits for your code. The render
			// stops at its next step.
			const stop = () => failWith(aborted(render.resolved));
			state.signal?.addEventListener?.("abort", stop);
			// The first half of a character split across two sends, held back so each part encodes to valid UTF-8.
			let held = "";
			const send = (text: string) => {
				if (failed) return;
				length += text.length;
				if (length > state.maxSize) return failWith(tooLong(render));
				text = held + text;
				held = "";
				const last = text.charCodeAt(text.length - 1);
				if (last >= 0xd800 && last <= 0xdbff) {
					held = text.slice(-1);
					text = text.slice(0, -1);
				}
				if (!cancelled && text !== "") {
					controller.enqueue(encoder.encode(text));
				}
				open();
			};
			const output = new RenderStream(state, out, send);
			state.stream = output;
			const close = () => {
				state.signal?.removeEventListener?.("abort", stop);
				if (failed || cancelled) return;
				if (held !== "") controller.enqueue(encoder.encode(held));
				controller.close();
			};
			// Streamed islands follow the page, each as soon as it is ready.
			const finish = () => {
				if (state.signal?.aborted) return failWith(aborted(render.resolved));
				output.end();
				if (failed) return;
				open();
				const islands = state.streamed;
				if (islands === null) return close();
				let left = islands.length;
				for (const island of islands) {
					island.then((html) => {
						send(html);
						if (--left === 0) close();
					}, failWith);
				}
			};
			try {
				const result = this.#run(render);
				if (result === undefined) finish();
				else result.then(finish, failWith);
			} catch (error) {
				failWith(error);
			}
		});
	}

	/** Finds the template and makes the state, scope and output for one render. */
	#prepare(
		name: string,
		context: Record<string, unknown>,
		options: BaseRenderOptions & { state?: State },
	): Prepared | Promise<Prepared> {
		let resolved = this.#names.get(name);
		if (resolved === undefined) {
			resolved = resolveName(name);
			// Names may come from requests, so the cache can't grow without limit.
			if (this.#names.size >= 1000) this.#names.clear();
			this.#names.set(name, resolved);
		}
		let template: ReturnType<typeof this.load>;
		try {
			template = this.load(resolved);
		} catch (error) {
			throw loaderError(resolved, error);
		}
		if (isPromise(template)) {
			const path = resolved;
			return untilAborted(
				template.then(
					(loaded) => this.#prepared(path, loaded, context, options),
					(error: unknown) => {
						throw loaderError(path, error);
					},
				),
				options.signal,
				path,
			);
		}
		return this.#prepared(resolved, template, context, options);
	}

	#prepared(
		resolved: string,
		template: CompiledTemplate | null,
		context: Record<string, unknown>,
		options: BaseRenderOptions & { state?: State },
	): Prepared {
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
		if (options.signal?.aborted) throw aborted(resolved);

		const scope = childScope(this.globals);
		const passed = hashKeys(context);
		for (const key of passed) scope[key] = context[key] ?? null;
		addSlotFlags(scope, template, null);

		state.islands = options.islands ?? null;
		const out = emptyOut();
		state.root = out;
		return { resolved, template, state, scope, passed, out };
	}

	#run(render: Prepared, block?: string): void | Promise<void> {
		const { template } = render;
		return renderTemplate(
			render.state,
			template,
			render.scope,
			render.out,
			0,
			null,
			render.passed,
			null,
			null,
			template.parentSpan,
			block,
		);
	}
}

/** One render, ready to run. */
type Prepared = {
	resolved: string;
	template: CompiledTemplate;
	state: RenderState;
	scope: Scope;
	passed: readonly string[];
	out: Out;
};

const aborted = (resolved: string) =>
	new KilnRenderError("aborted", "Render was aborted", resolved);

/**
 * Waits for `work`, or rejects as soon as `signal` aborts, when the signal can say so, as a real `AbortSignal` can.
 * The render itself stops at its next step, once the call it waits for settles.
 */
const untilAborted = <T>(
	work: Promise<T>,
	signal: AbortSignalLike | undefined,
	resolved: string,
): Promise<T> => {
	if (signal?.addEventListener === undefined) return work;
	return new Promise<T>((resolve, reject) => {
		const stop = () => {
			silence(work);
			reject(aborted(resolved));
		};
		if (signal.aborted) return stop();
		signal.addEventListener?.("abort", stop);
		work
			.finally(() => signal.removeEventListener?.("abort", stop))
			.then(resolve, reject);
	});
};

/** A loader's error for the template a render asked for, as an include would report it. Kiln errors pass through. */
const loaderError = (resolved: string, error: unknown): unknown =>
	error instanceof KilnRenderError || error instanceof KilnSyntaxError
		? error
		: new KilnRenderError(
				"host-error",
				`The template loader threw an error: ${error instanceof Error ? error.message : String(error)}`,
				resolved,
				undefined,
				{ cause: error },
			);

const tooLong = ({ resolved, state }: Prepared) =>
	new KilnRenderError(
		"limit-output",
		`Render stopped after ${state.maxSize} characters of output`,
		resolved,
	);

/**
 * Creates a Kiln environment: the loader, functions, filters, tests, globals and options every render uses.
 *
 * ```ts
 * const kiln = createKiln({ loader: memoryLoader({ "page.kiln": "<h1>{{ title }}</h1>" }) });
 * const html = await kiln.render("page", { title: "Home" });
 * ```
 */
export const createKiln = <
	State = undefined,
	Schema extends KilnSchema = DefaultSchema,
>(
	options: KilnOptions<State, Schema>,
): Kiln<State, Schema> => {
	const env = new Environment<State, Schema>(options);
	const kiln = createApi(env);
	environments.set(kiln, env);
	return kiln;
};

type ToolingEnvironment = EnvironmentCore & {
	readonly globals: Scope;
	readonly htmlChecks: HtmlCheckLevels;
};

/** The environment behind each object `createKiln` returns, for tools such as `generateManifest`. */
const environments = new WeakMap<object, ToolingEnvironment>();

/** The environment behind a Kiln object. Throws for an object `createKiln` didn't make. */
export const environmentOf = (kiln: object): ToolingEnvironment => {
	const env = environments.get(kiln);
	if (!env) throw new TypeError("Expected an environment made by createKiln");
	return env;
};

const createApi = <State, Schema extends KilnSchema>(
	env: Environment<State, Schema>,
): Kiln<State, Schema> => {
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
	const renderStream = (
		name: string,
		context?: Record<string, unknown>,
		renderOptions?: Options,
	) => env.renderStream(name, context, renderOptions ?? {});
	return {
		render: render as unknown as Kiln<State, Schema>["render"],
		renderBlock: renderBlock as unknown as Kiln<State, Schema>["renderBlock"],
		renderStream: renderStream as unknown as Kiln<
			State,
			Schema
		>["renderStream"],
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
			const html = checkHtml(template, env.htmlChecks);
			return [...template.diagnostics, ...references, ...html].sort(
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

/**
 * A store for the `cache` tag that keeps output in memory, for a long-running server. Holds up to `max` copies, 1,000
 * by default, and drops the oldest first.
 *
 * ```ts
 * const kiln = createKiln({ loader, cache: memoryCache() });
 * ```
 */
export const memoryCache = ({ max = 1000 }: { max?: number } = {}) => {
	const entries = new Map<string, { value: string; expires: number }>();
	// `satisfies` keeps the synchronous types, so callers can use the store without awaiting.
	return {
		get: ({ key }) => {
			const entry = entries.get(key);
			if (!entry) return null;
			if (entry.expires > Date.now()) return entry.value;
			entries.delete(key);
			return null;
		},
		set: ({ key, value, seconds }) => {
			// Deleting first moves the key to the end, so the oldest copy is always first.
			entries.delete(key);
			entries.set(key, {
				value,
				expires: seconds === null ? Infinity : Date.now() + seconds * 1000,
			});
			const oldest = entries.keys().next();
			if (entries.size > max && !oldest.done) entries.delete(oldest.value);
		},
	} satisfies KilnCache;
};
