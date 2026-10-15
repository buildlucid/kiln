import {
	issue,
	KilnIssue,
	KilnRenderError,
	KilnSyntaxError,
} from "../errors.js";
import { resolveTemplateName } from "../names.js";
import type { Span } from "../source.js";
import { suggest } from "../suggest.js";
import {
	type BlockEntry,
	type CompiledTemplate,
	type Out,
	type RenderState,
	Run,
	type Scope,
	type SlotFill,
} from "./types.js";
import { hashKeys, isPlainObject, setOwn, typeName } from "./values.js";

export const isPromise = (value: unknown): value is Promise<unknown> =>
	value instanceof Promise;

/** Calls `next` with the value, after waiting for it only if it is a promise. */
export const after = <T, R>(
	value: T | Promise<T>,
	next: (resolved: T) => R | Promise<R>,
): R | Promise<R> =>
	value instanceof Promise ? value.then(next) : next(value as T);

/** Stops a promise's rejection from being reported as unhandled, when a sibling failed first. */
export const silence = (value: unknown): void => {
	if (value instanceof Promise) value.catch(() => {});
};

/** Creates a located render error for the current template. */
export const fail = (
	run: Run,
	span: Span,
	code: string,
	message: string,
	hint?: string,
): KilnRenderError =>
	new KilnRenderError(code, message, run.template.source, span, { hint });

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/**
 * Turns any error into a located Kiln error. Kiln errors pass through. Errors from host code keep the original as `cause`.
 */
export const locate = (
	run: Run,
	span: Span,
	error: unknown,
	host?: string,
): unknown => {
	if (error instanceof KilnRenderError || error instanceof KilnSyntaxError) {
		return error;
	}
	if (error instanceof KilnIssue)
		return fail(run, span, error.code, error.message);
	if (host !== undefined) {
		return new KilnRenderError(
			"host-error",
			`${host} threw an error: ${errorMessage(error)}`,
			run.template.source,
			span,
			{ cause: error },
		);
	}
	return fail(run, span, "invalid-argument", errorMessage(error));
};

/** Wraps a value or promise so any error is located at `span`. */
export const locating = <T>(
	run: Run,
	span: Span,
	produce: () => T,
	host?: string,
): T => {
	try {
		let value: unknown = produce();
		// Host code may return a thenable, such as a query builder, or a promise from another realm.
		if (
			host !== undefined &&
			!(value instanceof Promise) &&
			typeof value === "object" &&
			value !== null &&
			typeof (value as { then?: unknown }).then === "function"
		) {
			value = Promise.resolve(value);
		}
		if (value instanceof Promise) {
			return value.catch((error: unknown) => {
				throw locate(run, span, error, host);
			}) as T;
		}
		return value as T;
	} catch (error) {
		throw locate(run, span, error, host);
	}
};

/** Counts one step against `maxSteps`, and checks the abort signal. */
export const step = (run: Run, span: Span): void => {
	const state = run.state;
	if (++state.steps > state.maxSteps) {
		throw fail(
			run,
			span,
			"limit-steps",
			`Render stopped after ${state.maxSteps} steps`,
		);
	}
	if (state.signal?.aborted) {
		throw fail(run, span, "aborted", "Render was aborted");
	}
};

/**
 * Charges built-in work in proportion to its size, such as items merged or sorted, so one call cannot do unbounded work.
 *
 * Throws a `KilnIssue`, which the call site locates.
 */
export const consume = (run: Run, amount: number): void => {
	const state = run.state;
	state.steps += amount;
	if (state.steps > state.maxSteps) {
		issue("limit-steps", `Render stopped after ${state.maxSteps} steps`);
	}
};

/** Refuses strings longer than `maxOutputLength`, which could never be printed. */
export const checkLength = (run: Run, text: string): string => {
	if (text.length > run.state.maxSize) {
		issue(
			"limit-output",
			`A string of ${text.length} characters is longer than the output limit of ${run.state.maxSize}`,
		);
	}
	return text;
};

