import { KilnRenderError } from "../errors.js";
import type { EscapeStrategy } from "../parser/ast.js";
import { escapeHtml, escapeWith } from "../runtime/escape.js";
import { Markup } from "../runtime/markup.js";
import {
	contains,
	operatorFunction,
	rangeOperator,
} from "../runtime/operators.js";
import {
	checkLength,
	consume,
	embed,
	embedKeyed,
	embedScope,
	fail,
	indentedText,
	indentText,
	locate,
	endPlace,
	markCaller,
	startPlace,
	step,
	unhold,
	write,
} from "../runtime/render.js";
import { childScope, lookup, type Scope } from "../runtime/scope.js";
import {
	blockScope,
	type Builtin,
	type CompiledTemplate,
	type EnvironmentCore,
	fillScope,
	type Out,
	type Run,
	type SlotFill,
	type Stmt,
} from "../runtime/types.js";
import {
	equals,
	isEmpty,
	literalOptions,
	MISSING,
	toNumber,
	toStr,
	truthy,
} from "../runtime/values.js";
import type { Span } from "../source.js";
import { suggest } from "../suggest.js";
import {
	assign,
	checkValue,
	compileTemplate,
	emitter,
	type GeneratedRuns,
	loopItems,
	readingLabel,
	readMember,
	SHORT,
	undefinedVariable,
} from "./compiler.js";

/** Changes whenever generated code or the runtime it calls changes shape, so old modules fail loudly. */
export const PRECOMPILED_VERSION = 3;

/**
 * A template compiled to JavaScript at build time, the default export of a module `precompile` wrote. Loaders return
 * it in place of the template's source.
 */
export type PrecompiledTemplate = {
	/** The version of the generated code. */
	readonly kiln: number;
	/** The `autoescape` option the template was compiled with. */
	readonly autoescape: EscapeStrategy | false;
	/** The template's source. Kiln still compiles it, for everything the generated code leaves out. */
	readonly source: string;
	/** Creates the generated statements, given Kiln's runtime. Only Kiln calls it. */
	readonly create: (runtime: never) => unknown;
};

/** Generated statements: where each run of statements starts and ends in the source, and the code that replaces it. */
type GeneratedList = readonly (readonly [
	start: number,
	end: number,
	run: Stmt,
])[];

/** Checks for a precompiled module's default export, as opposed to template source. */
export const isPrecompiled = (value: unknown): value is PrecompiledTemplate =>
	typeof value === "object" &&
	value !== null &&
	"kiln" in value &&
	"create" in value;

const mismatch = (name: string, detail: string): KilnRenderError =>
	new KilnRenderError(
		"precompiled-mismatch",
		`Precompiled template "${name}" ${detail}. Precompile it again`,
		name,
	);

/** Compiles a precompiled template: its source, with the generated statements in place of the ones they cover. */
export const compilePrecompiled = (
	env: EnvironmentCore,
	name: string,
	template: PrecompiledTemplate,
): CompiledTemplate => {
	if (template.kiln !== PRECOMPILED_VERSION) {
		throw mismatch(name, "was made by another version of Kiln");
	}
	if (template.autoescape !== env.autoescape) {
		throw mismatch(name, 'was compiled with another "autoescape" option');
	}
	const runs = new Map<number, { end: number; run: Stmt }>();
	const create = template.create as (
		runtime: PrecompiledRuntime,
	) => GeneratedList;
	for (const [start, end, run] of create(runtimeFor(env, name))) {
		runs.set(start, { end, run });
	}
	return compileTemplate(env, name, template.source, runs as GeneratedRuns);
};

/**
 * What generated code calls. Every rule templates follow, such as how properties are read and values printed, lives
 * here or in the closure compiler, so both run the same code.
 */
export type PrecompiledRuntime = typeof runtime &
	ReturnType<typeof builtinsFor>;

// Built-ins are looked up per template, so a mismatch names the template.
const runtimeFor = (
	env: EnvironmentCore,
	name: string,
): PrecompiledRuntime => ({
	...runtime,
	...builtinsFor(env, name),
});

