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
	type Statement,
	type TemplateNode,
} from "../parser/ast.js";
import { parse } from "../parser/parser.js";
import { getAttr, getMethod, readableNames } from "../runtime/access.js";
import { escapeWith } from "../runtime/escape.js";
import { callMacro } from "../runtime/macros.js";
import { Markup } from "../runtime/markup.js";
import { operatorFunction, rangeOperator } from "../runtime/operators.js";
import {
	addSlotFlags,
	after,
	checkLength,
	consume,
	fail,
	isolatedScope,
	isPromise,
	loadTemplate,
	locate,
	locating,
	renderTemplate,
	runFrom,
	step,
	withCaller,
	write,
} from "../runtime/render.js";
import type {
	BlockDef,
	CallableEntry,
	Compiled,
	CompiledMacro,
	CompiledTemplate,
	EnvironmentCore,
	Out,
	Run,
	Scope,
	SlotFill,
	Stmt,
} from "../runtime/types.js";
import {
	BLOCKED_NAMES,
	describeType,
	describeValue,
	hashKeys,
	isEmpty,
	isPlainObject,
	MISSING,
	matchesType,
	setOwn,
	templateFunctions,
	toNumber,
	toStr,
	truthy,
	typeName,
} from "../runtime/values.js";
import { Source, type Span } from "../source.js";
import { suggest } from "../suggest.js";
import { constant, evalAll, map1, map2 } from "./combinators.js";

/** Marks a short-circuited optional chain while it is being evaluated. */
const SHORT: unique symbol = Symbol("kiln.short");
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
	values: (run: Run, scope: Scope) => unknown[] | Promise<unknown[]>;
	shapes: ArgumentShape[];
	async: boolean;
	arrowAsync: boolean;
};

/** Parses and compiles template source into closures. Problems are collected in `diagnostics`; the template renders only when there are none. */
export const compileTemplate = (
	env: EnvironmentCore,
	name: string,
	text: string,
): CompiledTemplate => {
	const source = new Source(name, text);
	const { ast, problems } = parse(text, {
		isTest: (test) => env.tests.has(test),
	});
	const diagnostics = problems.map((problem) =>
		createDiagnostic(source, problem.code, problem.message, problem.span),
	);
	return new Compiler(env, source, ast, diagnostics).compile();
};

const emitter =
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

const isBlank = (statement: Statement) =>
	statement.type === "Text" && statement.value.trim() === "";

/** Checks whether any node under `node` matches. */
const containsNode = (
	node: unknown,
	matches: (record: Record<string, unknown>) => boolean,
): boolean => {
	// Iterative, because long expression chains can be thousands of levels deep.
	const stack: unknown[] = [node];
	while (stack.length > 0) {
		const current = stack.pop();
		if (typeof current !== "object" || current === null) continue;
		if (Array.isArray(current)) {
			for (const item of current) stack.push(item);
			continue;
		}
		const record = current as Record<string, unknown>;
		if (matches(record)) return true;
		for (const key in record) {
			if (key !== "span") stack.push(record[key]);
		}
	}
	return false;
};

/**
 * Whether a loop body may read `loop`, so loops only build the `loop` hash when needed.
 *
 * Blocks count too, because a child template's block can read the loop it is placed in.
 */
