import {
	createDiagnostic,
	type Diagnostic,
	KilnSyntaxError,
} from "../errors.js";
import { resolveTemplateName } from "../names.js";
import {
	type Argument,
	DEFAULT_SLOT,
	ESCAPE_STRATEGIES,
	type EscapeStrategy,
	type Expression,
	type FilterCall,
	type HashEntry,
	type PropType,
	type Statement,
	type TemplateNode,
} from "../parser/ast.js";
import { parse } from "../parser/parser.js";
import { getAttr, getMethod, readableNames } from "../runtime/access.js";
import { packSaved, unpackSaved } from "../runtime/cache.js";
import { escapeHtml, escapeWith } from "../runtime/escape.js";
import {
	ISLAND_CLOSING,
	ISLAND_SCRIPT,
	type IslandMode,
	islandProps,
	type JsonValue,
	recordIsland,
	streamIsland,
} from "../runtime/islands.js";
import { callMacro } from "../runtime/macros.js";
import { Markup } from "../runtime/markup.js";
import { operatorFunction, rangeOperator } from "../runtime/operators.js";
import { closeOutlets, recordAddition } from "../runtime/outlets.js";
import {
	after,
	all,
	checkLength,
	consume,
	embed,
	fail,
	type IndentedText,
	indentedText,
	indentText,
	isPromise,
	loadTemplate,
	locate,
	locating,
	markCaller,
	endPlace,
	runFrom,
	silence,
	startPlace,
	step,
	unhold,
	withCaller,
	write,
} from "../runtime/render.js";
import {
	childScope,
	lookup,
	ownerOf,
	variableNames,
} from "../runtime/scope.js";
import {
	type BlockDef,
	type Builtin,
	blockScope,
	type CallableEntry,
	type Compiled,
	type CompiledMacro,
	type CompiledTemplate,
	type EnvironmentCore,
	emptyOut,
	type Ev,
	fillScope,
	type Out,
	type PathStep,
	type Run,
	type Scope,
	type SlotFill,
	type Stmt,
} from "../runtime/types.js";
import {
	BLOCKED_NAMES,
	describeType,
	describeValue,
	hashKeys,
	isEmpty,
	isPlainObject,
	literalOptions,
	MISSING,
	matchesType,
	setOwn,
	templateFunctions,
	toNumber,
	toStr,
	truthy,
	typeName,
	valueLabel,
} from "../runtime/values.js";
import { Source, type Span } from "../source.js";
import { suggest } from "../suggest.js";
import { constant, evalAll, map1, map2 } from "./combinators.js";

/** Marks a short-circuited optional chain while it is being evaluated. */
export const SHORT: unique symbol = Symbol("kiln.short");
/** Scope key holding the captured body of an `apply` tag. Templates cannot name symbols. */
const CAPTURED: unique symbol = Symbol("kiln.captured");

const NOOP: Stmt = () => {};

/** JavaScript engines overflow the stack well before 100,000 arguments, so spreads into calls stop here. */
const MAX_ARGUMENTS = 10_000;

/** Deepest expression the compiler accepts. Each level costs a few stack frames when compiling and rendering. */
const MAX_EXPRESSION_DEPTH = 1000;

const PROTO_KEY_MESSAGE = '"__proto__" cannot be used as a key';

const BUILTIN_CALLS = new Set(["parent", "block"]);

type ArgumentShape = { kind: Argument["type"]; name: string };

type CompiledArguments = {
	/** Each argument's expression, in order. */
	evs: Ev[];
	values: (run: Run, scope: Scope) => unknown[] | Promise<unknown[]>;
	shapes: ArgumentShape[];
	async: boolean;
	arrowAsync: boolean;
};

/**
 * Runs of statements a precompiled template generated, by the offset where each run's first statement starts. Each
 * replaces the statements from there to the one ending at `end`. See `precompiled.ts`.
 */
export type GeneratedRuns = ReadonlyMap<number, { end: number; run: Stmt }>;

/**
 * Parses and compiles template source into closures. Problems are collected in `diagnostics`; the template renders
 * only when there are none. `generated` holds a precompiled template's generated statements.
 */
export const compileTemplate = (
	env: EnvironmentCore,
	name: string,
	text: string,
	generated?: GeneratedRuns,
): CompiledTemplate => {
	const source = new Source(name, text);
	const { ast, problems } = parse(text, {
		isTest: (test) => env.tests.has(test),
	});
	const diagnostics = problems.map((problem) =>
		createDiagnostic(source, problem.code, problem.message, problem.span),
	);
	return new Compiler(env, source, ast, diagnostics, generated).compile();
};

const makeEmitter =
	(strategy: EscapeStrategy | false) =>
	(value: unknown): string => {
		if (typeof value === "string") {
			return strategy ? escapeWith(value, strategy) : value;
		}
		if (typeof value === "number") {
			const text = String(value);
			return strategy && strategy !== "html"
				? escapeWith(text, strategy)
				: text;
		}
		if (value instanceof Markup) {
			// Every strategy's output is also safe in HTML, so HTML output accepts any markup.
			return !strategy || strategy === "html" || value.strategy === strategy
				? value.value
				: escapeWith(value.value, strategy);
		}
		const text = toStr(value);
		return strategy ? escapeWith(text, strategy) : text;
	};

const emitters = new Map<EscapeStrategy | false, (value: unknown) => string>();

/** Prints a value with an escaping strategy, or none. One function per strategy, shared. */
export const emitter = (
	strategy: EscapeStrategy | false,
): ((value: unknown) => string) => {
	let emit = emitters.get(strategy);
	if (!emit) {
		emit = makeEmitter(strategy);
		emitters.set(strategy, emit);
	}
	return emit;
};

/** Text, or an output whose expression never waits, in a run that `printParts` prints. */
type Part =
	| { text: string; lines: readonly number[] | undefined; span: Span }
	| {
			text: null;
			compiled: Compiled;
			strategy: EscapeStrategy | false;
			span: Span;
	  };

/** How `printParts` evaluates an output: a variable and literal keys, a choice of two literals, or anything else. */
type Read = "path" | "choice" | "other";

/**
 * Prints a run of text and outputs into one string, then writes it to the buffer once. Each output still counts a
 * step before it is evaluated, so limits stop the render at the same output.
 *
 * The commonest outputs are evaluated in place rather than through their compiled closures: variables with literal
 * keys, such as `{{ post.title }}`, read own properties of plain objects directly, and choices between two literals,
 * such as `{{ active ? "on" : "off" }}`, print text emitted when compiling. Anything unusual, such as a missing
 * variable, falls back to the full expression, so results and errors are the same.
 */
const printParts = (list: Part[]): Stmt => {
	// Neighbouring text, such as text around a tag that compiled to nothing, joins into one part.
	const parts: Part[] = [];
	for (const part of list) {
		const last = parts.at(-1);
		if (part.text !== null && last && last.text !== null) {
			const offset = last.text.length;
			const lines = part.lines
				? [...(last.lines ?? []), ...part.lines.map((start) => start + offset)]
				: last.lines;
			parts[parts.length - 1] = {
				text: last.text + part.text,
				lines,
				span: { start: last.span.start, end: part.span.end },
			};
		} else parts.push(part);
	}
	const first = parts[0] as Part;
	const span = {
		start: first.span.start,
		end: (parts.at(-1) as Part).span.end,
	};
	if (parts.length === 1 && first.text !== null) {
		const text = first.text;
		if (!first.lines) {
			return (run, _scope, out) => {
				write(run, out, text, span);
			};
		}
		const entry = indentedText(text, first.lines);
		return (run, _scope, out) => {
			const indent = out.indent;
			write(
				run,
				out,
				indent === "" ? text : indentText(entry, indent, out.inline),
				span,
			);
		};
	}

	const count = parts.length;
	const texts: (string | null)[] = [];
	// Text with line starts, which take the indentation of where it is inserted.
	const indented: (IndentedText | null)[] = [];
	const reads: Read[] = [];
	const evs: (Ev | null)[] = [];
	const emits: (((value: unknown) => string) | null)[] = [];
	const html: boolean[] = [];
	const roots: (string | null)[] = [];
	const names: (string | null)[][] = [];
	const steps: PathStep["read"][][] = [];
	const stepSpans: Span[][] = [];
	const choices: [string, string][] = [];
	for (const part of parts) {
		const output = part.text === null ? part : null;
		const compiled = output?.compiled;
		const emit = output ? emitter(output.strategy) : null;
		const path = compiled?.path;
		const root = compiled?.variable ?? path?.root.variable ?? null;
		const choice = compiled?.choice ? emitChoice(compiled.choice, emit) : null;
		texts.push(part.text);
		indented.push(
			part.text !== null && part.lines
				? indentedText(part.text, part.lines)
				: null,
		);
		reads.push(root !== null ? "path" : choice ? "choice" : "other");
		evs.push(compiled?.ev ?? null);
		emits.push(emit);
		html.push(output?.strategy === "html");
		roots.push(root);
		names.push(path ? path.steps.map((access) => access.name) : NO_NAMES);
		steps.push(path ? path.steps.map((access) => access.read) : NO_READS);
		stepSpans.push(path ? path.steps.map((access) => access.span) : NO_SPANS);
		choices.push(choice ?? NO_CHOICE);
	}
	const tests = parts.map((part) =>
		part.text === null && part.compiled.choice
			? part.compiled.choice.test
			: null,
	);
	const spans = parts.map((part) => part.span);

	return (run, scope, out) => {
		const indent = out.indent;
		let text = "";
		for (let i = 0; i < count; i++) {
			const part = texts[i];
			if (part !== null) {
				const entry = indented[i];
				text +=
					indent === "" || !entry
						? part
						: entry.indent === indent && !out.inline
							? entry.indented
							: indentText(entry, indent, text === "" && out.inline);
				continue;
			}
			const at = spans[i] as Span;
			step(run, at);
			const kind = reads[i];
			if (kind === "choice") {
				const [yes, no] = choices[i] as [string, string];
				text += truthy((tests[i] as Ev)(run, scope)) ? yes : no;
				continue;
			}
			let value: unknown;
			if (kind === "path") {
				value = lookup(scope, roots[i] as string);
				if (value === undefined || typeof value === "function") {
					value = (evs[i] as Ev)(run, scope);
				} else {
					value = readKeys(
						run,
						value,
						names[i] as (string | null)[],
						steps[i] as PathStep["read"][],
						stepSpans[i] as Span[],
					);
				}
			} else value = (evs[i] as Ev)(run, scope);
			if (typeof value === "string" && html[i]) {
				text += escapeHtml(value);
				continue;
			}
			try {
				text += (emits[i] as (value: unknown) => string)(value);
			} catch (error) {
				throw locate(run, at, error);
			}
		}
		write(run, out, text, span);
	};
};

const NO_NAMES: (string | null)[] = [];
const NO_READS: PathStep["read"][] = [];
const NO_SPANS: Span[] = [];
const NO_CHOICE: [string, string] = ["", ""];

/** Emits both branches of a choice when compiling, or returns null when emitting one fails, so it fails at render. */
const emitChoice = (
	choice: NonNullable<Compiled["choice"]>,
	emit: ((value: unknown) => string) | null,
): [string, string] | null => {
	if (!emit) return null;
	try {
		return [emit(choice.yes), emit(choice.no)];
	} catch {
		return null;
	}
};

/**
 * Reads literal keys one after another. Own properties of plain objects are read inline, and everything else goes
 * through each step's full `read`, so the result is the same as reading one key at a time.
 */