const builtinsFor = (env: EnvironmentCore, template: string) => {
	const builtin = (
		kind: "filter" | "test" | "function",
		entries: EnvironmentCore["filters"],
		name: string,
	): Builtin => {
		const entry = entries.get(name);
		if (entry?.kind !== "builtin") {
			throw mismatch(
				template,
				`uses the built-in ${kind} "${name}", which this environment ${entry ? "replaces" : "does not have"}`,
			);
		}
		return entry.call;
	};
	return {
		filter: (name: string) => builtin("filter", env.filters, name),
		test: (name: string) => builtin("test", env.tests, name),
		fn: (name: string) => builtin("function", env.functions, name),
		/** One of your functions or filters, with the label its errors use. */
		host: (kind: "function" | "filter", name: string): HostCall => {
			const entry = (kind === "filter" ? env.filters : env.functions).get(name);
			if (entry?.kind !== "host") {
				throw mismatch(
					template,
					`uses your ${kind} "${name}", which this environment ${entry ? "has as a built-in" : "does not have"}`,
				);
			}
			return {
				call: entry.call,
				render: entry.render,
				label: `${kind === "filter" ? "Filter" : "Function"} "${name}"`,
			};
		},
	};
};

const joinOperator = operatorFunction("~");

/**
 * Runs generated code that may wait: waits for each promise it yields, and sends back the result, or throws the
 * rejection in at the `yield`, where generated code locates it.
 */
const drive = (
	iterator: Iterator<unknown, void, unknown>,
	value?: unknown,
): void | Promise<void> => resume(iterator, iterator.next(value));

const resume = (
	iterator: Iterator<unknown, void, unknown>,
	result: IteratorResult<unknown, void>,
): void | Promise<void> => {
	if (result.done) return;
	return (result.value as Promise<unknown>).then(
		(resolved) => resume(iterator, iterator.next(unhold(resolved))),
		(error: unknown) =>
			resume(
				iterator,
				(iterator.throw as (error: unknown) => IteratorResult<unknown, void>)(
					error,
				),
			),
	);
};

/** The names a `props` tag declares, and the last frozen list of passed names found to fit them. */
type DeclaredProps = {
	names: ReadonlySet<string>;
	accepted: readonly string[] | null;
};

/** One of your functions or filters, as generated code calls it. */
type HostCall = {
	call: (...args: unknown[]) => unknown;
	/** Made with `withRender`, so it receives `RenderInfo` first. */
	render: boolean;
	label: string;
};

const emitters = {
	html: emitter("html"),
	attr: emitter("attr"),
	js: emitter("js"),
	css: emitter("css"),
	url: emitter("url"),
	none: emitter(false),
};