const mayReadLoop = (body: Statement[]): boolean =>
	containsNode(
		body,
		(record) =>
			(record.type === "Name" && record.name === "loop") ||
			record.type === "Block" ||
			(record.type === "Call" &&
				(record.callee as { type?: string; name?: string }).type === "Name" &&
				(record.callee as { name?: string }).name === "block"),
	);

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

	constructor(
		env: EnvironmentCore,
		source: Source,
		ast: TemplateNode,
		diagnostics: Diagnostic[],
	) {
		this.#env = env;
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
			slotNames: [],
		};
		this.#template = template;
	}

	compile(): CompiledTemplate {
		const template = this.#template;
		const body = this.#ast.body;

		this.#collectImports(body);
		this.#collectSlots(body);
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
				case "SetBlock":
				case "Block":
				case "Slot":
				case "Macro":
				case "With":
				case "Apply":
				case "Autoescape":
					this.#walkStatements(statement.body, visit);
					break;
			}
		}
	}

	/** Imports are visible everywhere in their file, so collect them before compiling anything. */
	#collectImports(body: Statement[]): void {
		const template = this.#template;
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
			if (statement.type === "Import") {
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
	}

	#collectSlots(body: Statement[]): void {
		const names = new Set<string>();
		this.#walkStatements(body, (statement) => {
			if (statement.type === "Slot") names.add(statement.name);
		});
		this.#template.slotNames = [...names];
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

		const blockNames = new Set<string>();
		this.#walkStatements(body, (statement) => {
			if (statement.type === "Block") {
				if (blockNames.has(statement.name)) {
					this.#error(
						"duplicate-block",
						`Block "${statement.name}" is defined more than once`,
						statement.span,
					);
				}
				blockNames.add(statement.name);
			}
		});

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
			case "SetBlock":
			case "Block":
			case "Slot":
			case "Macro":
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

	#body(statements: Statement[]): Stmt {
		return this.#sequence(
			statements.map((statement) => this.#statement(statement)),
		);
	}

	#statement(node: Statement): Stmt {
		switch (node.type) {
			case "Text": {
				const { value, span } = node;
				return (run, _scope, out) => {
					write(run, out, value, span);
				};
			}
			case "Output":
				return this.#output(node.expression, node.span);
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
			case "Slot":
				return this.#slot(node);
			case "Macro":
			case "Import":
			case "FromImport":
				return NOOP;
			case "With":
				return this.#with(node);
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

	#output(expression: Expression, span: Span): Stmt {
		const compiled = this.#expr(expression);
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
		if (!compiled.async) {
			return (run, scope, out) => {
				step(run, span);
				print(run, out, ev(run, scope));
			};
		}
		return (run, scope, out) => {
			step(run, span);
			const value = ev(run, scope);
			if (isPromise(value)) {
				return value.then((resolved) => print(run, out, resolved));
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
						truthy(resolved)
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
		const usesLoop = mayReadLoop(node.body);

		const iterate = (
			run: Run,
			scope: Scope,
			out: Out,
			values: readonly unknown[],
			keys: readonly unknown[] | null,
			index: number,
		): void | Promise<void> => {
			const length = values.length;
			for (let i = index; i < length; i++) {
				step(run, span);
				const inner = Object.create(scope) as Scope;
				inner[valueName] = values[i];
				if (keyName !== null) inner[keyName] = keys ? keys[i] : i;
				if (usesLoop) {
					const loop = Object.create(null) as Record<string, unknown>;
					loop.index = i + 1;
					loop.index0 = i;
					loop.revIndex = length - i;
					loop.revIndex0 = length - i - 1;
					loop.first = i === 0;
					loop.last = i === length - 1;
					loop.length = length;
					inner.loop = loop;
				}
				const result = body(run, inner, out);
				if (result !== undefined) {
					return result.then(() =>
						iterate(run, scope, out, values, keys, i + 1),
					);
				}
			}
		};

		const start = (run: Run, scope: Scope, out: Out, value: unknown) => {
			const { values, keys } = loopItems(run, span, value, keyName !== null);
			if (values.length === 0) return alternate?.(run, scope, out);
			return iterate(run, scope, out, values, keys, 0);
		};

		const ev = iterable.ev;
		return (run, scope, out) => {
			step(run, span);
			const value = ev(run, scope);
			if (isPromise(value)) {
				return value.then((resolved) => start(run, scope, out, resolved));
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
					assign(run, scope, name, resolved, span);
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
			const out = { s: "" };
			const result = body(run, scope, out);
			const finish = () =>
				assign(run, scope, name, new Markup(out.s, strategy), span);
			if (result !== undefined) return result.then(finish);
			finish();
		};
	}

	#props(node: Extract<Statement, { type: "Props" }>): Stmt {
		const props = node.props.map((prop) => {
			const compiled = prop.default ? this.#expr(prop.default) : null;
			if (
				prop.type &&
				prop.default &&
				compiled?.constant &&
				!matchesType(compiled.constant.value, prop.type)
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
				if (!matchesType(value, type)) {
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
							scope[prop.name] = resolved ?? null;
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

		const apply: Stmt = (run, scope) => {
			if (strict && run.passed) {
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

	#defineBlock(node: Extract<Statement, { type: "Block" }>): void {
		const saved = this.#blockName;
		this.#blockName = node.name;
		const def: BlockDef = {
			body: this.#body(node.body),
			strategy: this.#strategy,
		};
		this.#blockName = saved;
		this.#template.blocks.set(node.name, def);
	}

	#blockStatement(node: Extract<Statement, { type: "Block" }>): Stmt {
		this.#defineBlock(node);
		const { name, span } = node;
		return (run, scope, out) => {
			const entry = run.blocks.get(name)?.[0];
			if (!entry) return;
			const render = () =>
				entry.def.body(entry.run, Object.create(scope) as Scope, out);
			// A block defined in another template records where it was placed.
			return entry.run === run ? render() : withCaller(run, span, render);
		};
	}

	#include(node: Extract<Statement, { type: "Include" }>): Stmt {
		const template = this.#expr(node.template);
		const withValue = node.with ? this.#expr(node.with) : constant(null);
		const { ignoreMissing, span } = node;
		const values = evalAll([template, withValue]);

		const render = (run: Run, out: Out, [name, variables]: unknown[]) =>
			after(loadTemplate(run, name, span, ignoreMissing), (loaded) => {
				if (!loaded) return;
				const { scope, passed } = isolatedScope(run, variables, span);
				addSlotFlags(scope, loaded, null);
				return withCaller(run, span, () =>
					renderTemplate(run.state, loaded, scope, out, {
						depth: run.depth + 1,
						slots: null,
						passed,
						inherited: null,
						caller: { run, span },
					}),
				);
			});

		return (run, scope, out) => {
			step(run, span);
			return after(values(run, scope), (resolved) =>
				render(run, out, resolved),
			);
		};
	}

	#component(node: Extract<Statement, { type: "Component" }>): Stmt {
		const template = this.#expr(node.template);
		const withValue = node.with ? this.#expr(node.with) : constant(null);
		const span = node.span;
		const values = evalAll([template, withValue]);

		const fills = node.fills.map((fill) => ({
			name: fill.name,
			body: this.#body(fill.body),
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
			fills.push({ name: DEFAULT_SLOT, body: this.#body(node.body) });
		}

		const render = (
			run: Run,
			callerScope: Scope,
			out: Out,
			[name, variables]: unknown[],
		) =>
			after(loadTemplate(run, name, span), (loaded) => {
				const component = loaded as CompiledTemplate;
				const slots = new Map<string, SlotFill>();
				for (const fill of fills) {
					slots.set(fill.name, { body: fill.body, run, scope: callerScope });
				}
				const { scope, passed } = isolatedScope(run, variables, span);
				addSlotFlags(scope, component, slots);
				return withCaller(run, span, () =>
					renderTemplate(run.state, component, scope, out, {
						depth: run.depth + 1,
						slots,
						passed,
						inherited: null,
						caller: { run, span },
					}),
				);
			});

		return (run, scope, out) => {
			step(run, span);
			return after(values(run, scope), (resolved) =>
				render(run, scope, out, resolved),
			);
		};
	}

	#slot(node: Extract<Statement, { type: "Slot" }>): Stmt {
		const fallback = this.#body(node.body);
		const { name, span } = node;
		return (run, scope, out) => {
			const fill = run.slots?.get(name);
			if (fill) {
				return withCaller(run, span, () =>
					fill.body(fill.run, Object.create(fill.scope) as Scope, out),
				);
			}
			return fallback(run, Object.create(scope) as Scope, out);
		};
	}

	#with(node: Extract<Statement, { type: "With" }>): Stmt {
		const value = this.#expr(node.value);
		const body = this.#body(node.body);
		const span = node.span;
		const enter = (run: Run, scope: Scope, out: Out, variables: unknown) => {
			const inner = Object.create(scope) as Scope;
			if (isPlainObject(variables)) {
				for (const key of hashKeys(variables)) inner[key] = variables[key];
			} else if (variables instanceof Map) {
				for (const [key, item] of variables) {
					if (typeof key === "string") inner[key] = item;
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
			const captured = { s: "" };
			return after(body(run, scope, captured), () => {
				const inner = Object.create(scope) as Scope;
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
					const value = scope[name];
					if (value !== undefined) return checkValue(run, span, value, name);
					return name in scope ? null : MISSING;
				},
				async: false,
			};
		}
		if (this.#env.strict) {
			return {
				ev: (run, scope) => {
					const value = scope[name];
					if (value !== undefined) {
						return typeof value === "function"
							? checkValue(run, span, value, name)
							: value;
					}
					if (name in scope) return null;
					throw undefinedVariable(run, span, name, scope);
				},
				async: false,
			};
		}
		return {
			ev: (run, scope) => {
				const value = scope[name];
				if (value === undefined) return null;
				return typeof value === "function"
					? checkValue(run, span, value, name)
					: value;
			},
			async: false,
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
		return map1(
			test,
			(value, run, scope) =>
				truthy(value) ? consequent.ev(run, scope) : alternate.ev(run, scope),
			consequent.async || alternate.async,
		);
	}

	#member(
		node: Extract<Expression, { type: "Member" }>,
		guard: boolean,
	): Compiled {
		const object = this.#expr(node.object, guard);
		const { optional, span } = node;
		const strict = this.#env.strict;

		const read = (run: Run, target: unknown, rawKey: unknown): unknown => {
			if (target === SHORT) return SHORT;
			// Markup is a string with a safety mark, so it can name a property.
			const key = rawKey instanceof Markup ? rawKey.value : rawKey;
			if (target === null || target === undefined || target === MISSING) {
				if (optional) return SHORT;
				if (guard) return MISSING;
				if (strict) {
					throw fail(
						run,
						span,
						"null-access",
						`Cannot read "${String(key)}" of null`,
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
				throw locate(run, span, error, "A lookup method");
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

		const property = node.property;
		if (property.type === "Literal") {
			const key = property.value;
			return map1(object, (target, run) => read(run, target, key));
		}
		return map2(object, this.#expr(property), (target, key, run) =>
			read(run, target, key),
		);
	}

	#arrow(node: Extract<Expression, { type: "Arrow" }>): Compiled {
		const body = this.#expr(node.body);
		const { params, span } = node;
		const ev = body.ev;
		return {
			ev: (run, scope) => {
				const fn = (...args: unknown[]) => {
					step(run, span);
					const inner = Object.create(scope) as Scope;
					for (let i = 0; i < params.length; i++) {
						inner[params[i] as string] = args[i] ?? null;
					}
					return ev(run, inner);
				};
				// Lets filters such as `sort` tell a key selector from a comparator.
				Object.defineProperty(fn, "length", { value: params.length });
				templateFunctions.add(fn);
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
	#arguments(args: (Argument | null)[]): CompiledArguments {
		for (const arg of args) {
			if (arg?.type === "Named" && arg.name === "__proto__")
				this.#protoKey(arg.span);
		}
		const compiled = args.map((arg) =>
			arg ? this.#expr(arg.value) : constant(undefined),
		);
		return {
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
		const values = evalAll([object, key]);

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
					`Cannot call "${String(name)}" on null`,
				);
			}
			const method =
				typeof name === "string" ? getMethod(target, name) : undefined;
			if (!method) {
				throw fail(
					run,
					span,
					"method-not-exposed",
					`"${String(name)}" is not a method that ${typeName(target)} exposes`,
				);
			}
			const built = buildArguments(run, span, args.shapes, list);
			return locating(
				run,
				span,
				() => method.apply(target, built),
				`Method "${name}"`,
			);
		};

		return {
			ev: (run, scope) =>
				after(values(run, scope), ([target, name]) => {
					step(run, span);
					return after(args.values(run, scope), (list) =>
						invoke(run, target, name, list),
					);
				}),
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
		const args = this.#arguments(
			entry.kind === "builtin"
				? this.#placeArguments(entry, argNodes, label)
				: argNodes,
		);
		const all = input ? evalAll([input]) : null;
		const inputAsync = input?.async ?? false;
		const shapes = args.shapes;
		const valuesOf = args.values;

		const invoke = (
			run: Run,
			first: unknown,
			hasInput: boolean,
			list: unknown[],
		) => {
			const built = buildArguments(run, span, shapes, list);
			if (hasInput) built.unshift(first);
			if (entry.kind === "builtin") {
				const call = entry.call;
				return locating(run, span, () => call(run, ...built));
			}
			const call = entry.call;
			if (entry.render) {
				return locating(run, span, () => call(run.info, ...built), label);
			}
			return locating(run, span, () => call(...built), label);
		};

		const resultAsync = entry.kind === "host" || args.arrowAsync;
		const async = resultAsync || args.async || inputAsync;

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

	/**
	 * Moves named arguments of a built-in into their parameter positions, so `round(precision: 2)` works. Unknown names go into a trailing options hash when the built-in takes one.
	 */
	#placeArguments(
		entry: Extract<CallableEntry, { kind: "builtin" }>,
		args: Argument[],
		label: string,
	): (Argument | null)[] {
		if (!args.some((arg) => arg.type === "Named")) return args;
		const named = args.filter((arg) => arg.type === "Named");
		if (args.some((arg) => arg.type === "Spread")) {
			this.#error(
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
					this.#error(
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
				this.#error(
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
				this.#error(
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
			const known = strategyArg.constant?.value;
			if (
				known !== undefined &&
				!ESCAPE_STRATEGIES.includes(known as EscapeStrategy)
			) {
				this.#error(
					"unknown-strategy",
					`Unknown escaping strategy "${String(known)}"`,
					span,
				);
			}
			return map2(input, strategyArg, (value, target, run) => {
				if (!ESCAPE_STRATEGIES.includes(target as EscapeStrategy)) {
					throw fail(
						run,
						span,
						"unknown-strategy",
						`Unknown escaping strategy "${String(target)}"`,
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
							`Block "${String(value)}" does not exist`,
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
	const out = { s: "" };
	const done = () => {
		state.blockDepth--;
		return new Markup(out.s, entry.def.strategy || "html");
	};
	const result = withCaller(run, span, () =>
		entry.def.body(entry.run, Object.create(scope) as Scope, out),
	);
	if (result instanceof Promise) {
		return result.then(done, (error: unknown) => {
			state.blockDepth--;
			throw error;
		});
	}
	return done();
};

/** `set`: assigns where the variable already exists, or declares it in the current scope. */
const assign = (
	run: Run,
	scope: Scope,
	name: string,
	value: unknown,
	span: Span,
): void => {
	let owner: Scope | null = scope;
	while (owner !== null && !Object.hasOwn(owner, name)) {
		owner = Object.getPrototypeOf(owner) as Scope | null;
	}
	if (owner === run.state.globals) {
		throw fail(run, span, "assign-global", `Cannot assign to global "${name}"`);
	}
	(owner ?? scope)[name] = value;
};

const checkValue = (
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

const undefinedVariable = (
	run: Run,
	span: Span,
	name: string,
	scope: Scope,
) => {
	const names: string[] = [];
	for (const key in scope) names.push(key);
	return fail(
		run,
		span,
		"undefined-variable",
		`Unknown variable "${name}"`,
		suggest(name, names),
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

const spreadItems = (run: Run, span: Span, value: unknown): unknown[] => {
	if (Array.isArray(value)) return value;
	if (value instanceof Set) return [...value];
	if (value === null || value === undefined) return [];
	throw fail(
		run,
		span,
		"type-error",
		`Only arrays and sets can be spread here, but got a ${typeName(value)}`,
	);
};

const copyHash = (
	run: Run,
	span: Span,
	target: Record<string, unknown>,
	value: unknown,
) => {
	if (value === null || value === undefined) return;
	if (isPlainObject(value)) {
		for (const key of hashKeys(value)) setOwn(target, key, value[key]);
		return;
	}
	if (value instanceof Map) {
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
const loopItems = (
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