const readKeys = (
	run: Run,
	target: unknown,
	names: readonly (string | null)[],
	reads: readonly PathStep["read"][],
	spans: readonly Span[],
): unknown => {
	let value = target;
	let i = 0;
	try {
		for (; i < names.length; i++) {
			const name = names[i] as string | null;
			if (name !== null && typeof value === "object" && value !== null) {
				const proto = Object.getPrototypeOf(value);
				if (proto === Object.prototype || proto === null) {
					const item = (value as Record<string, unknown>)[name];
					if (
						item !== undefined &&
						typeof item !== "function" &&
						Object.hasOwn(value, name)
					) {
						value = item;
						continue;
					}
				}
			}
			value = (reads[i] as PathStep["read"])(run, value);
		}
	} catch (error) {
		// A getter in your data threw. Errors from the full reads are located already.
		throw locate(run, spans[i] as Span, error, readingLabel(names[i] ?? ""));
	}
	return value;
};

const isBlank = (statement: Statement) =>
	statement.type === "Text" && statement.value.trim() === "";

/** Whether statements may set a variable, at any depth. */
export const setsVariables = (statements: readonly Statement[]): boolean =>
	containsNode(
		statements,
		(record) => record.type === "Set" || record.type === "SetBlock",
	);

/** Checks whether any node under `node` matches. */
export const containsNode = (
	node: unknown,
	matches: (record: Record<string, unknown>) => boolean,
): boolean => {
	// Iterative, because long expression chains can be thousands of levels deep.
	// Only objects go on the stack: strings, numbers and spans hold no nodes.
	const stack: object[] =
		typeof node === "object" && node !== null ? [node] : [];
	while (stack.length > 0) {
		const current = stack.pop() as object;
		if (Array.isArray(current)) {
			for (const item of current as unknown[]) {
				if (typeof item === "object" && item !== null) stack.push(item);
			}
			continue;
		}
		const record = current as Record<string, unknown>;
		if (matches(record)) return true;
		for (const key in record) {
			if (key === "span" || key === "nameSpan") continue;
			const value = record[key];
			if (typeof value === "object" && value !== null) stack.push(value);
		}
	}
	return false;
};

/**
 * What a loop body does, found in one walk. `readsLoop`: it may read `loop`, so loops only build the `loop` hash when
 * needed. Blocks count too, because a child template's block can read the loop it is placed in. `keepsScope`: it has
 * `set` or arrow functions, which can keep or change an iteration's scope.
 */
const scanLoopBody = (
	body: Statement[],
): { readsLoop: boolean; keepsScope: boolean } => {
	let readsLoop = false;
	let keepsScope = false;
	containsNode(body, (record) => {
		if (
			(record.type === "Name" && record.name === "loop") ||
			record.type === "Block" ||
			(record.type === "Call" &&
				(record.callee as { type?: string; name?: string }).type === "Name" &&
				(record.callee as { name?: string }).name === "block")
		) {
			readsLoop = true;
		} else if (
			record.type === "Set" ||
			record.type === "SetBlock" ||
			record.type === "Arrow"
		) {
			keepsScope = true;
		}
		return readsLoop && keepsScope;
	});
	return { readsLoop, keepsScope };
};

class Compiler {
	readonly #env: EnvironmentCore;
	readonly #source: Source;
	readonly #ast: TemplateNode;
	readonly #diagnostics: Diagnostic[];
	readonly #template: CompiledTemplate;

	#strategy: EscapeStrategy | false;
	/** The block being compiled, for `parent()`. */
	#blockName: string | null = null;
	#inMacro = false;
	#expressionDepth = 0;
	readonly #importAliases = new Map<string, number>();
	readonly #fromImports = new Map<string, { slot: number; name: string }>();
	readonly #generated: GeneratedRuns | undefined;

	constructor(
		env: EnvironmentCore,
		source: Source,
		ast: TemplateNode,
		diagnostics: Diagnostic[],
		generated: GeneratedRuns | undefined,
	) {
		this.#env = env;
		this.#generated = generated;
		this.#source = source;
		this.#ast = ast;
		this.#diagnostics = diagnostics;
		this.#strategy = env.autoescape;
		const template: CompiledTemplate = {
			name: source.name,
			source,
			ast,
			diagnostics,
			hasErrors: false,
			syntaxError: () => new KilnSyntaxError(diagnostics, source),
			body: NOOP,
			props: null,
			parent: null,
			parentSpan: { start: 0, end: 0 },
			blocks: new Map(),
			macros: new Map(),
			imports: [],
			resolved: new Map(),
			slotNames: [],
		};
		this.#template = template;
	}

	compile(): CompiledTemplate {
		const template = this.#template;
		const body = this.#ast.body;

		this.#collectNames(body);
		this.#collectMacros(body);

		const first = body.find((statement) => !isBlank(statement));
		const extendsNode = first?.type === "Extends" ? first : null;
		this.#checkPlacement(body, extendsNode !== null);

		if (extendsNode) {
			template.parent = this.#expr(extendsNode.template);
			template.parentSpan = extendsNode.span;
			const statements: Stmt[] = [];
			for (const statement of body) {
				if (
					statement.type === "Set" ||
					statement.type === "SetBlock" ||
					statement.type === "Props"
				) {
					statements.push(this.#statement(statement));
				} else if (statement.type === "Block") {
					this.#defineBlock(statement);
				}
			}
			template.body = this.#sequence(statements);
		} else {
			template.body = this.#body(body);
		}

		// Lexer, parser and compiler problems are found in separate passes. Report them in source order.
		this.#diagnostics.sort((a, b) => a.start.offset - b.start.offset);
		template.hasErrors = this.#diagnostics.some((d) => d.severity === "error");
		return template;
	}

	// Diagnostics

	#error(code: string, message: string, span: Span): void {
		this.#diagnostics.push(createDiagnostic(this.#source, code, message, span));
	}

