import {
	issue,
	KilnIssue,
	KilnRenderError,
	KilnSyntaxError,
} from "../errors.js";
import { resolveTemplateName } from "../names.js";
import type { Span } from "../source.js";
import { suggest } from "../suggest.js";
import { childScope } from "./scope.js";
import {
	type BlockDef,
	type BlockEntry,
	blockScope,
	type CompiledTemplate,
	NO_IMPORTS,
	type Out,
	type RenderState,
	Run,
	type Scope,
	type SlotFill,
	type TemplateRef,
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

/** Wraps a value or promise so any error is located at `span`. A promise also tells a streamed render it is waiting. */
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
			run.state.stream?.wait();
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
	if (out.inline && text !== "") out.inline = false;
	const state = run.state;
	if (out.s.length > state.maxSize) {
		throw fail(
			run,
			span,
			"limit-output",
			`Render stopped after ${state.maxSize} characters of output`,
		);
	}
};

/**
 * Starts inserting content for an include, component, slot or block. `at` is the tag's `indent` when it stands on a
 * line of its own, which the content's lines get on top of the current indentation. Without it, the tag shares its
 * line, so the content's first line carries on from it. Tags at the start of a line, with `indent` empty, need
 * nothing.
 *
 * Callers keep `out.indent` and `out.inline` from before, and pass them to `endPlace` with the render's result. A
 * render that throws stops, so nothing needs restoring then.
 */
export const startPlace = (out: Out, at: string | undefined): void => {
	if (at === undefined) out.inline = true;
	else out.indent += at;
};

/** Ends `startPlace` once `result` settles. */
export const endPlace = (
	out: Out,
	indent: string,
	inline: boolean,
	result: void | Promise<void>,
): void | Promise<void> => {
	if (result instanceof Promise) {
		return result.then(() => endPlace(out, indent, inline, undefined));
	}
	out.indent = indent;
	if (out.inline) out.inline = inline;
};

/** Text whose lines start at `lines`, with the last indentation `indentText` gave it. */
export type IndentedText = {
	readonly text: string;
	readonly lines: readonly number[];
	indent: string;
	indented: string;
};

export const indentedText = (
	text: string,
	lines: readonly number[],
): IndentedText => ({ text, lines, indent: "", indented: text });

/**
 * The text with `indent` at the start of each line. `inline` is set when it is the first thing written since content
 * was inserted mid-line, so a line starting straight away gets no indentation. Remembers the last result, since text
 * is usually inserted at the same indentation each time.
 */