/** Appends text to an output buffer, enforcing `maxOutputLength`. */
export const write = (run: Run, out: Out, text: string, span: Span): void => {
	out.s += text;
	const state = run.state;
	if (out.root) state.size += text.length;
	if ((out.root ? state.size : out.s.length) > state.maxSize) {
		throw fail(
			run,
			span,
			"limit-output",
			`Render stopped after ${state.maxSize} characters of output`,
		);
	}
};

/** Runs statements in order, waiting only when one returns a promise. */
export const runFrom = (
	statements: readonly ((
		run: Run,
		scope: Scope,
		out: Out,
	) => void | Promise<void>)[],
	index: number,
	run: Run,
	scope: Scope,
	out: Out,
): void | Promise<void> => {
	for (let i = index; i < statements.length; i++) {
		const result = (statements[i] as (typeof statements)[number])(
			run,
			scope,
			out,
		);
		if (result !== undefined) {
			return result.then(() => runFrom(statements, i + 1, run, scope, out));
		}
	}
};

/** Records the caller's location on a render error that passes through an include, component or `extends`. */
export const withCaller = <T>(
	run: Run,
	span: Span,
	work: () => T | Promise<T>,
): T | Promise<T> => {
	const mark = (error: unknown) => {
		if (error instanceof KilnRenderError) {
			const start = run.template.source.position(span.start);
			(
				error.templateStack as {
					template: string;
					line: number;
					column: number;
				}[]
			).unshift({
				template: run.template.name,
				line: start.line,
				column: start.column,
			});
		}
		return error;
	};
	try {
		const result = work();
		if (result instanceof Promise) {
			return result.catch((error: unknown) => {
				throw mark(error);
			});
		}
		return result;
	} catch (error) {
		throw mark(error);
	}
};

/** Loads a template by name, relative to the current template. Returns null for a missing template when `ignoreMissing` is set. */
export const loadTemplate = (
	run: Run,
	name: unknown,
	span: Span,
	ignoreMissing = false,
): CompiledTemplate | null | Promise<CompiledTemplate | null> => {
	if (typeof name !== "string") {
		throw fail(
			run,
			span,
			"type-error",
			`Template name must be a string, but got a ${typeName(name)}`,
		);
	}
	const resolved = locating(run, span, () =>
		resolveTemplateName(name, run.template.name),
	);
	const loaded = locating(
		run,
		span,
		() => run.state.env.load(resolved),
		"The template loader",
	);
	return after(loaded, (template) => {
		if (!template) {
			if (ignoreMissing) return null;
			throw fail(
				run,
				span,
				"missing-template",
				`Template "${resolved}" was not found`,
			);
		}
		if (template.hasErrors) throw template.syntaxError();
		return template;
	});
};

/** Loads every template a template imports, once per render. */
export const importsFor = (
	run: Run,
	template: CompiledTemplate,
): CompiledTemplate[] | Promise<CompiledTemplate[]> => {
	if (template.imports.length === 0) return [];
	const state = run.state;
	const cached = state.importsCache.get(template);
	if (cached) return cached;

	const loaded = template.imports.map(({ name, span }) =>
		loadTemplate(new Run(state, template, run.depth, null, null), name, span),
	);
	const finish = (list: (CompiledTemplate | null)[]) => {
		const imports = list as CompiledTemplate[];
		state.importsCache.set(template, imports);
		return imports;
	};
	if (loaded.some(isPromise)) return Promise.all(loaded).then(finish);
	return finish(loaded as (CompiledTemplate | null)[]);
};

/** Creates an isolated scope holding globals plus the given variables. */
export const isolatedScope = (
	run: Run,
	variables: unknown,
	span: Span,
): { scope: Scope; passed: string[] } => {
	const scope = Object.create(run.state.globals) as Scope;
	const passed: string[] = [];
	if (variables === null || variables === undefined) return { scope, passed };
	if (isPlainObject(variables)) {
		for (const key of hashKeys(variables)) {
			setOwn(scope as Record<string, unknown>, key, variables[key]);
			passed.push(key);
		}
	} else if (variables instanceof Map) {
		for (const [key, value] of variables) {
			if (typeof key === "string") {
				setOwn(scope as Record<string, unknown>, key, value);
				passed.push(key);
			}
		}
	} else {
		throw fail(
			run,
			span,
			"type-error",
			`"with" needs a hash, but got a ${typeName(variables)}`,
		);
	}
	return { scope, passed };
};