	/** `__proto__` keys would hand host code an object that changes its own prototype when merged. */
	#protoKey(span: Span): void {
		this.#error("invalid-key", PROTO_KEY_MESSAGE, span);
	}

	/** A compiled expression for code that can never run, because compiling it reported an error. */
	#broken(): Compiled {
		return constant(null);
	}

	// Pre-passes

	#walkStatements(
		statements: Statement[],
		visit: (statement: Statement) => void,
	): void {
		for (const statement of statements) {
			visit(statement);
			switch (statement.type) {
				case "If":
					for (const branch of statement.branches) {
						this.#walkStatements(branch.body, visit);
					}
					if (statement.alternate)
						this.#walkStatements(statement.alternate, visit);
					break;
				case "For":
					this.#walkStatements(statement.body, visit);
					if (statement.alternate)
						this.#walkStatements(statement.alternate, visit);
					break;
				case "Component":
					this.#walkStatements(statement.body, visit);
					for (const fill of statement.fills)
						this.#walkStatements(fill.body, visit);
					break;
				case "Island":
				case "SetBlock":
				case "Block":
				case "Slot":
				case "Macro":
				case "Add":
				case "Cache":
				case "With":
				case "Apply":
				case "Autoescape":
					this.#walkStatements(statement.body, visit);
					break;
			}
		}
	}

	/**
	 * Collects what is visible everywhere in the file before compiling anything, in one walk: imports, slot names,
	 * and block names, which must be unique.
	 */
	#collectNames(body: Statement[]): void {
		const template = this.#template;
		const slotNames = new Set<string>();
		const blockNames = new Set<string>();
		const addImport = (name: string, span: Span): number => {
			let resolved = name;
			try {
				resolved = resolveTemplateName(name, template.name);
			} catch (error) {
				this.#error(
					"invalid-template-name",
					error instanceof Error ? error.message : String(error),
					span,
				);
			}
			template.imports.push({ name: resolved, span });
			return template.imports.length - 1;
		};

		this.#walkStatements(body, (statement) => {
			if (statement.type === "Slot") slotNames.add(statement.name);
			else if (statement.type === "Block") {
				if (blockNames.has(statement.name)) {
					this.#error(
						"duplicate-block",
						`Block "${statement.name}" is defined more than once`,
						statement.span,
					);
				}
				blockNames.add(statement.name);
			} else if (statement.type === "Import") {
				if (
					this.#env.functions.has(statement.alias) ||
					BUILTIN_CALLS.has(statement.alias)
				) {
					this.#error(
						"macro-conflict",
						`Import alias "${statement.alias}" has the same name as a function. Choose another alias`,
						statement.span,
					);
				}
				if (this.#importAliases.has(statement.alias)) {
					this.#error(
						"duplicate-import",
						`"${statement.alias}" is imported more than once`,
						statement.span,
					);
				}
				this.#importAliases.set(
					statement.alias,
					addImport(statement.template, statement.span),
				);
			} else if (statement.type === "FromImport") {
				const slot = addImport(statement.template, statement.span);
				for (const entry of statement.names) {
					if (
						this.#env.functions.has(entry.alias) ||
						BUILTIN_CALLS.has(entry.alias)
					) {
						this.#error(
							"macro-conflict",
							`Imported macro "${entry.alias}" has the same name as a function. Import it with "as" and another name`,
							entry.span,
						);
					}
					if (this.#fromImports.has(entry.alias)) {
						this.#error(
							"duplicate-import",
							`"${entry.alias}" is imported more than once`,
							entry.span,
						);
					}
					this.#fromImports.set(entry.alias, { slot, name: entry.name });
				}
			}
		});
		template.slotNames = [...slotNames];
	}

	#collectMacros(body: Statement[]): void {
		const macros = this.#template.macros;
		const placeholders: {
			statement: Extract<Statement, { type: "Macro" }>;
			macro: CompiledMacro;
		}[] = [];
		for (const statement of body) {
			if (statement.type !== "Macro" || statement.name === "") continue;
			if (macros.has(statement.name)) {
				this.#error(
					"duplicate-macro",
					`Macro "${statement.name}" is defined more than once`,
					statement.span,
				);
				continue;
			}
			if (
				this.#env.functions.has(statement.name) ||
				BUILTIN_CALLS.has(statement.name)
			) {
				this.#error(
					"macro-conflict",
					`Macro "${statement.name}" has the same name as a function. Rename the macro`,
					statement.span,
				);
			}
			if (this.#fromImports.has(statement.name)) {
				this.#error(
					"macro-conflict",
					`Macro "${statement.name}" has the same name as an imported macro`,
					statement.span,
				);
			}
			const macro: CompiledMacro = {
				name: statement.name,
				params: [],
				body: NOOP,
				strategy: this.#env.autoescape,
				template: this.#template,
			};
			macros.set(statement.name, macro);
			placeholders.push({ statement, macro });
		}

		// Compile bodies after every name is known, so macros can call each other in any order.
		for (const { statement, macro } of placeholders) {
			const saved = { block: this.#blockName, inMacro: this.#inMacro };
			this.#blockName = null;
			this.#inMacro = true;
			macro.params = statement.params.map((param) => ({
				name: param.name,
				default: param.default ? this.#expr(param.default) : null,
			}));
			macro.body = this.#body(statement.body);
			this.#blockName = saved.block;
			this.#inMacro = saved.inMacro;
		}
	}

	/** Checks where tags may appear: `extends` first, child templates' top level, `props` and macros. */
	#checkPlacement(body: Statement[], isChild: boolean): void {
		let seenContent = false;
		let seenProps = false;
		let onlyBlankBefore = true;
		for (const statement of body) {
			const isFirst = onlyBlankBefore;
			if (!isBlank(statement)) onlyBlankBefore = false;
			switch (statement.type) {
				case "Extends":
					if (!isFirst) {
						this.#error(
							"extends-not-first",
							'"extends" must be the first tag in the template',
							statement.span,
						);
					}
					break;
				case "Props":
					if (seenProps) {
						this.#error(
							"duplicate-props",
							'A template can only have one "props" tag',
							statement.span,
						);
					} else if (seenContent) {
						this.#error(
							"props-not-first",
							'"props" must come before any content',
							statement.span,
						);
					}
					seenProps = true;
					break;
				case "Text":
					if (!isBlank(statement)) seenContent = true;
					break;
				case "Set":
				case "SetBlock":
				case "Import":
				case "FromImport":
				case "Macro":
					break;
				default:
					seenContent = true;
			}

			if (isChild) {
				const allowed =
					statement.type === "Extends" ||
					statement.type === "Block" ||
					statement.type === "Set" ||
					statement.type === "SetBlock" ||
					statement.type === "Props" ||
					statement.type === "Import" ||
					statement.type === "FromImport" ||
					statement.type === "Macro" ||
					isBlank(statement);
				if (!allowed) {
					this.#error(
						"invalid-child-content",
						'A template that uses "extends" can only contain blocks, "set", "props", "import", "from" and "macro" at its top level',
						statement.span,
					);
				}
			}
		}

		const checkNested = (
			statements: Statement[],
			depth: number,
			inMacro: boolean,
		) => {
			for (const statement of statements) {
				if (depth > 0 && statement.type === "Macro") {
					this.#error(
						"invalid-macro-placement",
						"Macros must be defined at the top level of a template",
						statement.span,
					);
				}
				if (depth > 0 && statement.type === "Extends") {
					this.#error(
						"extends-not-first",
						'"extends" must be the first tag in the template',
						statement.span,
					);
				}
				if (depth > 0 && statement.type === "Props") {
					this.#error(
						"props-not-first",
						'"props" must be at the top level of a template',
						statement.span,
					);
				}
				if (inMacro && statement.type === "Block") {
					this.#error(
						"invalid-block-placement",
						"Blocks cannot be defined inside macros",
						statement.span,
					);
				}
				const nestedMacro = inMacro || statement.type === "Macro";
				this.#walkChildren(statement, (children) =>
					checkNested(children, depth + 1, nestedMacro),
				);
			}
		};
		checkNested(body, 0, false);
	}

	#walkChildren(
		statement: Statement,
		visit: (children: Statement[]) => void,
	): void {
		switch (statement.type) {
			case "If":
				for (const branch of statement.branches) visit(branch.body);
				if (statement.alternate) visit(statement.alternate);
				break;
			case "For":
				visit(statement.body);
				if (statement.alternate) visit(statement.alternate);
				break;
			case "Component":
				visit(statement.body);
				for (const fill of statement.fills) visit(fill.body);
				break;
			case "Island":
			case "SetBlock":
			case "Block":
			case "Slot":
			case "Macro":
			case "Add":
			case "Cache":
			case "With":
			case "Apply":
			case "Autoescape":
				visit(statement.body);
				break;
		}
	}

	// Statements

	#sequence(statements: Stmt[]): Stmt {
		const list = statements.filter((statement) => statement !== NOOP);
		if (list.length === 0) return NOOP;
		if (list.length === 1) return list[0] as Stmt;
		return (run, scope, out) => runFrom(list, 0, run, scope, out);
	}

	/** Compiles statements in order. Runs of text and outputs that never wait become one statement, see `printParts`. */
	#body(statements: Statement[]): Stmt {
		const compiled: Stmt[] = [];
		let parts: Part[] = [];
		const flush = () => {
			if (parts.length > 0) compiled.push(printParts(parts));
			parts = [];
		};
		for (let i = 0; i < statements.length; i++) {
			const statement = statements[i] as Statement;
			const generated = this.#generated?.get(statement.span.start);
			if (generated) {
				const last = statements.findIndex(
					(item, index) => index >= i && item.span.end === generated.end,
				);
				if (last !== -1) {
					flush();
					compiled.push(generated.run);
					this.#defineCovered(statements.slice(i, last + 1));
					i = last;
					continue;
				}
			}
			if (statement.type === "Text") {
				parts.push({
					text: statement.value,
					lines: statement.lines,
					span: statement.span,
				});
				continue;
			}
			if (statement.type === "Output") {
				const expression = this.#expr(statement.expression);
				if (!expression.async) {
					parts.push({
						text: null,
						compiled: expression,
						strategy: this.#strategy,
						span: statement.span,
					});
					continue;
				}
				flush();
				compiled.push(this.#output(expression, statement.span));
				continue;
			}
			flush();
			compiled.push(this.#statement(statement));
		}
		flush();
		return this.#sequence(compiled);
	}

	/**
	 * Blocks and `props` inside a generated run still need their definitions, which the closure compiler keeps: the
	 * generated code only places blocks, and `renderBlock` runs `props` on its own.
	 */
	#defineCovered(statements: Statement[]): void {
		for (const statement of statements) {
			if (statement.type === "Block") this.#defineBlock(statement);
			else if (statement.type === "Props") this.#props(statement);
			else if (statement.type === "Autoescape") {
				const saved = this.#strategy;
				this.#strategy = statement.strategy;
				this.#defineCovered(statement.body);
				this.#strategy = saved;
			} else {
				this.#walkChildren(statement, (children) =>
					this.#defineCovered(children),
				);
			}
		}
	}

	#statement(node: Statement): Stmt {
		switch (node.type) {
			case "Text":
			case "Output":
				return this.#body([node]);
			case "If":
				return this.#if(node);
			case "For":
				return this.#for(node);
			case "Set":
				return this.#set(node.name, this.#expr(node.value), node.span);
			case "SetBlock":
				return this.#setBlock(node);
			case "Props":
				return this.#props(node);
			case "Extends":
				// Handled by `compile`. A misplaced `extends` was already reported.
				return NOOP;
			case "Block":
				return this.#blockStatement(node);
			case "Include":
				return this.#include(node);
			case "Component":
				return this.#component(node);
			case "Island":
				return this.#island(node);
			case "Slot":
				return this.#slot(node);
			case "Macro":
			case "Import":
			case "FromImport":
				return NOOP;
			case "With":
				return this.#with(node);
			case "Cache":
				return this.#cache(node);
			case "Outlet":
				return this.#outlet(node);
			case "Flush":
				return this.#flush(node);
			case "Add":
				return this.#add(node);
			case "Apply":
				return this.#apply(node);
			case "Autoescape": {
				const saved = this.#strategy;
				this.#strategy = node.strategy;
				const body = this.#body(node.body);
				this.#strategy = saved;
				return body;
			}
		}
	}

	/** An output whose expression may wait for a promise. Outputs that never wait are printed by `printParts`. */
	#output(compiled: Compiled, span: Span): Stmt {
		const ev = compiled.ev;
		const emit = emitter(this.#strategy);
		const print = (run: Run, out: Out, value: unknown) => {
			let text: string;
			try {
				text = emit(value);
			} catch (error) {
				throw locate(run, span, error);
			}
			write(run, out, text, span);
		};
		return (run, scope, out) => {
			step(run, span);
			const value = ev(run, scope);
			if (isPromise(value)) {
				return value.then((resolved) => print(run, out, unhold(resolved)));
			}
			print(run, out, value);
		};
	}

	#if(node: Extract<Statement, { type: "If" }>): Stmt {
		const branches = node.branches.map((branch) => ({
			test: this.#expr(branch.test).ev,
			body: this.#body(branch.body),
		}));
		const alternate = node.alternate ? this.#body(node.alternate) : null;
		const span = node.span;

		const from = (
			index: number,
			run: Run,
			scope: Scope,
			out: Out,
		): void | Promise<void> => {
			for (let i = index; i < branches.length; i++) {
				const branch = branches[i] as (typeof branches)[number];
				const value = branch.test(run, scope);
				if (isPromise(value)) {
					return value.then((resolved) =>
						truthy(unhold(resolved))
							? branch.body(run, scope, out)
							: from(i + 1, run, scope, out),
					);
				}
				if (truthy(value)) return branch.body(run, scope, out);
			}
			return alternate?.(run, scope, out);
		};

		return (run, scope, out) => {
			step(run, span);
			return from(0, run, scope, out);
		};
	}

	#for(node: Extract<Statement, { type: "For" }>): Stmt {
		const iterable = this.#expr(node.iterable);
		const body = this.#body(node.body);
		const alternate = node.alternate ? this.#body(node.alternate) : null;
		const { keyName, valueName, span } = node;
		const { readsLoop: usesLoop, keepsScope } = scanLoopBody(node.body);
		// Without `set` or arrow functions nothing can keep or change an iteration's scope, so one object serves every
		// iteration.
		const shared = !keepsScope;

		const iterate = (
			run: Run,
			scope: Scope,
			out: Out,
			values: readonly unknown[],
			keys: readonly unknown[] | null,
			index: number,
			reused: Scope | null,
		): void | Promise<void> => {
			const length = values.length;
			for (let i = index; i < length; i++) {
				step(run, span);
				const inner = reused ?? childScope(scope);
				inner[valueName] = values[i] ?? null;
				if (keyName !== null) inner[keyName] = keys ? (keys[i] ?? null) : i;
				if (usesLoop) {
					// A literal, so every `loop` hash shares one shape. Templates only read its own properties.
					inner.loop = {
						index: i + 1,
						index0: i,
						revIndex: length - i,
						revIndex0: length - i - 1,
						first: i === 0,
						last: i === length - 1,
						length,
					};
				}
				const result = body(run, inner, out);
				if (result !== undefined) {
					return result.then(() =>
						iterate(run, scope, out, values, keys, i + 1, reused),
					);
				}
			}
		};

		const start = (run: Run, scope: Scope, out: Out, value: unknown) => {
			const { values, keys } = loopItems(run, span, value, keyName !== null);
			if (values.length === 0) return alternate?.(run, scope, out);
			const reused = shared ? childScope(scope) : null;
			return iterate(run, scope, out, values, keys, 0, reused);
		};

		const ev = iterable.ev;
		return (run, scope, out) => {
			step(run, span);
			const value = ev(run, scope);
			if (isPromise(value)) {
				return value.then((resolved) =>
					start(run, scope, out, unhold(resolved)),
				);
			}
			return start(run, scope, out, value);
		};
	}

	#set(name: string, value: Compiled, span: Span): Stmt {
		const ev = value.ev;
		return (run, scope) => {
			step(run, span);
			const result = ev(run, scope);
			if (isPromise(result)) {
				return result.then((resolved) => {
					assign(run, scope, name, unhold(resolved), span);
				});
			}
			assign(run, scope, name, result, span);
		};
	}

	#setBlock(node: Extract<Statement, { type: "SetBlock" }>): Stmt {
		const body = this.#body(node.body);
		const strategy = this.#strategy || "html";
		const { name, span } = node;
		return (run, scope) => {
			step(run, span);
			const out = emptyOut();
			const result = body(run, scope, out);
			const finish = () =>
				assign(run, scope, name, new Markup(out.s, strategy), span);
			if (result !== undefined) return result.then(finish);
			finish();
		};
	}

	#props(node: Extract<Statement, { type: "Props" }>): Stmt {
		const types = this.#env.types;
		const props = node.props.map((prop) => {
			if (prop.type) this.#checkTypeNames(prop.type, prop.span);
			const compiled = prop.default ? this.#expr(prop.default) : null;
			if (
				prop.type &&
				prop.default &&
				compiled?.constant &&
				!matchesType(compiled.constant.value, prop.type, types)
			) {
				this.#error(
					"prop-type",
					`The default for "${prop.name}" is ${describeValue(compiled.constant.value, prop.type)}, which is not ${describeType(prop.type)}`,
					prop.default.span,
				);
			}
			return { name: prop.name, type: prop.type, default: compiled };
		});
		const declared = new Set(props.map((prop) => prop.name));
		const strict = this.#env.strict;
		const span = node.span;
		const templateName = this.#template.name;
		// Types are only checked in strict mode. Lenient mode passes values through.
		const typed = strict
			? props.flatMap(({ name, type }) => (type ? [{ name, type }] : []))
			: [];

		const checkTypes = (run: Run, scope: Scope): void => {
			for (const { name, type } of typed) {
				const value = scope[name];
				if (!matchesType(value, type, types)) {
					throw fail(
						run,
						span,
						"prop-type",
						`Prop "${name}" of ${templateName} must be ${describeType(type)}, but got ${describeValue(value, type)}`,
					);
				}
			}
		};

		const fill = (
			run: Run,
			scope: Scope,
			index: number,
		): void | Promise<void> => {
			for (let i = index; i < props.length; i++) {
				const prop = props[i] as (typeof props)[number];
				const has = Object.hasOwn(scope, prop.name);
				const current = has ? scope[prop.name] : undefined;
				if (current !== undefined && current !== null) continue;
				if (prop.default) {
					const value = prop.default.ev(run, scope);
					if (isPromise(value)) {
						return value.then((resolved) => {
							scope[prop.name] = unhold(resolved) ?? null;
							return fill(run, scope, i + 1);
						});
					}
					scope[prop.name] = value ?? null;
				} else if (!has) {
					if (strict) {
						throw fail(
							run,
							span,
							"missing-prop",
							`Required prop "${prop.name}" was not passed to ${templateName}`,
						);
					}
					scope[prop.name] = null;
				}
			}
		};

		const rest = node.rest;
		// The variables passed but not declared, in the order they were passed. A layout's run has no `passed`.
		const collect = (run: Run, scope: Scope): Record<string, unknown> => {
			const extra: Record<string, unknown> = {};
			for (const key of run.passed ?? []) {
				if (!declared.has(key) && key !== "slots") extra[key] = scope[key];
			}
			return extra;
		};

		const apply: Stmt = (run, scope) => {
			if (rest !== null) scope[rest] = collect(run, scope);
			else if (strict && run.passed) {
				for (const key of run.passed) {
					if (!declared.has(key) && key !== "slots") {
						throw fail(
							run,
							span,
							"unknown-prop",
							`"${key}" was passed to ${templateName}, which does not declare it in "props"`,
							suggest(key, declared),
						);
					}
				}
			}
			if (typed.length === 0) return fill(run, scope, 0);
			return after(fill(run, scope, 0), () => checkTypes(run, scope));
		};
		// `props` is only valid at the top level, once, so this is the template's own.
		this.#template.props = apply;
		return apply;
	}

	/** Reports host type names, such as `Post`, that the environment has no check for. */
	#checkTypeNames(type: readonly PropType[], span: Span): void {
		for (const member of type) {
			if (typeof member === "string" || "literal" in member) continue;
			if ("list" in member) this.#checkTypeNames(member.list, span);
			else if ("shape" in member) {
				for (const key of member.shape) this.#checkTypeNames(key.type, span);
			} else if (!this.#env.types.has(member.named)) {
				this.#error(
					"unknown-type",
					`Unknown type "${member.named}". Register it with the "types" option`,
					span,
				);
			}
		}
	}

	#defineBlock(node: Extract<Statement, { type: "Block" }>): void {
		const saved = this.#blockName;
		this.#blockName = node.name;
		const def: BlockDef = {
			body: this.#body(node.body),
			strategy: this.#strategy,
			sets: setsVariables(node.body),
		};
		this.#blockName = saved;
		this.#template.blocks.set(node.name, def);
	}

	#blockStatement(node: Extract<Statement, { type: "Block" }>): Stmt {
		this.#defineBlock(node);
		const { name, span, indent } = node;
		return (run, scope, out) => {
			const entry = run.blocks.get(name)?.[0];
			if (!entry) return;
			const render = () =>
				entry.def.body(entry.run, blockScope(entry.def, scope), out);
			// A block defined in another template records where it was placed.
			if (indent === "") {
				return entry.run === run ? render() : withCaller(run, span, render);
			}
			const saved = out.indent;
			const inline = out.inline;
			startPlace(out, indent);
			return endPlace(
				out,
				saved,
				inline,
				entry.run === run ? render() : withCaller(run, span, render),
			);
		};
	}

	#include(node: Extract<Statement, { type: "Include" }>): Stmt {
		const { ignoreMissing, span, indent } = node;
		return this.#embedding(
			node.template,
			node.with,
			span,
			(run, out, name, variables) => {
				if (indent === "") {
					return embed(run, out, span, name, variables, null, ignoreMissing);
				}
				const saved = out.indent;
				const inline = out.inline;
				startPlace(out, indent);
				return endPlace(
					out,
					saved,
					inline,
					embed(run, out, span, name, variables, null, ignoreMissing),
				);
			},
		);
	}

	#component(node: Extract<Statement, { type: "Component" }>): Stmt {
		const { span, indent } = node;
		const setsIn = (body: Statement[]) =>
			containsNode(
				body,
				(record) => record.type === "Set" || record.type === "SetBlock",
			);
		const fills = node.fills.map((fill) => ({
			name: fill.name,
			body: this.#body(fill.body),
			sets: setsIn(fill.body),
		}));
		const hasDefault = node.body.some((statement) => !isBlank(statement));
		if (hasDefault) {
			if (fills.some((fill) => fill.name === DEFAULT_SLOT)) {
				this.#error(
					"duplicate-fill",
					'The default slot is filled both by "fill" and by content outside it',
					span,
				);
			}
			fills.push({
				name: DEFAULT_SLOT,
				body: this.#body(node.body),
				sets: setsIn(node.body),
			});
		}
		return this.#embedding(
			node.template,
			node.with,
			span,
			(run, out, name, variables, callerScope) => {
				const slots = new Map<string, SlotFill>();
				for (const fill of fills) {
					slots.set(fill.name, {
						body: fill.body,
						run,
						scope: callerScope,
						sets: fill.sets,
					});
				}
				if (indent === "") {
					return embed(run, out, span, name, variables, slots, false);
				}
				const saved = out.indent;
				const inline = out.inline;
				startPlace(out, indent);
				return endPlace(
					out,
					saved,
					inline,
					embed(run, out, span, name, variables, slots, false),
				);
			},
		);
	}

	/**
	 * `island`: renders its template in place, like a component without content, unless the render defers or streams
	 * islands. Then it writes a `<kiln-island>` element around the fallback, standing on lines of its own where the tags
	 * do. A deferred island is recorded in the manifest, and a streamed one starts rendering on its own.
	 */
	#island(node: Extract<Statement, { type: "Island" }>): Stmt {
		const { span, indent, closing } = node;
		const fallback = this.#body(node.body);
		const element = (
			run: Run,
			out: Out,
			scope: Scope,
			islands: IslandMode,
			attribute: string,
		): void | Promise<void> => {
			const state = run.state;
			let opening = `<kiln-island ${attribute}>`;
			if (islands.script && !state.islandScript) {
				opening = ISLAND_SCRIPT + opening;
				// A capture may never be output, so an island in one brings its own script.
				if (out === state.root) state.islandScript = true;
			}
			const lead = (at: string) => (out.inline ? "" : out.indent) + at;
			write(
				run,
				out,
				indent === undefined
					? opening
					: `${lead(indent)}${opening}${closing?.indent === null ? "" : "\n"}`,
				span,
			);
			return after(fallback(run, childScope(scope), out), () => {
				if (!closing) return write(run, out, ISLAND_CLOSING, span);
				const start = closing.indent === null ? "" : lead(closing.indent);
				const end = closing.newline ? "\n" : "";
				return write(run, out, `${start}${ISLAND_CLOSING}${end}`, span);
			});
		};
		const render = (
			run: Run,
			out: Out,
			scope: Scope,
			islands: IslandMode,
			template: CompiledTemplate,
			props: Record<string, JsonValue>,
		): void | Promise<void> => {
			if (islands.mode === "defer") {
				const id = recordIsland(run, span, islands, template.name, props);
				return element(
					run,
					out,
					scope,
					islands,
					`src="${escapeHtml(islands.url + id)}"`,
				);
			}
			const state = run.state;
			const streamed = (state.streamed ??= []);
			const n = streamed.length + 1;
			const html = streamIsland(run, span, template, props, n);
			silence(html);
			streamed.push(html);
			return element(run, out, scope, islands, `stream="${n}"`);
		};
		return this.#embedding(
			node.template,
			node.with,
			span,
			(run, out, name, variables, scope) => {
				const props = islandProps(run, span, variables);
				const state = run.state;
				const islands = state.islands;
				// Only `renderStream` streams, and only output that is sure to be sent once.
				const away =
					islands !== null &&
					(islands.mode === "defer" ||
						(state.stream !== null &&
							out === state.root &&
							state.caching === 0));
				if (away) {
					return after(loadTemplate(run, name, span), (template) =>
						template
							? render(run, out, scope, islands, template, props)
							: undefined,
					);
				}
				if (indent === "") {
					return embed(run, out, span, name, props, null, false);
				}
				const saved = out.indent;
				const inline = out.inline;
				startPlace(out, indent);
				return endPlace(
					out,
					saved,
					inline,
					embed(run, out, span, name, props, null, false),
				);
			},
		);
	}

	/**
	 * Evaluates an include's or component's template name and `with` value, then renders it with `render`. Both are
	 * evaluated before either is waited for.
	 */
	#embedding(
		templateNode: Expression,
		withNode: Expression | null,
		span: Span,
		render: (
			run: Run,
			out: Out,
			name: unknown,
			variables: unknown,
			scope: Scope,
		) => void | Promise<void>,
	): Stmt {
		const template = this.#expr(templateNode);
		const withValue = withNode ? this.#expr(withNode) : constant(null);
		if (!template.async && !withValue.async) {
			const name = template.ev;
			const variables = withValue.ev;
			return (run, scope, out) => {
				step(run, span);
				return render(run, out, name(run, scope), variables(run, scope), scope);
			};
		}
		const values = evalAll([template, withValue]);
		return (run, scope, out) => {
			step(run, span);
			return after(values(run, scope), ([name, variables]) =>
				render(run, out, name, variables, scope),
			);
		};
	}

	#slot(node: Extract<Statement, { type: "Slot" }>): Stmt {
		const fallback = this.#body(node.body);
		const { name, span, indent } = node;
		const render = (run: Run, scope: Scope, out: Out) => {
			const fill = run.slots?.get(name);
			if (!fill) return fallback(run, childScope(scope), out);
			try {
				const result = fill.body(fill.run, fillScope(fill), out);
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
		if (indent === "") return render;
		return (run, scope, out) => {
			const saved = out.indent;
			const inline = out.inline;
			startPlace(out, indent);
			return endPlace(out, saved, inline, render(run, scope, out));
		};
	}

	#with(node: Extract<Statement, { type: "With" }>): Stmt {
		const value = this.#expr(node.value);
		const body = this.#body(node.body);
		const span = node.span;
		const enter = (run: Run, scope: Scope, out: Out, variables: unknown) => {
			const inner = childScope(scope);
			if (isPlainObject(variables)) {
				for (const key of hashKeys(variables))
					inner[key] = variables[key] ?? null;
			} else if (variables instanceof Map) {
				for (const [key, item] of variables) {
					if (typeof key === "string") inner[key] = item ?? null;
				}
			} else if (variables !== null && variables !== undefined) {
				throw fail(
					run,
					span,
					"type-error",
					`"with" needs a hash, but got a ${typeName(variables)}`,
				);
			}
			return body(run, inner, out);
		};
		return (run, scope, out) => {
			step(run, span);
			return after(value.ev(run, scope), (variables) =>
				enter(run, scope, out, variables),
			);
		};
	}

	/**
	 * `cache`: outputs the copy the environment's store saved under the key, or renders the body, outputs it and saves
	 * it. The key and `for` are checked even without a store, so mistakes show up before a store is added.
	 */
	#cache(node: Extract<Statement, { type: "Cache" }>): Stmt {
		const key = this.#expr(node.key);
		const seconds = node.seconds ? this.#expr(node.seconds) : null;
		const body = this.#body(node.body);
		const span = node.span;
		const templateName = this.#template.name;
		// Variables the body sets. Each gets a copy in the body's scope, so setting one never changes an outer variable,
		// and a saved copy leaves the same variables behind as a fresh render. Globals stay outside, so setting one fails.
		const sets = new Set<string>();
		this.#walkStatements(node.body, (statement) => {
			if (statement.type === "Set" || statement.type === "SetBlock") {
				sets.add(statement.name);
			}
		});
		const bodyScope = (run: Run, scope: Scope): Scope => {
			const inner = childScope(scope);
			for (const name of sets) {
				const owner = ownerOf(scope, name);
				if (owner !== null && owner !== run.state.globals) {
					inner[name] = owner[name];
				}
			}
			return inner;
		};

		const part = (run: Run, value: unknown) => {
			if (value === null || value === undefined) return null;
			if (
				typeof value === "string" ||
				typeof value === "number" ||
				typeof value === "boolean"
			) {
				return value;
			}
			if (value instanceof Date && !Number.isNaN(value.getTime())) {
				return value.toISOString();
			}
			if (value instanceof Markup) return value.value;
			throw fail(
				run,
				span,
				"type-error",
				`"cache" keys are made of strings, numbers, booleans, dates and null, but got a ${typeName(value)}`,
			);
		};
		// The template, locale and time zone are part of every key, since the output depends on them. So is how islands
		// render, when they are deferred. Streamed islands render in place inside the section.
		const fullKey = (run: Run, value: unknown) => {
			const parts = Array.isArray(value)
				? value.map((item) => part(run, item))
				: [part(run, value)];
			const { locale, timeZone, islands } = run.state;
			const key = `${templateName}|${locale}|${timeZone}|${JSON.stringify(parts)}`;
			return islands?.mode === "defer"
				? `${key}|islands|${JSON.stringify([islands.url, islands.script])}`
				: key;
		};
		const lifetime = (run: Run, value: unknown) => {
			if (value === null || value === undefined) return null;
			if (typeof value !== "number" || !(value > 0) || value === Infinity) {
				throw fail(
					run,
					span,
					"invalid-argument",
					`"cache" needs a number of seconds above 0 after "for", but got ${typeof value === "number" ? value : `a ${typeName(value)}`}`,
				);
			}
			return value;
		};

		const render = (
			run: Run,
			scope: Scope,
			out: Out,
			keyValue: unknown,
			secondsValue: unknown,
		): void | Promise<void> => {
			const name = fullKey(run, keyValue);
			const time = lifetime(run, secondsValue);
			const state = run.state;
			const store = state.env.cache;
			// The body writes straight to `out`, so its indentation is the same as without the cache.
			const fresh = (): void | Promise<void> => {
				state.caching++;
				const result = body(run, bodyScope(run, scope), out);
				return after(result, () => {
					state.caching--;
				});
			};
			if (!store) return fresh();
			const found = locating(
				run,
				span,
				() => store.get({ key: name }),
				"The cache store",
			);
			return after(found, (value) => {
				const saved = typeof value === "string" ? unpackSaved(value) : null;
				if (saved) {
					const islands = state.islands;
					if (islands?.mode === "defer" && saved.islands.length > 0) {
						// The copy holds the island script only if it was the first in its render to need it.
						if (saved.islandScript) {
							if (out === state.root) state.islandScript = true;
						} else if (islands.script && !state.islandScript) {
							write(run, out, ISLAND_SCRIPT, span);
							if (out === state.root) state.islandScript = true;
						}
						for (const island of saved.islands) {
							recordIsland(run, span, islands, island.template, island.props);
						}
					}
					write(run, out, saved.html, span);
					for (const addition of saved.additions) {
						recordAddition(run, span, addition);
					}
					return;
				}
				const start = out.s.length;
				const from = state.additions?.length ?? 0;
				const deferredFrom = state.deferred?.length ?? 0;
				const hadScript = state.islandScript;
				return after(fresh(), () => {
					const manifest =
						state.islands?.mode === "defer" ? state.islands.manifest : null;
					const value = packSaved({
						html: out.s.slice(start),
						additions: state.additions?.slice(from) ?? [],
						islands: manifest
							? (state.deferred?.slice(deferredFrom) ?? []).flatMap(
									(id) => manifest[id] ?? [],
								)
							: [],
						islandScript: !hadScript && state.islandScript,
					});
					return locating(
						run,
						span,
						() => store.set({ key: name, value, seconds: time }),
						"The cache store",
					);
				});
			});
		};

		return (run, scope, out) => {
			step(run, span);
			const keyValue = key.ev(run, scope);
			let secondsValue: unknown = null;
			try {
				if (seconds) secondsValue = seconds.ev(run, scope);
			} catch (error) {
				silence(keyValue);
				throw error;
			}
			if (isPromise(keyValue) || isPromise(secondsValue)) {
				return all([keyValue, secondsValue]).then(([k, t]) =>
					render(run, scope, out, k, t),
				);
			}
			return render(run, scope, out, keyValue, secondsValue);
		};
	}

	/**
	 * `outlet`: marks where its content goes in the render's output. The content is put in place when the render ends,
	 * so the outlet must write to that output, not to a capture or a cached section.
	 */
	#outlet(node: Extract<Statement, { type: "Outlet" }>): Stmt {
		const { name, span, indent } = node;
		return (run, _scope, out) => {
			step(run, span);
			const state = run.state;
			if (out !== state.root || state.caching > 0) {
				throw fail(
					run,
					span,
					"misplaced-outlet",
					`Outlet "${name}" can't be inside "cache", "set", "apply" or a macro`,
				);
			}
			state.outlets ??= new Map();
			if (state.outlets.has(name)) {
				throw fail(
					run,
					span,
					"duplicate-outlet",
					`Outlet "${name}" is used more than once in this render`,
				);
			}
			// Without `indent` the tag shares its line, as `startPlace` treats it.
			state.outlets.set(name, {
				offset: out.s.length,
				indent: indent === undefined ? out.indent : out.indent + indent,
				inline: indent === undefined,
				content: null,
			});
		};
	}

	/**
	 * `flush`: closes the outlets reached so far, so a streamed render can send its output up to here. It closes them
	 * in `render` too, so a template behaves the same either way.
	 */
	#flush(node: Extract<Statement, { type: "Flush" }>): Stmt {
		const { span } = node;
		return (run, _scope, out) => {
			step(run, span);
			const state = run.state;
			if (out !== state.root || state.caching > 0) {
				throw fail(
					run,
					span,
					"misplaced-flush",
					`"flush" can't be inside "cache", "set", "apply", "add to" or a macro`,
				);
			}
			closeOutlets(state);
			state.stream?.flush();
		};
	}

	/**
	 * `add to`: renders its content and records it for the outlet. The content takes the outlet's indentation when the
	 * outlet has been reached. A `once` tag that already added doesn't render again, but is still recorded, so a cached
	 * section saves it.
	 */
	#add(node: Extract<Statement, { type: "Add" }>): Stmt {
		const body = this.#body(node.body);
		const { outlet, span } = node;
		const once = node.once ? `${this.#template.name}:${span.start}` : null;
		return (run, scope) => {
			step(run, span);
			const state = run.state;
			const first = once === null ? undefined : state.once?.get(once);
			if (first !== undefined) {
				recordAddition(run, span, { outlet, html: first, once });
				return;
			}
			const capture: Out = {
				s: "",
				indent: state.outlets?.get(outlet)?.indent ?? "",
				inline: false,
			};
			return after(body(run, childScope(scope), capture), () =>
				recordAddition(run, span, { outlet, html: capture.s, once }),
			);
		};
	}

	#apply(node: Extract<Statement, { type: "Apply" }>): Stmt {
		const body = this.#body(node.body);
		const strategy = this.#strategy || "html";
		const input: Compiled = {
			ev: (_run, scope) => scope[CAPTURED],
			async: false,
		};
		let chain = input;
		for (const filter of node.filters) {
			chain = this.#filterCall(filter, chain);
		}
		const result = chain.ev;
		const span = node.span;
		const emit = (run: Run, out: Out, value: unknown) => {
			let text: string;
			try {
				text = toStr(value);
			} catch (error) {
				throw locate(run, span, error);
			}
			write(run, out, text, span);
		};

		return (run, scope, out) => {
			step(run, span);
			const captured = emptyOut();
			return after(body(run, scope, captured), () => {
				const inner = childScope(scope);
				inner[CAPTURED] = new Markup(captured.s, strategy);
				return after(result(run, inner), (value) => emit(run, out, value));
			});
		};
	}

	// Expressions

	#expr(node: Expression, guard = false): Compiled {
		// Long operator or filter chains nest deeply without parentheses, so guard compile and render recursion here.
		if (++this.#expressionDepth > MAX_EXPRESSION_DEPTH) {
			this.#expressionDepth = 0;
			this.#error(
				"too-deep",
				`Expression is nested more than ${MAX_EXPRESSION_DEPTH} levels deep`,
				node.span,
			);
			return this.#broken();
		}
		try {
			return this.#compileExpression(node, guard);
		} finally {
			if (this.#expressionDepth > 0) this.#expressionDepth--;
		}
	}

	#compileExpression(node: Expression, guard: boolean): Compiled {
		switch (node.type) {
			case "Literal":
				return constant(node.value);
			case "Invalid":
				return this.#broken();
			case "Name":
				return this.#name(node.name, node.span, guard);
			case "Interpolation":
				return this.#interpolation(node.parts, node.span);
			case "Array":
				return this.#array(node);
			case "Hash":
				return this.#hash(node);
			case "Unary":
				return this.#unary(node);
			case "Binary":
				return this.#binary(node);
			case "Conditional":
				return this.#conditional(node);
			case "Member":
				return this.#member(node, guard);
			case "OptionalChain": {
				// `?.` guards its whole chain, so missing variables and properties in it become null.
				const inner = this.#expr(node.expression, true);
				return map1(inner, (value) =>
					value === SHORT || value === MISSING
						? guard
							? MISSING
							: null
						: value,
				);
			}
			case "Call":
				return this.#call(node);
			case "Filter":
				return this.#filter(node);
			case "Test":
				return this.#test(node);
			case "Arrow":
				return this.#arrow(node);
		}
	}

	#name(name: string, span: Span, guard: boolean): Compiled {
		if (guard) {
			return {
				ev: (run, scope) => {
					const value = lookup(scope, name);
					return value === undefined
						? MISSING
						: checkValue(run, span, value, name);
				},
				async: false,
			};
		}
		if (this.#env.strict) {
			return {
				ev: (run, scope) => {
					const value = lookup(scope, name);
					if (value === undefined) {
						throw undefinedVariable(run, span, name, scope);
					}
					return typeof value === "function"
						? checkValue(run, span, value, name)
						: value;
				},
				async: false,
				variable: name,
			};
		}
		return {
			ev: (run, scope) => {
				const value = lookup(scope, name);
				if (value === undefined) return null;
				return typeof value === "function"
					? checkValue(run, span, value, name)
					: value;
			},
			async: false,
			variable: name,
		};
	}

	#interpolation(parts: Expression[], span: Span): Compiled {
		const compiled = parts.map((part) => this.#expr(part));
		const values = evalAll(compiled);
		const join = (run: Run, list: unknown[]) => {
			let result = "";
			for (const value of list) {
				if (typeof value === "string") result += value;
				else {
					try {
						result += toStr(value);
					} catch (error) {
						throw locate(run, span, error);
					}
				}
			}
			return locating(run, span, () => checkLength(run, result));
		};
		const async = compiled.some((part) => part.async);
		return {
			ev: async
				? (run, scope) => after(values(run, scope), (list) => join(run, list))
				: (run, scope) => join(run, values(run, scope) as unknown[]),
			async,
		};
	}

	#array(node: Extract<Expression, { type: "Array" }>): Compiled {
		const spreads = node.elements.map((element) => element.type === "Spread");
		const compiled = node.elements.map((element) =>
			element.type === "Spread"
				? this.#expr(element.value)
				: this.#expr(element),
		);
		const values = evalAll(compiled);
		const hasSpread = spreads.includes(true);
		const span = node.span;
		const build = (run: Run, list: unknown[]): unknown[] => {
			if (!hasSpread) return list;
			const result: unknown[] = [];
			for (let i = 0; i < list.length; i++) {
				if (spreads[i]) {
					for (const item of spreadItems(run, span, list[i])) result.push(item);
				} else result.push(list[i]);
			}
			return result;
		};
		const async = compiled.some((item) => item.async);
		return {
			ev: async
				? (run, scope) => after(values(run, scope), (list) => build(run, list))
				: (run, scope) => build(run, values(run, scope) as unknown[]),
			async,
		};
	}

	#hash(node: Extract<Expression, { type: "Hash" }>): Compiled {
		type Entry = { spread: true } | { spread: false; key: string | null };
		const entries: Entry[] = [];
		const compiled: Compiled[] = [];
		for (const entry of node.entries) {
			if (entry.type === "Spread") {
				entries.push({ spread: true });
				compiled.push(this.#expr(entry.value));
				continue;
			}
			const key = entry.key;
			if (key.type === "Literal") {
				if (key.value === "__proto__") this.#protoKey(key.span);
				entries.push({ spread: false, key: String(key.value) });
			} else {
				entries.push({ spread: false, key: null });
				compiled.push(this.#expr(key));
			}
			compiled.push(this.#expr(entry.value));
		}
		const values = evalAll(compiled);
		const span = node.span;

		const build = (run: Run, list: unknown[]) => {
			const result: Record<string, unknown> = {};
			let index = 0;
			for (const entry of entries) {
				if (entry.spread) {
					copyHash(run, span, result, list[index++]);
					continue;
				}
				let key = entry.key;
				if (key === null) {
					const computed = list[index++];
					if (typeof computed !== "string" && typeof computed !== "number") {
						throw fail(
							run,
							span,
							"type-error",
							`Hash keys must be strings or numbers, but got a ${typeName(computed)}`,
						);
					}
					key = String(computed);
					if (key === "__proto__") {
						throw fail(run, span, "invalid-key", PROTO_KEY_MESSAGE);
					}
				}
				setOwn(result, key, list[index++]);
			}
			return result;
		};
		const async = compiled.some((item) => item.async);
		return {
			ev: async
				? (run, scope) => after(values(run, scope), (list) => build(run, list))
				: (run, scope) => build(run, values(run, scope) as unknown[]),
			async,
		};
	}

	#unary(node: Extract<Expression, { type: "Unary" }>): Compiled {
		const operand = this.#expr(node.operand);
		const span = node.span;
		switch (node.operator) {
			case "not":
				return map1(operand, (value) => !truthy(value));
			case "-":
				return map1(operand, (value, run) =>
					typeof value === "number"
						? -value
						: -locating(run, span, () => toNumber(value, "-")),
				);
			case "+":
				return map1(operand, (value, run) =>
					typeof value === "number"
						? value
						: locating(run, span, () => toNumber(value, "+")),
				);
		}
	}

	#binary(node: Extract<Expression, { type: "Binary" }>): Compiled {
		const { operator, span } = node;

		if (
			operator === "and" ||
			operator === "or" ||
			operator === "??" ||
			operator === "?:"
		) {
			const left = this.#expr(node.left, operator === "??");
			const right = this.#expr(node.right);
			const decide = (value: unknown, run: Run, scope: Scope): unknown => {
				switch (operator) {
					case "and":
						return truthy(value)
							? after(right.ev(run, scope), (resolved) => truthy(resolved))
							: false;
					case "or":
						return truthy(value)
							? true
							: after(right.ev(run, scope), (resolved) => truthy(resolved));
					case "??":
						return value === MISSING || value === null || value === undefined
							? right.ev(run, scope)
							: value;
					default:
						return truthy(value) ? value : right.ev(run, scope);
				}
			};
			return map1(left, decide, right.async);
		}

		const left = this.#expr(node.left);
		const right = this.#expr(node.right);

		if (operator === "..") {
			return map2(left, right, (a, b, run) =>
				locating(run, span, () => {
					const items = rangeOperator(a, b, run.state.maxSteps);
					consume(run, items.length);
					return items;
				}),
			);
		}

		const apply = operatorFunction(operator);
		const joins = operator === "~";
		return map2(left, right, (a, b, run) => {
			try {
				const result = apply(a, b);
				return joins ? checkLength(run, result as string) : result;
			} catch (error) {
				throw locate(run, span, error);
			}
		});
	}

	#conditional(node: Extract<Expression, { type: "Conditional" }>): Compiled {
		const test = this.#expr(node.test);
		const consequent = this.#expr(node.consequent);
		const alternate = node.alternate
			? this.#expr(node.alternate)
			: constant(null);
		const compiled = map1(
			test,
			(value, run, scope) =>
				truthy(value) ? consequent.ev(run, scope) : alternate.ev(run, scope),
			consequent.async || alternate.async,
		);
		if (!test.async && consequent.constant && alternate.constant) {
			compiled.choice = {
				test: test.ev,
				yes: consequent.constant.value,
				no: alternate.constant.value,
			};
		}
		return compiled;
	}

	#member(
		node: Extract<Expression, { type: "Member" }>,
		guard: boolean,
	): Compiled {
		const object = this.#expr(node.object, guard);
		const { optional, span } = node;
		const read = (run: Run, target: unknown, key: unknown): unknown =>
			readMember(run, span, target, key, optional, guard);

		const property = node.property;
		if (property.type !== "Literal") {
			// The key waits for the object, as a chain that stops at a `?.` leaves it unevaluated.
			const key = this.#expr(property);
			const keyEv = key.ev;
			const stops = chainStops(optional);
			return map1(
				object,
				key.async
					? (target, run, scope) =>
							stops(target)
								? SHORT
								: after(keyEv(run, scope), (name) => read(run, target, name))
					: (target, run, scope) =>
							stops(target) ? SHORT : read(run, target, keyEv(run, scope)),
				key.async,
			);
		}
		const key = property.value;
		const access: PathStep = {
			name: typeof key === "string" && !BLOCKED_NAMES.has(key) ? key : null,
			read: (run, target) => read(run, target, key),
			span,
		};
		if (object.async)
			return map1(object, (target, run) => access.read(run, target));
		// `a.b.c` reads every key in one closure, so a long path costs one call.
		const inner = object.path;
		return inner
			? pathRead(inner.root, [...inner.steps, access])
			: pathRead(object, [access]);
	}

	#arrow(node: Extract<Expression, { type: "Arrow" }>): Compiled {
		const body = this.#expr(node.body);
		const { params, span } = node;
		const ev = body.ev;
		return {
			ev: (run, scope) => {
				const call = (...args: unknown[]) => {
					step(run, span);
					const inner = childScope(scope);
					for (let i = 0; i < params.length; i++) {
						inner[params[i] as string] = args[i] ?? null;
					}
					return ev(run, inner);
				};
				// Your functions get the value itself, never a held one.
				const fn = (...args: unknown[]) => {
					const result = call(...args);
					return result instanceof Promise ? result.then(unhold) : result;
				};
				// Lets filters such as `sort` tell a key selector from a comparator.
				Object.defineProperty(call, "length", { value: params.length });
				Object.defineProperty(fn, "length", { value: params.length });
				templateFunctions.set(fn, call);
				return fn;
			},
			async: false,
			arrowAsync: body.async,
		};
	}

	/**
	 * Compiles call arguments. Named arguments become one trailing hash; spreads expand arrays.
	 *
	 * A `null` entry is a parameter the call skipped, passed as `undefined` so the parameter's default applies.
	 */
	#arguments(
		args: (Argument | null)[],
		/** Position of a built-in's options hash, which is built once when its keys and values are literals. */
		optionsAt = -1,
	): CompiledArguments {
		for (const arg of args) {
			if (arg?.type === "Named" && arg.name === "__proto__")
				this.#protoKey(arg.span);
		}
		const compiled = args.map((arg, index) => {
			if (!arg) return constant(undefined);
			const value = this.#expr(arg.value);
			return index === optionsAt ? (literalHash(arg.value) ?? value) : value;
		});
		return {
			evs: compiled.map((item) => item.ev),
			values: evalAll(compiled),
			shapes: args.map((arg) => ({
				kind: arg ? arg.type : "Positional",
				name: arg?.type === "Named" ? arg.name : "",
			})),
			async: compiled.some((item) => item.async),
			arrowAsync: compiled.some((item) => item.arrowAsync === true),
		};
	}

	#call(node: Extract<Expression, { type: "Call" }>): Compiled {
		const callee = node.callee;
		if (callee.type === "Name") {
			const name = callee.name;
			if (name === "parent") return this.#parentCall(node);
			if (name === "block") return this.#blockCall(node);

			const local = this.#template.macros.get(name);
			if (local) {
				const macros = this.#template.macros;
				return this.#macroCall(node, () => macros.get(name), `Macro "${name}"`);
			}
			const imported = this.#fromImports.get(name);
			if (imported) {
				return this.#macroCall(
					node,
					(run) => run.imports[imported.slot]?.macros.get(imported.name),
					`Macro "${imported.name}" from ${this.#template.imports[imported.slot]?.name}`,
				);
			}

			const entry = this.#env.functions.get(name);
			if (!entry) {
				this.#error(
					"unknown-function",
					`Unknown function "${name}"`,
					callee.span,
				);
				return this.#broken();
			}
			return this.#callable(
				entry,
				`Function "${name}"`,
				null,
				node.args,
				node.span,
			);
		}

		if (callee.type === "Member") {
			const object = callee.object;
			const property = callee.property;
			if (
				object.type === "Name" &&
				property.type === "Literal" &&
				typeof property.value === "string" &&
				this.#importAliases.has(object.name)
			) {
				const slot = this.#importAliases.get(object.name) as number;
				const macroName = property.value;
				return this.#macroCall(
					node,
					(run) => run.imports[slot]?.macros.get(macroName),
					`Macro "${macroName}" from ${this.#template.imports[slot]?.name}`,
				);
			}
			return this.#methodCall(node, callee);
		}

		this.#error("invalid-call", "This value cannot be called", node.span);
		return this.#broken();
	}

	#macroCall(
		node: Extract<Expression, { type: "Call" }>,
		resolve: (run: Run) => CompiledMacro | undefined,
		label: string,
	): Compiled {
		const positional: Compiled[] = [];
		const namedNames: string[] = [];
		const named: Compiled[] = [];
		for (const arg of node.args) {
			if (arg.type === "Named") {
				namedNames.push(arg.name);
				named.push(this.#expr(arg.value));
			} else if (arg.type === "Spread") {
				this.#error(
					"invalid-spread",
					"Spread arguments cannot be passed to macros",
					arg.span,
				);
			} else positional.push(this.#expr(arg.value));
		}
		const values = evalAll([...positional, ...named]);
		const count = positional.length;
		const span = node.span;

		const invoke = (run: Run, list: unknown[]) => {
			const macro = resolve(run);
			if (!macro) {
				throw fail(run, span, "unknown-macro", `${label} does not exist`);
			}
			let namedValues: Record<string, unknown> | null = null;
			if (namedNames.length > 0) {
				namedValues = {};
				for (let i = 0; i < namedNames.length; i++) {
					setOwn(namedValues, namedNames[i] as string, list[count + i]);
				}
			}
			return callMacro(run, span, macro, list.slice(0, count), namedValues);
		};

		return {
			ev: (run, scope) =>
				after(values(run, scope), (list) => invoke(run, list)),
			async: true,
		};
	}

	#methodCall(
		node: Extract<Expression, { type: "Call" }>,
		callee: Extract<Expression, { type: "Member" }>,
	): Compiled {
		const object = this.#expr(callee.object);
		const property = callee.property;
		const key =
			property.type === "Literal"
				? constant(property.value)
				: this.#expr(property);
		const args = this.#arguments(node.args);
		const span = node.span;
		const optional = callee.optional;
		const stops = chainStops(optional);

		const invoke = (
			run: Run,
			target: unknown,
			name: unknown,
			list: unknown[],
		) => {
			if (target === SHORT) return SHORT;
			if (target === null || target === undefined) {
				if (optional) return SHORT;
				throw fail(
					run,
					span,
					"null-access",
					`Cannot call ${valueLabel(name)} on null`,
				);
			}
			const method =
				typeof name === "string" ? getMethod(target, name) : undefined;
			if (!method) {
				throw fail(
					run,
					span,
					"method-not-exposed",
					`${valueLabel(name)} is not a method that ${typeName(target)} exposes`,
				);
			}
			const built = buildArguments(run, span, args.shapes, list);
			return locating(
				run,
				span,
				() => method.apply(target, built),
				`Method "${String(name)}"`,
			);
		};

		// The name and arguments wait for the object, as a chain that stops at a `?.` leaves them unevaluated.
		return {
			ev: (run, scope) =>
				after(object.ev(run, scope), (target) =>
					stops(target)
						? SHORT
						: after(key.ev(run, scope), (name) => {
								step(run, span);
								return after(args.values(run, scope), (list) =>
									invoke(run, target, name, list),
								);
							}),
				),
			async: true,
		};
	}

	/** Compiles a call to a built-in or host function, filter or test. `input` is the filtered or tested value. */
	#callable(
		entry: CallableEntry,
		label: string,
		input: Compiled | null,
		argNodes: Argument[],
		span: Span,
	): Compiled {
		const args =
			entry.kind === "builtin"
				? this.#arguments(
						placeArguments(entry, argNodes, label, (code, message, at) =>
							this.#error(code, message, at),
						),
						entry.options ? (entry.params?.length ?? 0) : -1,
					)
				: this.#arguments(argNodes);
		const all = input ? evalAll([input]) : null;
		const inputAsync = input?.async ?? false;
		const shapes = args.shapes;
		const valuesOf = args.values;
		// Only positional arguments: the evaluated list is already what the callable receives.
		const plain =
			shapes.length <= MAX_ARGUMENTS &&
			shapes.every((shape) => shape.kind === "Positional");

		const invoke = (
			run: Run,
			first: unknown,
			hasInput: boolean,
			list: unknown[],
		) => {
			const built = plain ? list : buildArguments(run, span, shapes, list);
			if (entry.kind === "builtin") {
				const call = entry.call;
				return hasInput
					? locating(run, span, () => call(run, first, ...built))
					: locating(run, span, () => call(run, ...built));
			}
			if (hasInput) built.unshift(first);
			const call = entry.call;
			if (entry.render) {
				return locating(run, span, () => call(run.info, ...built), label);
			}
			return locating(run, span, () => call(...built), label);
		};

		const resultAsync = entry.kind === "host" || args.arrowAsync;
		const async = resultAsync || args.async || inputAsync;

		if (entry.kind === "builtin" && plain && !async) {
			const evs = input ? [input.ev, ...args.evs] : args.evs;
			const direct = directCall(entry.call, evs, span);
			if (direct) return { ev: direct, async: false };
		}

		if (!input) {
			if (!args.async) {
				return {
					ev: (run, scope) => {
						step(run, span);
						return invoke(
							run,
							undefined,
							false,
							valuesOf(run, scope) as unknown[],
						);
					},
					async,
				};
			}
			return {
				ev: (run, scope) => {
					step(run, span);
					return after(valuesOf(run, scope), (list) =>
						invoke(run, undefined, false, list),
					);
				},
				async,
			};
		}

		const inputEv = input.ev;
		if (!args.async && !inputAsync) {
			return {
				ev: (run, scope) => {
					step(run, span);
					return invoke(
						run,
						inputEv(run, scope),
						true,
						valuesOf(run, scope) as unknown[],
					);
				},
				async,
			};
		}
		return {
			ev: (run, scope) => {
				step(run, span);
				return after((all as NonNullable<typeof all>)(run, scope), ([value]) =>
					after(valuesOf(run, scope), (list) => invoke(run, value, true, list)),
				);
			},
			async,
		};
	}

	#filter(node: Extract<Expression, { type: "Filter" }>): Compiled {
		const input = this.#expr(node.input, node.name === "default");
		return this.#filterCall(node, input);
	}

	#filterCall(
		node: FilterCall | Extract<Expression, { type: "Filter" }>,
		input: Compiled,
	): Compiled {
		const { name, args, span } = node;
		const strategy = this.#strategy || "html";

		if (name === "default") {
			const fallback = args[0] ? this.#expr(args[0].value) : constant("");
			return map1(
				input,
				(value, run, scope) =>
					value === MISSING || isEmpty(value) ? fallback.ev(run, scope) : value,
				fallback.async,
			);
		}
		if (name === "raw") {
			return map1(input, (value, run) => {
				if (value instanceof Markup) {
					return value.strategy === strategy
						? value
						: new Markup(value.value, strategy);
				}
				return new Markup(
					locating(run, span, () => toStr(value)),
					strategy,
				);
			});
		}
		if (name === "escape") {
			const strategyArg = args[0]
				? this.#expr(args[0].value)
				: constant("html");
			const known = strategyArg.constant;
			if (known && !ESCAPE_STRATEGIES.includes(known.value as EscapeStrategy)) {
				this.#error(
					"unknown-strategy",
					`Unknown escaping strategy "${String(known.value)}"`,
					span,
				);
			}
			return map2(input, strategyArg, (value, target, run) => {
				if (!ESCAPE_STRATEGIES.includes(target as EscapeStrategy)) {
					throw fail(
						run,
						span,
						"unknown-strategy",
						`Unknown escaping strategy ${valueLabel(target)}`,
					);
				}
				const chosen = target as EscapeStrategy;
				if (value instanceof Markup && value.strategy === chosen) return value;
				const text = locating(run, span, () => toStr(value));
				return new Markup(escapeWith(text, chosen), chosen);
			});
		}

		const entry = this.#env.filters.get(name);
		if (!entry) {
			this.#error(
				"unknown-filter",
				`Unknown filter "${name}"`,
				"nameSpan" in node ? node.nameSpan : span,
			);
			return this.#broken();
		}
		return this.#callable(entry, `Filter "${name}"`, input, args, span);
	}

	#test(node: Extract<Expression, { type: "Test" }>): Compiled {
		const { name, negated, span } = node;

		if (name === "defined") {
			const input = node.input;
			if (
				input.type === "Call" &&
				input.callee.type === "Name" &&
				input.callee.name === "block"
			) {
				const blockName = input.args[0]
					? this.#expr(input.args[0].value)
					: constant(null);
				return map1(blockName, (value, run) => {
					const exists = typeof value === "string" && run.blocks.has(value);
					return negated ? !exists : exists;
				});
			}
			return map1(this.#expr(input, true), (value) =>
				negated ? value === MISSING : value !== MISSING,
			);
		}

		const entry = this.#env.tests.get(name);
		if (!entry) {
			this.#error("unknown-test", `Unknown test "${name}"`, node.nameSpan);
			return this.#broken();
		}
		const compiled = this.#callable(
			entry,
			`Test "${name}"`,
			this.#expr(node.input),
			node.args,
			span,
		);
		return map1(compiled, (value) =>
			negated ? !truthy(value) : truthy(value),
		);
	}

	#parentCall(node: Extract<Expression, { type: "Call" }>): Compiled {
		const blockName = this.#blockName;
		if (blockName === null) {
			this.#error(
				"parent-outside-block",
				'"parent()" can only be used inside a block',
				node.span,
			);
			return this.#broken();
		}
		const span = node.span;
		return {
			ev: (run, scope) => {
				const list = run.blocks.get(blockName);
				const index = list ? list.findIndex((entry) => entry.run === run) : -1;
				const next = list?.[index + 1];
				if (!next) {
					throw fail(
						run,
						span,
						"missing-parent-block",
						`Block "${blockName}" has no parent block`,
					);
				}
				return renderBlockEntry(run, span, next, scope);
			},
			async: true,
		};
	}

	#blockCall(node: Extract<Expression, { type: "Call" }>): Compiled {
		const name = node.args[0] ? this.#expr(node.args[0].value) : constant(null);
		const span = node.span;
		return {
			ev: (run, scope) =>
				after(name.ev(run, scope), (value) => {
					const entry =
						typeof value === "string" ? run.blocks.get(value)?.[0] : undefined;
					if (!entry) {
						throw fail(
							run,
							span,
							"unknown-block",
							`Block ${valueLabel(value)} does not exist`,
						);
					}
					return renderBlockEntry(run, span, entry, scope);
				}),
			async: true,
		};
	}
}