/** The helpers generated code calls. Built-ins are added per template by `runtimeFor`. */
const runtime = {
	MISSING,
	SHORT,
	objectPrototype: Object.prototype,
	getPrototypeOf: Object.getPrototypeOf,
	hasOwn: Object.hasOwn,
	step,
	/** Stops a render that counted more steps than `maxSteps`, as `step` does. */
	stepLimit: (run: Run, span: Span): never => {
		throw fail(
			run,
			span,
			"limit-steps",
			`Render stopped after ${run.state.maxSteps} steps`,
		);
	},
	/** Refuses a range longer than the step limit, as `range` does. */
	rangeLimit: (run: Run, span: Span, length: number): never => {
		throw fail(
			run,
			span,
			"limit-steps",
			`Range of ${length} items is larger than the step limit`,
		);
	},
	/** Stops a render whose abort signal fired, as `step` does. */
	aborted: (run: Run, span: Span): never => {
		throw fail(run, span, "aborted", "Render was aborted");
	},
	write,
	drive,
	startPlace,
	endPlace,
	indentText,
	indentedText,
	embed,
	embedScope,
	embedKeyed,
	childScope,
	truthy,
	isEmpty,
	equals,
	escapeHtml,
	readMember,
	loopItems,
	checkValue,
	assign,
	/**
	 * Calls one of your functions or filters as the closures do. Errors it throws are located here, and a promise it
	 * returns is located where generated code waits for it, with `hostError`. A thenable becomes a promise, and a
	 * promise tells a streamed render it is waiting.
	 */
	callHost: (
		run: Run,
		span: Span,
		host: HostCall,
		args: unknown[],
	): unknown => {
		let value: unknown;
		try {
			value = host.render ? host.call(run.info, ...args) : host.call(...args);
		} catch (error) {
			throw locate(run, span, error, host.label);
		}
		if (value instanceof Promise) {
			run.state.stream?.wait();
			return value;
		}
		if (
			typeof value === "object" &&
			value !== null &&
			typeof (value as { then?: unknown }).then === "function"
		) {
			run.state.stream?.wait();
			return Promise.resolve(value);
		}
		return value;
	},
	/**
	 * Whether a block that `placeBlock` placed may have set a variable. Any version of any block may run inside it,
	 * through `parent()` and `block()`, so this is whether any of them sets one. Templates define few blocks.
	 */
	blockSets: (run: Run): boolean => {
		for (const entries of run.blocks.values()) {
			for (const entry of entries) if (entry.def.sets) return true;
		}
		return false;
	},
	/**
	 * Locates an error thrown in generated code at the last property it read inline, where a getter in your data can
	 * throw. Every other error is located already.
	 */
	readError: (
		run: Run,
		at: readonly [Span, string] | null,
		error: unknown,
	): unknown =>
		at === null ? error : locate(run, at[0], error, readingLabel(at[1])),
	/** Locates the rejection of a promise one of your functions or filters returned. */
	hostError: (run: Run, span: Span, host: HostCall, error: unknown) =>
		locate(run, span, error, host.label),
	/** Whether a value is a plain object, whose own properties templates may read directly. */
	plain: (value: unknown): boolean => {
		if (typeof value !== "object" || value === null) return false;
		const proto = Object.getPrototypeOf(value);
		return proto === Object.prototype || proto === null;
	},
	operator: operatorFunction,
	options: literalOptions,
	/** Spans from a flat list of start and end offsets. */
	spans: (offsets: readonly number[]): Span[] => {
		const spans: Span[] = [];
		for (let i = 0; i < offsets.length; i += 2) {
			spans.push({
				start: offsets[i] as number,
				end: offsets[i + 1] as number,
			});
		}
		return spans;
	},
	/** A variable from outside the generated code. Missing variables fail in strict mode and read as null otherwise. */
	name: (run: Run, span: Span, scope: Scope, name: string): unknown => {
		const value = lookup(scope, name);
		if (value === undefined) {
			if (run.state.env.strict) {
				throw undefinedVariable(run, span, name, scope);
			}
			return null;
		}
		return typeof value === "function"
			? checkValue(run, span, value, name)
			: value;
	},
	/** A variable where a missing one is allowed, such as the input of `default`. */
	guardedName: (run: Run, span: Span, scope: Scope, name: string): unknown => {
		const value = lookup(scope, name);
		return value === undefined ? MISSING : checkValue(run, span, value, name);
	},
	/** Prints a value with an escaping strategy, or none. */
	print: (
		run: Run,
		span: Span,
		value: unknown,
		strategy: keyof typeof emitters,
	): string => {
		try {
			return emitters[strategy](value);
		} catch (error) {
			throw locate(run, span, error);
		}
	},
	call0: (run: Run, span: Span, fn: Builtin): unknown => {
		try {
			return fn(run);
		} catch (error) {
			throw locate(run, span, error);
		}
	},
	call1: (run: Run, span: Span, fn: Builtin, a: unknown): unknown => {
		try {
			return fn(run, a);
		} catch (error) {
			throw locate(run, span, error);
		}
	},
	call2: (run: Run, span: Span, fn: Builtin, a: unknown, b: unknown) => {
		try {
			return fn(run, a, b);
		} catch (error) {
			throw locate(run, span, error);
		}
	},
	call3: (
		run: Run,
		span: Span,
		fn: Builtin,
		a: unknown,
		b: unknown,
		c: unknown,
	): unknown => {
		try {
			return fn(run, a, b, c);
		} catch (error) {
			throw locate(run, span, error);
		}
	},
	call4: (
		run: Run,
		span: Span,
		fn: Builtin,
		a: unknown,
		b: unknown,
		c: unknown,
		d: unknown,
	): unknown => {
		try {
			return fn(run, a, b, c, d);
		} catch (error) {
			throw locate(run, span, error);
		}
	},
	/** A binary operator without short-circuit behaviour. */
	binary: (
		run: Run,
		span: Span,
		apply: (left: unknown, right: unknown) => unknown,
		left: unknown,
		right: unknown,
	): unknown => {
		try {
			return apply(left, right);
		} catch (error) {
			throw locate(run, span, error);
		}
	},
	/** `in`, which charges for the items it searches. */
	contains: (
		run: Run,
		span: Span,
		needle: unknown,
		haystack: unknown,
	): boolean => {
		try {
			return contains(needle, haystack, (count) => consume(run, count));
		} catch (error) {
			throw locate(run, span, error);
		}
	},
	/** `~`, whose result may not be longer than the output limit. */
	concat: (run: Run, span: Span, left: unknown, right: unknown): string => {
		try {
			return checkLength(run, joinOperator(left, right) as string);
		} catch (error) {
			throw locate(run, span, error);
		}
	},
	range: (run: Run, span: Span, left: unknown, right: unknown): number[] => {
		try {
			const items = rangeOperator(left, right, run.state.maxSteps);
			consume(run, items.length);
			return items;
		} catch (error) {
			throw locate(run, span, error);
		}
	},
	/** Unary `-` and `+` on a value that is not a number, which fails. */
	toNumber: (run: Run, span: Span, value: unknown, operator: string) => {
		try {
			return toNumber(value, operator);
		} catch (error) {
			throw locate(run, span, error);
		}
	},
	/** One part of an interpolated string. */
	str: (run: Run, span: Span, value: unknown): string => {
		if (typeof value === "string") return value;
		try {
			return toStr(value);
		} catch (error) {
			throw locate(run, span, error);
		}
	},
	/** An interpolated string, which may not be longer than the output limit. */
	joined: (run: Run, span: Span, text: string): string => {
		try {
			return checkLength(run, text);
		} catch (error) {
			throw locate(run, span, error);
		}
	},
	/** The `raw` filter. */
	raw: (run: Run, span: Span, value: unknown, strategy: EscapeStrategy) => {
		if (value instanceof Markup) {
			return value.strategy === strategy
				? value
				: new Markup(value.value, strategy);
		}
		return new Markup(runtime.str(run, span, value), strategy);
	},
	/** The `escape` filter, with a strategy known to be valid. Stops once the escaped text passes the output limit. */
	escape: (run: Run, span: Span, value: unknown, strategy: EscapeStrategy) => {
		if (value instanceof Markup && value.strategy === strategy) return value;
		const text = runtime.str(run, span, value);
		try {
			return new Markup(
				escapeWith(text, strategy, run.state.maxSize),
				strategy,
			);
		} catch (error) {
			throw locate(run, span, error);
		}
	},
	/** Renders a component's fill for a slot, recording the slot's location on errors. */
	fillSlot: (
		run: Run,
		span: Span,
		fill: SlotFill,
		out: Out,
	): void | Promise<void> => {
		try {
			// The fill renders in the capture the slot is in, such as a cached section.
			const result = fill.body(
				fill.run.within(run.capture),
				fillScope(fill, run),
				out,
			);
			if (result instanceof Promise) {
				return result.catch((error: unknown) => {
					throw markCaller(run, span, error);
				});
			}
			return result;
		} catch (error) {
			throw markCaller(run, span, error);
		}
	},
	/** Places a block: the most derived definition, which may come from a child template. */
	placeBlock: (
		run: Run,
		span: Span,
		name: string,
		scope: Scope,
		out: Out,
	): void | Promise<void> => {
		const entry = run.blocks.get(name)?.[0];
		if (!entry) return;
		// The block renders in the capture it is placed in, such as a cached section.
		const blockRun = entry.run.within(run.capture);
		if (entry.run.template === run.template) {
			return entry.def.body(blockRun, blockScope(entry.def, scope), out);
		}
		// A block defined in another template records where it was placed.
		try {
			const result = entry.def.body(
				blockRun,
				blockScope(entry.def, scope),
				out,
			);
			if (result instanceof Promise) {
				return result.catch((error: unknown) => {
					throw markCaller(run, span, error);
				});
			}
			return result;
		} catch (error) {
			throw markCaller(run, span, error);
		}
	},
	/**
	 * In strict mode, fails when the caller passed a variable `props` doesn't declare. Callers that make the scope
	 * themselves pass the same frozen list each time, so the last list that passed is remembered.
	 */
	checkPassed: (run: Run, span: Span, declared: DeclaredProps) => {
		const passed = run.passed;
		if (passed === null || passed === declared.accepted) return;
		if (!run.state.env.strict) return;
		for (let i = 0; i < passed.length; i++) {
			const key = passed[i] as string;
			if (!declared.names.has(key) && key !== "slots") {
				throw fail(
					run,
					span,
					"unknown-prop",
					`"${key}" was passed to ${run.template.name}, which does not declare it in "props"`,
					suggest(key, declared.names),
				);
			}
		}
		if (Object.isFrozen(passed)) declared.accepted = passed;
	},
	/** The names a `props` tag declares, for `checkPassed`. */
	declared: (names: string[]): DeclaredProps => ({
		names: new Set(names),
		accepted: null,
	}),
	/** A required prop the caller didn't pass: fails in strict mode, and is null otherwise. */
	missingProp: (run: Run, span: Span, name: string): null => {
		if (run.state.env.strict) {
			throw fail(
				run,
				span,
				"missing-prop",
				`Required prop "${name}" was not passed to ${run.template.name}`,
			);
		}
		return null;
	},
	/** The `loop` hash, for templates that use it whole. */
	loop: (index: number, length: number) => ({
		index: index + 1,
		index0: index,
		revIndex: length - index,
		revIndex0: length - index - 1,
		first: index === 0,
		last: index === length - 1,
		length,
	}),
};