export const indentText = (
	entry: IndentedText,
	indent: string,
	inline: boolean,
): string => {
	if (entry.indent !== indent) {
		const { text, lines } = entry;
		let result = "";
		let at = 0;
		for (const start of lines) {
			result += text.slice(at, start) + indent;
			at = start;
		}
		entry.indented = result + text.slice(at);
		entry.indent = indent;
	}
	return inline && entry.lines[0] === 0
		? entry.indented.slice(indent.length)
		: entry.indented;
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
export const markCaller = (run: Run, span: Span, error: unknown): unknown => {
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

/** Runs `work`, recording the caller's location on any render error. See `markCaller`. */
export const withCaller = <T>(
	run: Run,
	span: Span,
	work: () => T | Promise<T>,
): T | Promise<T> => {
	try {
		const result = work();
		if (result instanceof Promise) {
			return result.catch((error: unknown) => {
				throw markCaller(run, span, error);
			});
		}
		return result;
	} catch (error) {
		throw markCaller(run, span, error);
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
	const names = run.template.resolved;
	let ref = names.get(name);
	if (ref === undefined) {
		const resolved = locating(run, span, () =>
			resolveTemplateName(name, run.template.name),
		);
		ref = { resolved, template: null, generation: -1 };
		remember(names, name, ref);
	}
	return loadRef(run, ref, span, ignoreMissing);
};

/** Names may come from data, so the caches of resolved names can't grow without limit. */
const remember = (
	names: Map<string, TemplateRef>,
	name: string,
	ref: TemplateRef,
) => {
	if (names.size >= MAX_NAMES) names.clear();
	names.set(name, ref);
};

const MAX_NAMES = 1000;

/** The template a reference found, while the environment hasn't dropped templates since, or else loads it again. */
const loadRef = (
	run: Run,
	ref: TemplateRef,
	span: Span,
	ignoreMissing: boolean,
): CompiledTemplate | null | Promise<CompiledTemplate | null> => {
	const generation = run.state.env.generation;
	if (ref.template !== null && ref.generation === generation) {
		return ref.template;
	}
	const loaded = loadResolved(run, ref.resolved, span, ignoreMissing);
	if (loaded !== null && !(loaded instanceof Promise)) {
		ref.template = loaded;
		ref.generation = generation;
	}
	return loaded;
};

/** Loads a template by its resolved name. */
const loadResolved = (
	run: Run,
	resolved: string,
	span: Span,
	ignoreMissing: boolean,
): CompiledTemplate | null | Promise<CompiledTemplate | null> => {
	let loaded: ReturnType<RenderState["env"]["load"]>;
	try {
		loaded = run.state.env.load(resolved);
	} catch (error) {
		throw locate(run, span, error, LOADER);
	}
	if (loaded instanceof Promise) {
		run.state.stream?.wait();
		const path = resolved;
		return loaded.then(
			(template) => checkLoaded(run, span, path, template, ignoreMissing),
			(error: unknown) => {
				throw locate(run, span, error, LOADER);
			},
		);
	}
	return checkLoaded(run, span, resolved, loaded, ignoreMissing);
};

const LOADER = "The template loader";

const checkLoaded = (
	run: Run,
	span: Span,
	resolved: string,
	template: CompiledTemplate | null,
	ignoreMissing: boolean,
): CompiledTemplate | null => {
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
};

/**
 * Renders an include or a component into `out`: loads the template, gives it a scope of its own holding `variables`,
 * and renders it. `slots` holds a component's fills. Waits only when loading or rendering returns a promise.
 */
export const embed = (
	run: Run,
	out: Out,
	span: Span,
	name: unknown,
	variables: unknown,
	slots: Map<string, SlotFill> | null,
	ignoreMissing: boolean,
): void | Promise<void> => {
	const loaded = loadTemplate(run, name, span, ignoreMissing);
	if (loaded instanceof Promise) {
		return loaded.then((template) => {
			if (!template) return;
			const { scope, passed } = isolatedScope(run, variables, span);
			return enter(run, out, span, template, scope, passed, slots);
		});
	}
	if (!loaded) return;
	const { scope, passed } = isolatedScope(run, variables, span);
	return enter(run, out, span, loaded, scope, passed, slots);
};

/**
 * `embed` for a scope the caller made, holding the variables named in `passed`. Precompiled templates make it
 * themselves when `with` is a hash of known keys.
 */
export const embedScope = (
	run: Run,
	out: Out,
	span: Span,
	name: unknown,
	scope: Scope,
	passed: readonly string[],
	slots: Map<string, SlotFill> | null,
	ignoreMissing: boolean,
): void | Promise<void> => {
	return embedLoaded(
		run,
		out,
		span,
		loadTemplate(run, name, span, ignoreMissing),
		scope,
		passed,
		slots,
	);
};

/**
 * `embedScope` for a name made of a known prefix and a string key, such as `"sections/" ~ section.type`. Each key's
 * resolved name is kept on the including template, so the full name isn't built and looked up on every render.
 * `nameSpan` is where the name is joined, for its errors.
 */
export const embedKeyed = (
	run: Run,
	out: Out,
	span: Span,
	prefix: string,
	key: string,
	nameSpan: Span,
	scope: Scope,
	passed: readonly string[],
	slots: Map<string, SlotFill> | null,
	ignoreMissing: boolean,
): void | Promise<void> => {
	const template = run.template;
	template.keyed ??= new Map();
	let names = template.keyed.get(prefix);
	if (!names) {
		names = new Map();
		template.keyed.set(prefix, names);
	}
	let ref = names.get(key);
	if (ref === undefined) {
		const name = locating(run, nameSpan, () => checkLength(run, prefix + key));
		const resolved = locating(run, span, () =>
			resolveTemplateName(name, template.name),
		);
		ref = { resolved, template: null, generation: -1 };
		remember(names, key, ref);
	}
	return embedLoaded(
		run,
		out,
		span,
		loadRef(run, ref, span, ignoreMissing),
		scope,
		passed,
		slots,
	);
};

const embedLoaded = (
	run: Run,
	out: Out,
	span: Span,
	loaded: CompiledTemplate | null | Promise<CompiledTemplate | null>,
	scope: Scope,
	passed: readonly string[],
	slots: Map<string, SlotFill> | null,
): void | Promise<void> => {
	if (loaded instanceof Promise) {
		return loaded.then((template) =>
			template
				? enter(run, out, span, template, scope, passed, slots)
				: undefined,
		);
	}
	if (!loaded) return;
	// Most partials extend nothing, define no blocks and import nothing, so they render without `renderTemplate`.
	if (
		loaded.parent === null &&
		loaded.blocks.size === 0 &&
		loaded.imports.length === 0
	) {
		const state = run.state;
		const depth = run.depth + 1;
		if (depth > state.maxDepth) {
			throw fail(
				run,
				span,
				"limit-depth",
				`Render stopped after nesting ${state.maxDepth} templates, macros or layouts deep`,
			);
		}
		if (slots !== null || loaded.slotNames.length > 0) {
			addSlotFlags(scope, loaded, slots);
		}
		try {
			const result = loaded.body(
				new Run(state, loaded, depth, slots, passed),
				scope,
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
	}
	return enter(run, out, span, loaded, scope, passed, slots);
};

const enter = (
	run: Run,
	out: Out,
	span: Span,
	template: CompiledTemplate,
	scope: Scope,
	passed: readonly string[],
	slots: Map<string, SlotFill> | null,
): void | Promise<void> => {
	addSlotFlags(scope, template, slots);
	try {
		const result = renderTemplate(
			run.state,
			template,
			scope,
			out,
			run.depth + 1,
			slots,
			passed,
			null,
			run,
			span,
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
};

/** Loads every template a template imports, once per render. */
export const importsFor = (
	run: Run,
	template: CompiledTemplate,
): readonly CompiledTemplate[] | Promise<readonly CompiledTemplate[]> => {
	if (template.imports.length === 0) return NO_IMPORTS;
	const state = run.state;
	const cached = state.importsCache?.get(template);
	if (cached) return cached;

	const loaded = template.imports.map(({ name, span }) =>
		loadTemplate(new Run(state, template, run.depth, null, null), name, span),
	);
	const finish = (list: (CompiledTemplate | null)[]) => {
		const imports = list as CompiledTemplate[];
		state.importsCache ??= new Map();
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
	const scope = childScope(run.state.globals);
	const passed: string[] = [];
	if (variables === null || variables === undefined) return { scope, passed };
	if (isPlainObject(variables)) {
		const keys = hashKeys(variables);
		for (const key of keys) scope[key] = variables[key] ?? null;
		return { scope, passed: keys };
	}
	if (variables instanceof Map) {
		for (const [key, value] of variables) {
			if (typeof key === "string") {
				scope[key] = value ?? null;
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

/**
 * Renders a template into `out`, following `extends` and sharing `scope` along the inheritance chain. `inherited` is
 * the block table of the child templates below it, and `caller` the render that asked for it, for depth errors: null
 * for the outermost render. `block`, for `renderBlock`, is the block to render once the top-most template is reached,
 * instead of its content.
 */
export const renderTemplate = (
	state: RenderState,
	template: CompiledTemplate,
	scope: Scope,
	out: Out,
	depth: number,
	slots: Map<string, SlotFill> | null,
	passed: readonly string[] | null,
	inherited: Map<string, BlockEntry[]> | null,
	caller: Run | null,
	callerSpan: Span,
	block?: string,
): void | Promise<void> => {
	if (caller && depth > state.maxDepth) {
		throw fail(
			caller,
			callerSpan,
			"limit-depth",
			`Render stopped after nesting ${state.maxDepth} templates, macros or layouts deep`,
		);
	}

	const run = new Run(state, template, depth, slots, passed);

	// Every template in an inheritance chain shares one block table, most derived definition first, so `parent()` can find the next one from any level.
	if (inherited || template.blocks.size > 0) {
		const blocks = inherited ?? new Map<string, BlockEntry[]>();
		template.blockList ??= [...template.blocks];
		const defined = template.blockList;
		for (let i = 0; i < defined.length; i++) {
			const [name, def] = defined[i] as readonly [string, BlockDef];
			const entry = { def, run };
			const list = blocks.get(name);
			if (list) list.push(entry);
			else blocks.set(name, [entry]);
		}
		run.blocks = blocks;
	}

	const imports = importsFor(run, template);
	if (imports instanceof Promise) {
		return imports.then((list) => renderBody(run, scope, out, list, block));
	}
	return renderBody(run, scope, out, imports, block);
};

/** Renders a template's own content once its imports are loaded, then its layout if it extends one. */
const renderBody = (
	run: Run,
	scope: Scope,
	out: Out,
	imports: readonly CompiledTemplate[],
	block: string | undefined,
): void | Promise<void> => {
	run.imports = imports;
	const { template, state } = run;
	const parent = template.parent;
	if (!parent && block !== undefined) {
		return renderOnlyBlock(run, scope, out, block);
	}
	const result = template.body(run, scope, out);
	if (!parent) return result;

	const span = template.parentSpan;
	// Usually nothing waits: the layout is found and rendered without callbacks.
	if (result === undefined && !parent.async) {
		const loaded = loadTemplate(run, parent.ev(run, scope), span);
		if (!(loaded instanceof Promise)) {
			try {
				const layout = renderTemplate(
					state,
					loaded as CompiledTemplate,
					scope,
					out,
					run.depth + 1,
					run.slots,
					// Layouts check required props, but not undeclared ones: the context was meant for the page.
					null,
					run.blocks,
					run,
					span,
					block,
				);
				if (layout instanceof Promise) {
					return layout.catch((error: unknown) => {
						throw markCaller(run, span, error);
					});
				}
				return layout;
			} catch (error) {
				throw markCaller(run, span, error);
			}
		}
		return loaded.then((layout) =>
			withCaller(run, span, () =>
				renderTemplate(
					state,
					layout as CompiledTemplate,
					scope,
					out,
					run.depth + 1,
					run.slots,
					null,
					run.blocks,
					run,
					span,
					block,
				),
			),
		);
	}
	return after(result, () =>
		after(parent.ev(run, scope), (name) =>
			after(loadTemplate(run, name, span), (parentTemplate) =>
				withCaller(run, span, () =>
					renderTemplate(
						state,
						parentTemplate as CompiledTemplate,
						scope,
						out,
						run.depth + 1,
						run.slots,
						// Layouts check required props, but not undeclared ones: the context was meant for the page.
						null,
						run.blocks,
						run,
						span,
						block,
					),
				),
			),
		),
	);
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
		return entry.def.body(entry.run, blockScope(entry.def, scope), out);
	});

/** Gives a component or include scope its `slots` hash, with a key for every slot the template outputs. */
export const addSlotFlags = (
	scope: Scope,
	template: CompiledTemplate,
	slots: Map<string, SlotFill> | null,
): void => {
	if (template.slotNames.length === 0 && !slots) return;
	// A plain object, which V8 keeps fast; templates only read its own properties.
	const flags: Record<string, boolean> = {};
	for (const name of template.slotNames) setOwn(flags, name, false);
	if (slots) for (const name of slots.keys()) setOwn(flags, name, true);
	scope.slots = flags;
};