/** Renders a block into markup, for `parent()` and `block()`. */
const renderBlockEntry = (
	run: Run,
	span: Span,
	entry: { def: BlockDef; run: Run },
	scope: Scope,
): Markup | Promise<Markup> => {
	const state = run.state;
	// `block()` can call itself, so count its nesting against `maxDepth`.
	if (++state.blockDepth > state.maxDepth) {
		throw fail(
			run,
			span,
			"limit-depth",
			`Render stopped after nesting ${state.maxDepth} blocks deep`,
		);
	}
	const out = emptyOut();
	const done = () => {
		state.blockDepth--;
		return new Markup(out.s, entry.def.strategy || "html");
	};
	const result = withCaller(run, span, () =>
		entry.def.body(entry.run, blockScope(entry.def, scope), out),
	);
	if (result instanceof Promise) {
		return result.then(done, (error: unknown) => {
			state.blockDepth--;
			throw error;
		});
	}
	return done();
};

/**
 * Reads one property the way templates may, for `a.b` and `a[b]`. `optional` is set for `?.`, and `guard` where a
 * missing value is allowed, such as the input of `default`; see `MISSING` and `SHORT`.
 */
export const readMember = (
	run: Run,
	span: Span,
	target: unknown,
	rawKey: unknown,
	optional: boolean,
	guard: boolean,
): unknown => {
	if (target === SHORT) return SHORT;
	// Markup is a string with a safety mark, so it can name a property.
	const key = rawKey instanceof Markup ? rawKey.value : rawKey;
	const strict = run.state.env.strict;
	if (target === null || target === undefined || target === MISSING) {
		if (optional) return SHORT;
		if (guard) return MISSING;
		if (strict) {
			throw fail(
				run,
				span,
				"null-access",
				`Cannot read ${valueLabel(key)} of null`,
				'Use "?." to allow null.',
			);
		}
		return null;
	}
	if (typeof key !== "string" && typeof key !== "number") {
		throw fail(
			run,
			span,
			"type-error",
			`Property names must be strings or numbers, but got a ${typeName(key)}`,
		);
	}
	let value: unknown;
	try {
		value = getAttr(target, key);
	} catch (error) {
		throw locate(run, span, error, readingLabel(key));
	}
	if (value === MISSING) {
		if (guard) return MISSING;
		if (strict) throw missingProperty(run, span, target, key);
		return null;
	}
	if (value === undefined) return null;
	if (typeof value === "function")
		return checkValue(run, span, value, String(key));
	return value;
};