export type RenderTemplateOptions = {
	depth: number;
	slots: Map<string, SlotFill> | null;
	passed: readonly string[] | null;
	inherited: Map<string, BlockEntry[]> | null;
	/** Where the render was requested, for depth errors. Null for the outermost render. */
	caller: { run: Run; span: Span } | null;
	/** For `renderBlock`: the block to render once the top-most template is reached, instead of its content. */
	block?: string;
};

/**
 * Renders a template into `out`, following `extends` and sharing `scope` along the inheritance chain.
 */
export const renderTemplate = (
	state: RenderState,
	template: CompiledTemplate,
	scope: Scope,
	out: Out,
	options: RenderTemplateOptions,
): void | Promise<void> => {
	if (options.caller && options.depth > state.maxDepth) {
		throw fail(
			options.caller.run,
			options.caller.span,
			"limit-depth",
			`Render stopped after nesting ${state.maxDepth} templates, macros or layouts deep`,
		);
	}

	const run = new Run(
		state,
		template,
		options.depth,
		options.slots,
		options.passed,
	);

	// Every template in an inheritance chain shares one block table, most derived definition first, so `parent()` can find the next one from any level.
	if (options.inherited || template.blocks.size > 0) {
		const blocks = options.inherited ?? new Map<string, BlockEntry[]>();
		for (const [name, def] of template.blocks) {
			const entry = { def, run };
			const list = blocks.get(name);
			if (list) list.push(entry);
			else blocks.set(name, [entry]);
		}
		run.blocks = blocks;
	}

	return after(importsFor(run, template), (imports) => {
		run.imports = imports;
		const parent = template.parent;
		if (!parent && options.block !== undefined) {
			return renderOnlyBlock(run, scope, out, options.block);
		}
		const result = template.body(run, scope, out);
		if (!parent) return result;

		return after(result, () =>
			after(parent.ev(run, scope), (name) =>
				after(loadTemplate(run, name, template.parentSpan), (parentTemplate) =>
					withCaller(run, template.parentSpan, () =>
						renderTemplate(
							state,
							parentTemplate as CompiledTemplate,
							scope,
							out,
							{
								depth: options.depth + 1,
								slots: options.slots,
								// Layouts check required props, but not undeclared ones: the context was meant for the page.
								passed: null,
								inherited: run.blocks,
								caller: { run, span: template.parentSpan },
								block: options.block,
							},
						),
					),
				),
			),
		);
	});
};

/**
 * Renders one block of the top-most template in a chain, for `renderBlock`. Applies the template's `props`, but runs none of its other content.
 */
const renderOnlyBlock = (
	run: Run,
	scope: Scope,
	out: Out,
	name: string,
): void | Promise<void> =>
	after(run.template.props?.(run, scope, out), () => {
		const entry = run.blocks.get(name)?.[0];
		if (!entry) {
			throw new KilnRenderError(
				"unknown-block",
				`Block "${name}" does not exist`,
				run.template.name,
				undefined,
				{ hint: suggest(name, run.blocks.keys()) },
			);
		}
		return entry.def.body(entry.run, Object.create(scope) as Scope, out);
	});

/** Gives a component or include scope its `slots` hash, with a key for every slot the template outputs. */
export const addSlotFlags = (
	scope: Scope,
	template: CompiledTemplate,
	slots: Map<string, SlotFill> | null,
): void => {
	if (template.slotNames.length === 0 && !slots) return;
	const flags = Object.create(null) as Record<string, boolean>;
	for (const name of template.slotNames) flags[name] = false;
	if (slots) for (const name of slots.keys()) flags[name] = true;
	scope.slots = flags;
};