/** Reads literal keys one after another, such as `post.author.name`, in one closure. See `readKeys`. */
const pathRead = (root: Compiled, steps: PathStep[]): Compiled => {
	const ev = root.ev;
	const names = steps.map((access) => access.name);
	const reads = steps.map((access) => access.read);
	const spans = steps.map((access) => access.span);
	return {
		ev: (run, scope) => readKeys(run, ev(run, scope), names, reads, spans),
		async: false,
		path: { root, steps },
	};
};

/** Names a property read for an error that one of your getters or lookup methods threw. */
export const readingLabel = (key: string | number): string =>
	`Reading "${key}"`;

/** `set`: assigns where the variable already exists, or declares it in the current scope. */
export const assign = (
	run: Run,
	scope: Scope,
	name: string,
	value: unknown,
	span: Span,
): void => {
	const owner = ownerOf(scope, name);
	if (owner === run.state.globals) {
		throw fail(run, span, "assign-global", `Cannot assign to global "${name}"`);
	}
	(owner ?? scope)[name] = value ?? null;
};

export const checkValue = (
	run: Run,
	span: Span,
	value: unknown,
	name: string,
): unknown => {
	if (typeof value === "function") {
		throw fail(
			run,
			span,
			"function-value",
			`"${name}" is a function, and functions in data cannot be used in templates`,
			"Register it as a function instead, or expose it as a method.",
		);
	}
	return value;
};

export const undefinedVariable = (
	run: Run,
	span: Span,
	name: string,
	scope: Scope,
) => {
	return fail(
		run,
		span,
		"undefined-variable",
		`Unknown variable "${name}"`,
		suggest(name, variableNames(scope)),
	);
};

const missingProperty = (
	run: Run,
	span: Span,
	target: unknown,
	key: string | number,
) => {
	if (typeof target === "string" || target instanceof Markup) {
		return fail(
			run,
			span,
			"missing-property",
			`Strings have no property "${key}"`,
			key === "length" ? 'Use the "length" filter.' : "Use a filter instead.",
		);
	}
	if (Array.isArray(target)) {
		return fail(
			run,
			span,
			"missing-property",
			typeof key === "number" || /^\d+$/.test(key)
				? `Index ${key} does not exist. The array has ${target.length} ${target.length === 1 ? "item" : "items"}`
				: `Arrays have no property "${key}"`,
		);
	}
	if (BLOCKED_NAMES.has(String(key))) {
		return fail(
			run,
			span,
			"missing-property",
			`"${key}" can never be read in templates`,
		);
	}
	return fail(
		run,
		span,
		"missing-property",
		`Property "${key}" does not exist on this ${typeName(target)}`,
		suggest(String(key), readableNames(target)),
	);
};

/** Whether a chain stops before a member: at an earlier `?.` that stopped, or at this one when its object is null. */
const chainStops =
	(optional: boolean) =>
	(target: unknown): boolean =>
		target === SHORT ||
		(optional &&
			(target === null || target === undefined || target === MISSING));

/** The items a spread copies, charged against `maxSteps` before they are copied. */
const spreadItems = (run: Run, span: Span, value: unknown): unknown[] => {
	if (Array.isArray(value)) {
		locating(run, span, () => consume(run, value.length));
		return value;
	}
	if (value instanceof Set) {
		locating(run, span, () => consume(run, value.size));
		return [...value];
	}
	if (value === null || value === undefined) return [];
	throw fail(
		run,
		span,
		"type-error",
		`Only arrays and sets can be spread here, but got a ${typeName(value)}`,
	);
};

/** Copies a spread hash's entries, charged against `maxSteps` first. */
const copyHash = (
	run: Run,
	span: Span,
	target: Record<string, unknown>,
	value: unknown,
) => {
	if (value === null || value === undefined) return;
	if (isPlainObject(value)) {
		const keys = hashKeys(value);
		locating(run, span, () => consume(run, keys.length));
		for (const key of keys) setOwn(target, key, value[key]);
		return;
	}
	if (value instanceof Map) {
		locating(run, span, () => consume(run, value.size));
		for (const [key, item] of value) {
			if (typeof key === "string") setOwn(target, key, item);
		}
		return;
	}
	throw fail(
		run,
		span,
		"type-error",
		`Only hashes can be spread into a hash, but got a ${typeName(value)}`,
	);
};

/**
 * A built-in's options hash of literal keys and values, such as `formatNumber(style: "currency")`'s, built once and
 * frozen. The formatting filters cache their work by its identity.
 */
const literalHash = (node: Expression): Compiled | null => {
	if (node.type !== "Hash") return null;
	const result: Record<string, unknown> = {};
	for (const entry of node.entries) {
		if (entry.type !== "Property" || entry.key.type !== "Literal") return null;
		if (entry.value.type !== "Literal") return null;
		setOwn(result, String(entry.key.value), entry.value.value);
	}
	return constant(literalOptions(result));
};

/**
 * Calls a built-in that never waits with up to four arguments, the filtered or tested value first, without building
 * an argument list. Returns null for more arguments. Matches `locating` for a call that returns no promise.
 */
const directCall = (call: Builtin, evs: Ev[], span: Span): Ev | null => {
	const [a, b, c, d] = evs as (Ev | undefined)[];
	switch (evs.length) {
		case 0:
			return (run) => {
				step(run, span);
				try {
					return call(run);
				} catch (error) {
					throw locate(run, span, error);
				}
			};
		case 1: {
			const first = a as Ev;
			return (run, scope) => {
				step(run, span);
				const x = first(run, scope);
				try {
					return call(run, x);
				} catch (error) {
					throw locate(run, span, error);
				}
			};
		}
		case 2: {
			const first = a as Ev;
			const second = b as Ev;
			return (run, scope) => {
				step(run, span);
				const x = first(run, scope);
				const y = second(run, scope);
				try {
					return call(run, x, y);
				} catch (error) {
					throw locate(run, span, error);
				}
			};
		}
		case 3: {
			const first = a as Ev;
			const second = b as Ev;
			const third = c as Ev;
			return (run, scope) => {
				step(run, span);
				const x = first(run, scope);
				const y = second(run, scope);
				const z = third(run, scope);
				try {
					return call(run, x, y, z);
				} catch (error) {
					throw locate(run, span, error);
				}
			};
		}
		case 4: {
			const first = a as Ev;
			const second = b as Ev;
			const third = c as Ev;
			const fourth = d as Ev;
			return (run, scope) => {
				step(run, span);
				const x = first(run, scope);
				const y = second(run, scope);
				const z = third(run, scope);
				const w = fourth(run, scope);
				try {
					return call(run, x, y, z, w);
				} catch (error) {
					throw locate(run, span, error);
				}
			};
		}
		default:
			return null;
	}
};

/**
 * Moves named arguments of a built-in into their parameter positions, so `round(precision: 2)` works. Unknown names go into a trailing options hash when the built-in takes one. Problems go to `report`.
 */
export const placeArguments = (
	entry: Extract<CallableEntry, { kind: "builtin" }>,
	args: Argument[],
	label: string,
	report: (code: string, message: string, span: Span) => void,
): (Argument | null)[] => {
	if (!args.some((arg) => arg.type === "Named")) return args;
	const named = args.filter((arg) => arg.type === "Named");
	if (args.some((arg) => arg.type === "Spread")) {
		report(
			"invalid-spread",
			`${label} cannot take named and spread arguments together`,
			(named[0] as Argument).span,
		);
		return args;
	}

	const params = entry.params ?? [];
	const slots: (Argument | null)[] = args.filter(
		(arg) => arg.type === "Positional",
	);
	const options: HashEntry[] = [];
	for (const arg of named) {
		if (arg.type !== "Named") continue;
		const index = params.indexOf(arg.name);
		if (index >= 0) {
			if (slots[index]) {
				report(
					"duplicate-argument",
					`${label} got "${arg.name}" more than once`,
					arg.span,
				);
			}
			while (slots.length < index) slots.push(null);
			slots[index] = { type: "Positional", value: arg.value, span: arg.span };
		} else if (entry.options) {
			options.push({
				type: "Property",
				key: { type: "Literal", value: arg.name, span: arg.span },
				value: arg.value,
				span: arg.span,
			});
		} else {
			report(
				"unknown-argument",
				params.length === 0
					? `${label} takes no named arguments`
					: `${label} has no parameter "${arg.name}"`,
				arg.span,
			);
		}
	}
	if (options.length > 0) {
		const index = params.length;
		if (slots[index]) {
			report(
				"duplicate-argument",
				`${label} got options both as a hash and as named arguments`,
				(options[0] as HashEntry).span,
			);
		}
		while (slots.length < index) slots.push(null);
		const first = options[0] as HashEntry;
		const last = options[options.length - 1] as HashEntry;
		const span = { start: first.span.start, end: last.span.end };
		slots[index] = {
			type: "Positional",
			value: { type: "Hash", entries: options, span },
			span,
		};
	}
	for (let i = 0; i < slots.length; i++) slots[i] ??= null;
	return slots;
};

/** Turns evaluated arguments into the list a function receives: spreads expanded, named arguments as one trailing hash. */
const buildArguments = (
	run: Run,
	span: Span,
	shapes: readonly ArgumentShape[],
	values: readonly unknown[],
): unknown[] => {
	const result: unknown[] = [];
	let named: Record<string, unknown> | null = null;
	for (let i = 0; i < shapes.length; i++) {
		const shape = shapes[i] as ArgumentShape;
		const value = values[i];
		if (shape.kind === "Positional") result.push(value);
		else if (shape.kind === "Spread")
			for (const item of spreadItems(run, span, value)) result.push(item);
		else {
			named ??= {};
			setOwn(named, shape.name, value);
		}
	}
	if (named) result.push(named);
	if (result.length > MAX_ARGUMENTS) {
		throw fail(
			run,
			span,
			"too-many-arguments",
			`A call can take at most ${MAX_ARGUMENTS} arguments, but got ${result.length}`,
			"Pass the array itself instead of spreading it.",
		);
	}
	return result;
};

/** Normalises a `for` loop's value into parallel arrays of values and keys. */
export const loopItems = (
	run: Run,
	span: Span,
	value: unknown,
	wantKeys: boolean,
): { values: readonly unknown[]; keys: readonly unknown[] | null } => {
	if (value === null || value === undefined) return { values: [], keys: null };
	if (Array.isArray(value)) return { values: value, keys: null };
	if (isPlainObject(value)) {
		const keys = hashKeys(value);
		return { values: keys.map((key) => value[key]), keys };
	}
	if (value instanceof Map) {
		return {
			values: [...value.values()],
			keys: wantKeys ? [...value.keys()] : null,
		};
	}
	if (typeof value === "string" || value instanceof Markup) {
		throw fail(
			run,
			span,
			"not-iterable",
			"Cannot loop over a string",
			'Use "split" first.',
		);
	}
	if (
		typeof value === "object" &&
		typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] ===
			"function"
	) {
		const values: unknown[] = [];
		const limit = run.state.maxSteps;
		for (const item of value as Iterable<unknown>) {
			values.push(item);
			if (values.length > limit) {
				throw fail(
					run,
					span,
					"limit-steps",
					"Iterable has more items than the step limit",
				);
			}
		}
		return { values, keys: null };
	}
	throw fail(
		run,
		span,
		"not-iterable",
		`Cannot loop over a ${typeName(value)}`,
	);
};
