import {
	type Argument,
	DEFAULT_SLOT,
	ESCAPE_STRATEGIES,
	type EscapeStrategy,
	type Expression,
	type Statement,
	type TemplateNode,
} from "../parser/ast.js";
import type { EnvironmentCore } from "../runtime/types.js";
import { BLOCKED_NAMES } from "../runtime/values.js";
import type { Span } from "../source.js";
import { emitter, placeArguments } from "./compiler.js";
import { PRECOMPILED_VERSION } from "./precompiled.js";

/**
 * Generates JavaScript for a template that compiled without problems, for `precompile`.
 *
 * Runs of statements become functions: text, outputs, `if`, `for`, `set`, `autoescape`, untyped `props` without a
 * rest prop, includes, components, slots and block placements, with expressions that use variables, literals,
 * operators and built-in functions, filters and tests. Your own functions and filters, which may return promises, are generated when a call
 * is a whole `set` value, loop or output. Code that may wait continues in another function, or pauses as a generator,
 * only when a promise comes back; see `#function`. Everything else, such as macros and arrow functions, is left to
 * the closure compiler, which compiles the template's source as usual and puts the generated functions in place of
 * the runs they cover.
 *
 * Generated code calls the helpers in `precompiled.ts` for every rule templates follow, so it behaves as the closures
 * do. Nothing from the template reaches the generated source except through `JSON.stringify`, a strict identifier
 * check or a number, so a template cannot inject code.
 */
export const generateModule = (
	env: EnvironmentCore,
	ast: TemplateNode,
	source: string,
): string => new Generator(env, ast).module(source);

/** Thrown for anything the generator leaves to the closure compiler. */
class Unsupported extends Error {}

const unsupported = (): never => {
	throw new Unsupported();
};

/**
 * What a name means inside generated code: a JavaScript local, or a loop's `loop` hash. A local has a flag for
 * whether it holds a plain object, set once when it is bound, so reading its properties skips that check.
 */
type Binding =
	| { kind: "value"; js: string; plain: string }
	| { kind: "loop"; index: string; length: string };

/** A variable from outside generated code, looked up once, and whether it is a plain object. */
type Cached = { value: string; plain: string };

type Context = {
	bindings: ReadonlyMap<string, Binding>;
	strategy: EscapeStrategy | false;
	/** Inside a generated loop, whose variables are JavaScript locals rather than scope variables. */
	inLoop: boolean;
	/** At the top level of a run, where a wait can end the function and continue in the next. See `#function`. */
	top: boolean;
	/** The JavaScript name of the scope variables are looked up and set in: the function's, or a loop pass's. */
	scope: string;
};

/** One generated function: a run, or a component's fill. */
type FunctionState = {
	/** Temporaries it declares. */
	temps: number;
	/**
	 * Variables from outside generated code, each looked up once. Only `props` changes variables in generated code,
	 * and it forgets the lookups it may have changed.
	 */
	variables: Map<string, Cached>;
	/** Plain-object flags of variables that property reads use. Only these are set; see `PLAIN`. */
	plainUsed: Set<string>;
	/** It may wait for a promise. */
	waits: boolean;
	/** It may wait somewhere other than at the end of a top-level statement, such as in a loop, so it is a generator. */
	waitsInside: boolean;
};

const newFunction = (): FunctionState => ({
	temps: 0,
	variables: new Map(),
	plainUsed: new Set(),
	waits: false,
	waitsInside: false,
});

/**
 * Stands for a wait in generated lines until `#function` knows whether it yields or continues in a new function.
 *
 * Markers use control characters because `JSON.stringify` escapes them, so text from a template never contains one.
 */
const WAIT = "\u0000wait ";

// oxlint-disable-next-line no-control-regex -- matches the marker, see `WAIT`
const WAIT_LINE = /^(\t*)\u0000wait (t\d+)$/;

/**
 * Stands for setting a variable's plain-object flag, `\u0001flag:value\u0001`, until `#function` knows whether any
 * property read uses the flag. It becomes `, flag = plain(value)` or nothing.
 */
// oxlint-disable-next-line no-control-regex -- matches the marker, see `WAIT`
const PLAIN = /\u0001(f\d+):([\w$]+)\u0001/g;

const setPlain = (flag: string, value: string) =>
	`\u0001${flag}:${value}\u0001`;

/** The helpers generated code takes from the runtime. See `precompiled.ts`. */
const HELPERS = [
	"MISSING",
	"SHORT",
	"objectPrototype",
	"getPrototypeOf",
	"hasOwn",
	"step",
	"stepLimit",
	"rangeLimit",
	"aborted",
	"write",
	"drive",
	"startPlace",
	"endPlace",
	"indentText",
	"indentedText",
	"truthy",
	"isEmpty",
	"equals",
	"escapeHtml",
	"readMember",
	"loopItems",
	"checkValue",
	"plain",
	"name",
	"guardedName",
	"print",
	"call0",
	"call1",
	"call2",
	"call3",
	"call4",
	"binary",
	"concat",
	"range",
	"toNumber",
	"str",
	"joined",
	"raw",
	"escape",
	"loop",
	"embed",
	"embedScope",
	"embedKeyed",
	"assign",
	"callHost",
	"hostError",
	"childScope",
	"fillSlot",
	"placeBlock",
	"checkPassed",
	"missingProp",
];

/** Fields of the `loop` hash, as JavaScript over the loop's index and length. */
const LOOP_FIELDS: Record<string, (index: string, length: string) => string> = {
	index: (i) => `(${i} + 1)`,
	index0: (i) => i,
	revIndex: (i, n) => `(${n} - ${i})`,
	revIndex0: (i, n) => `(${n} - ${i} - 1)`,
	first: (i) => `(${i} === 0)`,
	last: (i, n) => `(${i} === ${n} - 1)`,
	length: (_i, n) => n,
};

/** Operators with a JavaScript equivalent when both sides are numbers. */
const NUMBER_OPERATORS = new Set([
	"<",
	">",
	"<=",
	">=",
	"+",
	"-",
	"*",
	"/",
	"%",
]);

/** Names of a generated loop's locals. */
type LoopNames = {
	id: number;
	span: string;
	/** For a loop whose body uses `set`: the scope each pass makes, as the closures do, and the scope it is made in. */
	scope: string | null;
	outer: string;
	/** Variables the body sets, whose lookups each pass forgets. */
	sets: string[];
	values: string;
	length: string;
	keys: string;
	index: string;
	value: string;
	key: string;
	hasKeys: boolean;
};

/** The ends of a range of integer literals, such as `1..5` or `-2..2`, or null for any other expression. */
const literalRange = (
	node: Expression,
): { from: number; to: number } | null => {
	if (node.type !== "Binary" || node.operator !== "..") return null;
	const integer = (side: Expression): number | null => {
		if (side.type === "Literal") {
			return Number.isInteger(side.value) ? (side.value as number) : null;
		}
		if (
			side.type === "Unary" &&
			side.operator === "-" &&
			side.operand.type === "Literal" &&
			Number.isInteger(side.operand.value)
		) {
			return -(side.operand.value as number);
		}
		return null;
	};
	const from = integer(node.left);
	const to = integer(node.right);
	return from === null || to === null ? null : { from, to };
};

/** An include's or component's template name in generated code. See `#target`. */
type TemplateTarget =
	| { kind: "value"; js: string }
	| {
			kind: "keyed";
			prefix: string;
			key: string;
			joined: string;
			nameSpan: string;
	  };

/** A `with` value whose keys are known, or none, so generated code makes the template's scope itself. */
const isKnownWith = (node: Expression | null): boolean =>
	node === null ||
	(node.type === "Hash" &&
		node.entries.every(
			(entry) =>
				entry.type === "Property" &&
				entry.key.type === "Literal" &&
				!BLOCKED_NAMES.has(String(entry.key.value)),
		));

/** Names that `set` statements set, directly or inside other statements. */
const setsIn = (
	statements: Statement[],
	names = new Set<string>(),
): Set<string> => {
	for (const statement of statements) {
		if (statement.type === "Set") names.add(statement.name);
		else if (statement.type === "If") {
			for (const branch of statement.branches) setsIn(branch.body, names);
			setsIn(statement.alternate ?? [], names);
		} else if (statement.type === "For") {
			setsIn(statement.body, names);
			setsIn(statement.alternate ?? [], names);
		} else if (statement.type === "Autoescape" || statement.type === "Slot") {
			setsIn(statement.body, names);
		}
	}
	return names;
};

/** Whether statements include one that may wait, such as an include, so a loop over them may become a function. */
const waitsIn = (statements: Statement[]): boolean =>
	statements.some((statement) => {
		switch (statement.type) {
			case "Include":
			case "Component":
			case "Slot":
			case "Block":
				return true;
			case "If":
				return (
					statement.branches.some((branch) => waitsIn(branch.body)) ||
					waitsIn(statement.alternate ?? [])
				);
			case "For":
				return waitsIn(statement.body) || waitsIn(statement.alternate ?? []);
			case "Autoescape":
				return waitsIn(statement.body);
			default:
				return false;
		}
	});

/** Characters of text a loop gathers before writing them out. */
const FLUSH_AT = 4096;

/** Longest `else if` chain written as one. Longer chains become a flat labelled block. */
const MAX_ELSE_IF = 16;

/** Deepest expression the generator writes. Deeper ones stay with the closure compiler. */
const MAX_DEPTH = 100;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** A literal as JavaScript. */
const literal = (value: unknown): string => {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number" && Number.isFinite(value)) {
		return Object.is(value, -0) ? "-0" : String(value);
	}
	return unsupported();
};

const BOOLEAN_OPERATORS = new Set([
	"and",
	"or",
	"==",
	"!=",
	"<",
	">",
	"<=",
	">=",
	"in",
	"not in",
	"starts with",
	"ends with",
]);

/** Whether generated code for an expression is always a JavaScript boolean. */
const isBoolean = (node: Expression, context: Context): boolean => {
	switch (node.type) {
		case "Literal":
			return typeof node.value === "boolean";
		case "Binary":
			return BOOLEAN_OPERATORS.has(node.operator);
		case "Unary":
			return node.operator === "not";
		case "Test":
			return true;
		case "Member":
			return (
				node.object.type === "Name" &&
				context.bindings.get(node.object.name)?.kind === "loop" &&
				node.property.type === "Literal" &&
				(node.property.value === "first" || node.property.value === "last")
			);
		default:
			return false;
	}
};

/**
 * Whether a local holds a plain object, written out where it is used rather than calling `plain`, so V8 can turn the
 * prototype check into a field load for the few shapes each place sees. `q` is a scratch local every function has.
 */
const isPlainCode = (value: string): string =>
	`(typeof ${value} === "object" && ${value} !== null && ((q = getPrototypeOf(${value})) === objectPrototype || q === null))`;

/** Reading a known key, as `.key` when it is an identifier. */
const access = (key: string): string =>
	IDENTIFIER.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;

const isBlank = (statement: Statement) =>
	statement.type === "Text" && statement.value.trim() === "";

const indent = (lines: string[]): string[] => lines.map((line) => `\t${line}`);

class Generator {
	readonly #env: EnvironmentCore;
	readonly #ast: TemplateNode;
	/** Names that call macros rather than functions: local macros and macros imported by name. */
	readonly #macros = new Set<string>();
	/** Start and end offsets of every span generated code refers to, flattened. */
	readonly #spans: number[] = [];
	readonly #spanIndex = new Map<string, number>();
	/** Declarations made once when the module is loaded, such as built-ins and frozen option hashes. */
	readonly #constants: string[] = [];
	readonly #constantNames = new Map<string, string>();
	readonly #runs: string[] = [];
	/** Generator functions for runs that may wait, declared once in `create`. */
	readonly #declarations: string[] = [];
	#generators = 0;
	/** Lists the closure compiler compiles itself, such as the bodies of blocks a run places, searched for runs later. */
	readonly #pending: [Statement[], EscapeStrategy | false][] = [];
	/** The function being generated. */
	#fn = newFunction();
	/** Plain-object flags of loop variables that generated code reads, so loops only set the ones used. */
	readonly #plainUsed = new Set<string>();
	/** Loops so far, for local names unique in the module, so a fill's loops never hide the loop around it. */
	#loops = 0;
	#depth = 0;

	constructor(env: EnvironmentCore, ast: TemplateNode) {
		this.#env = env;
		this.#ast = ast;
		for (const statement of ast.body) {
			if (statement.type === "Macro") this.#macros.add(statement.name);
			if (statement.type === "FromImport") {
				for (const entry of statement.names) this.#macros.add(entry.alias);
			}
		}
	}

	module(source: string): string {
		// A child template's top level only defines blocks, so only the lists inside it run.
		const child = this.#ast.body.some(
			(statement) => statement.type === "Extends",
		);
		this.#list(this.#ast.body, this.#env.autoescape, child);
		for (let next = this.#pending.shift(); next; next = this.#pending.shift()) {
			this.#list(next[0], next[1], false);
		}
		return [
			"// Precompiled by Kiln. Don't edit this file: precompile the template again.",
			"export default {",
			`\tkiln: ${PRECOMPILED_VERSION},`,
			`\tautoescape: ${JSON.stringify(this.#env.autoescape)},`,
			`\tsource: ${JSON.stringify(source)},`,
			"\tcreate(rt) {",
			`\t\tconst { ${HELPERS.join(", ")} } = rt;`,
			`\t\tconst S = rt.spans([${this.#spans.join(", ")}]);`,
			...this.#constants.map((line) => `\t\t${line}`),
			...this.#declarations.map((line) => `\t\t${line}`),
			"\t\treturn [",
			...this.#runs,
			"\t\t];",
			"\t},",
			"};",
			"",
		].join("\n");
	}

	// Runs

	/**
	 * Finds runs of statements to generate in a list. A statement that can't be generated stays with the closure
	 * compiler, and the lists inside it are searched in turn. With `searchOnly`, only the lists inside are searched.
	 */
	#list(
		list: Statement[],
		strategy: EscapeStrategy | false,
		searchOnly: boolean,
	): void {
		const context: Context = {
			bindings: new Map(),
			strategy,
			inLoop: false,
			top: true,
			scope: "scope",
		};
		let i = 0;
		while (i < list.length) {
			if (searchOnly) {
				this.#children(list[i] as Statement, strategy);
				i++;
				continue;
			}
			this.#fn = newFunction();
			const groups: string[][] = [];
			let end = i;
			let work = false;
			while (end < list.length) {
				const statement = list[end] as Statement;
				const generated = this.#attempt(() =>
					this.#statement(statement, context),
				);
				if (!generated) break;
				groups.push(generated);
				if (statement.type !== "Text") work = true;
				end++;
			}
			if (end === i) {
				this.#children(list[i] as Statement, strategy);
				i++;
				continue;
			}
			if (work) {
				const first = (list[i] as Statement).span;
				const last = (list[end - 1] as Statement).span;
				const span = this.#span({ start: first.start, end: last.end });
				this.#runs.push(
					`\t\t\t[${first.start}, ${last.end}, ${this.#function(groups, span, false)}],`,
				);
			}
			i = end;
		}
	}

	/**
	 * Writes the current function from its top-level statements' lines. Text is gathered in `s`, and written before
	 * anything that writes to `out` itself, and at the end.
	 *
	 * A function that never waits is a plain function. A run whose waits all end top-level statements, such as an
	 * include, is split after each into functions that call the next, so it only makes a callback when a promise comes
	 * back. Anything else that may wait, such as an include in a loop, is a generator that `drive` runs.
	 */
	#function(groups: string[][], span: string, nested: boolean): string {
		const fn = this.#fn;
		groups = groups.map((lines) => this.#setFlags(lines));
		// Steps are counted in a local, and `state.steps` kept up to date wherever other code may read or count them.
		const start = this.#start();
		const end = ["state.steps = steps;", `write(run, out, s, ${span});`];
		const wrap = (lines: string[]) =>
			indent(lines).map((line) => `\t\t\t${line}`);

		if (!fn.waits) {
			const body = wrap([...start, ...groups.flat(), ...end]);
			return `(run, scope, out) => {\n${body.join("\n")}\n\t\t\t}`;
		}

		if (!fn.waitsInside && !nested) {
			const segments: string[][] = [[]];
			for (const group of groups) {
				(segments.at(-1) as string[]).push(...group);
				if (group.some((line) => WAIT_LINE.test(line))) segments.push([]);
			}
			const base = `R${this.#generators++}`;
			segments.forEach((lines, index) => {
				const next = `${base}_${index + 1}(run, scope, out)`;
				const body = lines.map((line) =>
					line.replace(
						WAIT_LINE,
						(_, tabs: string, result: string) =>
							`${tabs}if (${result} !== undefined) return ${result}.then(() => ${next});`,
					),
				);
				// Each function writes its own text, such as a slot's fallback, before the next takes over.
				const last = index === segments.length - 1;
				this.#declarations.push(
					`function ${base}_${index}(run, scope, out) {`,
					...indent([
						...start,
						...body,
						...end,
						...(last ? [] : [`return ${next};`]),
					]),
					"}",
				);
			});
			return `${base}_0`;
		}

		const body = wrap([...start, ...groups.flat(), ...end]).map((line) =>
			line.replace(
				WAIT_LINE,
				(_, tabs: string, result: string) =>
					`${tabs}if (${result} !== undefined) yield ${result};`,
			),
		);
		// A run's generator is declared once. A fill's is made where the component is, to read the loops around it.
		if (!nested) {
			const generator = `G${this.#generators++}`;
			this.#declarations.push(
				`function* ${generator}(run, scope, out) {`,
				...body.map((line) => line.slice(2)),
				"}",
			);
			return `(run, scope, out) => drive(${generator}(run, scope, out))`;
		}
		return `(run, scope, out) => drive((function* () {\n${body.join("\n")}\n\t\t\t})())`;
	}

	/** Sets the plain-object flags the current function's property reads use. See `PLAIN`. */
	#setFlags(lines: string[]): string[] {
		const used = this.#fn.plainUsed;
		return lines.map((line) =>
			line.replace(PLAIN, (_, flag: string, value: string) =>
				used.has(flag) ? `, ${flag} = ${isPlainCode(value)}` : "",
			),
		);
	}

	/** Declarations at the start of a generated function: steps are counted in a local, see `#function`. */
	#start(): string[] {
		const fn = this.#fn;
		const declared = [
			...Array.from({ length: fn.temps }, (_, i) => `t${i}`),
			...[...fn.variables.values()].flatMap(({ value, plain }) =>
				fn.plainUsed.has(plain) ? [value, plain] : [value],
			),
		];
		return [
			"const state = run.state;",
			"const maxSteps = state.maxSteps;",
			"let steps = state.steps;",
			"const signal = state.signal;",
			"const ind = out.indent;",
			'let s = "";',
			`let ${["q", ...declared].join(", ")};`,
		];
	}

	/** Generates a statement, or returns null and forgets anything it added when the statement can't be generated. */
	#attempt(generate: () => string[]): string[] | null {
		const restore = this.#snapshot();
		try {
			return generate();
		} catch (error) {
			if (!(error instanceof Unsupported)) throw error;
			restore();
			return null;
		}
	}

	/** Returns a function that forgets everything generated since, such as constants and queued lists. */
	#snapshot(): () => void {
		const constants = this.#constants.length;
		const names = [...this.#constantNames.keys()];
		const pending = this.#pending.length;
		const declarations = this.#declarations.length;
		const fn = this.#fn;
		const saved = {
			...fn,
			variables: new Map(fn.variables),
			plainUsed: new Set(fn.plainUsed),
		};
		return () => {
			this.#constants.length = constants;
			for (const key of this.#constantNames.keys()) {
				if (!names.includes(key)) this.#constantNames.delete(key);
			}
			this.#pending.length = pending;
			this.#declarations.length = declarations;
			this.#fn = saved;
		};
	}

	#children(statement: Statement, strategy: EscapeStrategy | false): void {
		switch (statement.type) {
			case "If":
				for (const branch of statement.branches) {
					this.#list(branch.body, strategy, false);
				}
				if (statement.alternate) {
					this.#list(statement.alternate, strategy, false);
				}
				break;
			case "For":
				this.#list(statement.body, strategy, false);
				if (statement.alternate) {
					this.#list(statement.alternate, strategy, false);
				}
				break;
			case "Component":
				this.#list(statement.body, strategy, false);
				for (const fill of statement.fills) {
					this.#list(fill.body, strategy, false);
				}
				break;
			case "Autoescape":
				this.#list(statement.body, statement.strategy, false);
				break;
			case "SetBlock":
			case "Block":
			case "Slot":
			case "Macro":
			case "Add":
			case "Cache":
			case "With":
			case "Apply":
				this.#list(statement.body, strategy, false);
				break;
		}
	}

	// Names for constants and temporaries

	#span(span: Span): string {
		const key = `${span.start}:${span.end}`;
		let index = this.#spanIndex.get(key);
		if (index === undefined) {
			index = this.#spanIndex.size;
			this.#spanIndex.set(key, index);
			this.#spans.push(span.start, span.end);
		}
		return `S[${index}]`;
	}

	/** A value made once when the module loads, such as a built-in filter. */
	#constant(key: string, prefix: string, value: string): string {
		let name = this.#constantNames.get(key);
		if (name === undefined) {
			name = `${prefix}${this.#constantNames.size}`;
			this.#constantNames.set(key, name);
			this.#constants.push(`const ${name} = ${value};`);
		}
		return name;
	}

	#temp(): string {
		return `t${this.#fn.temps++}`;
	}

	/** Counts one step, as `step` does. */
	#step(span: string): string {
		return `++steps > maxSteps && stepLimit(run, ${span})`;
	}

	/** Counts a step and checks the abort signal, as `step` does, for loops, so a long render stops soon after an abort. */
	#loopStep(span: string): string {
		return `${this.#step(span)}; signal !== undefined && signal.aborted && aborted(run, ${span});`;
	}

	/** Calls something that may read or count steps, with `state.steps` up to date around it. */
	#counted(call: string): string {
		const result = this.#temp();
		return `(state.steps = steps, ${result} = ${call}, steps = state.steps, ${result})`;
	}

	/**
	 * Writes the text so far, runs something that writes to `out` and may return a promise, and waits for it. `top`
	 * is set when the wait ends a top-level statement.
	 */
	#wait(span: string, call: string, top: boolean): string[] {
		this.#fn.waits = true;
		if (!top) this.#fn.waitsInside = true;
		const result = this.#temp();
		return [
			`write(run, out, s, ${span});`,
			's = "";',
			"state.steps = steps;",
			`${result} = ${call};`,
			`${WAIT}${result}`,
			"steps = state.steps;",
		];
	}

	/** A function for a list of statements inside the current one, such as a component's fill. */
	#nested(list: Statement[], at: Span, context: Context): string {
		const outer = this.#fn;
		this.#fn = newFunction();
		try {
			// A fill runs in a scope of its own, made from the caller's when the slot renders it.
			const lines = this.#body(list, { ...context, scope: "scope" });
			return this.#function([lines], this.#span(at), true);
		} finally {
			this.#fn = outer;
		}
	}

	// Statements

	#statement(statement: Statement, context: Context): string[] {
		switch (statement.type) {
			case "Text":
				return [this.#text(statement)];
			case "Output":
				return this.#output(statement.expression, statement.span, context);
			case "If":
				return this.#if(statement, context);
			case "For":
				return this.#for(statement, context);
			case "Autoescape":
				return this.#body(statement.body, {
					...context,
					strategy: statement.strategy,
				});
			case "Props":
				return this.#props(statement, context);
			case "Set":
				return this.#set(statement, context);
			case "Include":
				return this.#include(statement, context);
			case "Component":
				return this.#component(statement, context);
			case "Slot":
				return this.#slot(statement, context);
			case "Block":
				return this.#block(statement, context);
			default:
				return unsupported();
		}
	}

	/** Text, with its lines indented to where it is inserted. See `indentText`. */
	#text(statement: Extract<Statement, { type: "Text" }>): string {
		const text = JSON.stringify(statement.value);
		if (!statement.lines) return `s += ${text};`;
		const lines = JSON.stringify(statement.lines);
		const entry = this.#constant(
			`text:${statement.span.start}:${statement.span.end}`,
			"T",
			`indentedText(${text}, ${lines})`,
		);
		// The text indented last time is read here, so the usual case makes no call.
		return `s += ind === "" ? ${text} : ${entry}.indent === ind && !out.inline ? ${entry}.indented : indentText(${entry}, ind, s === "" && out.inline);`;
	}

	/**
	 * Inserts content at the indentation of the tag that inserts it, with `startPlace` and `endPlace`. Tags at the start
	 * of a line need nothing. Saved values go in temporaries rather than a closure, so the function's locals stay fast.
	 */
	#place(at: string | undefined, call: string): string {
		if (at === "") return call;
		const [saved, inline] = [this.#temp(), this.#temp()];
		return `(${saved} = out.indent, ${inline} = out.inline, startPlace(out, ${this.#at(at)}), endPlace(out, ${saved}, ${inline}, ${call}))`;
	}

	#at(at: string | undefined): string {
		return at === undefined ? "undefined" : JSON.stringify(at);
	}

	/** Statements inside another, such as a loop's body. */
	#body(list: Statement[], context: Context): string[] {
		const inner = { ...context, top: false };
		return list.flatMap((statement) => this.#statement(statement, inner));
	}

	#output(expression: Expression, at: Span, context: Context): string[] {
		const span = this.#span(at);
		const step = `${this.#step(span)};`;
		const emit = emitter(context.strategy);
		const emitted = (value: unknown): string => {
			try {
				return JSON.stringify(emit(value));
			} catch {
				// Fails when rendering, so the closures report it.
				return unsupported();
			}
		};
		if (expression.type === "Literal") {
			return [step, `s += ${emitted(expression.value)};`];
		}
		// A choice between two literals prints text emitted now.
		if (expression.type === "Conditional") {
			const { consequent, alternate } = expression;
			if (
				consequent.type === "Literal" &&
				(alternate === null || alternate.type === "Literal")
			) {
				const yes = emitted(consequent.value);
				const no = emitted(alternate ? alternate.value : null);
				const test = this.#condition(expression.test, context);
				return [step, `s += ${test} ? ${yes} : ${no};`];
			}
		}
		const value = this.#temp();
		const code = this.#value(expression, context, value);
		const strategy = context.strategy;
		const print =
			strategy === "html"
				? `typeof ${value} === "string" ? escapeHtml(${value}) : print(run, ${span}, ${value}, "html")`
				: strategy === false
					? `typeof ${value} === "string" ? ${value} : print(run, ${span}, ${value}, "none")`
					: `print(run, ${span}, ${value}, ${JSON.stringify(strategy)})`;
		return [step, ...code, `s += ${print};`];
	}

	/**
	 * Branches test in order, and the first that holds runs. JavaScript nests `else if`, so long chains become a flat
	 * labelled block that its parser can read without recursing once per branch.
	 */
	#if(
		statement: Extract<Statement, { type: "If" }>,
		context: Context,
	): string[] {
		const lines = [`${this.#step(this.#span(statement.span))};`];
		const branches = statement.branches.map((branch) => ({
			test: this.#condition(branch.test, context),
			body: indent(this.#body(branch.body, context)),
		}));
		const alternate = statement.alternate
			? indent(this.#body(statement.alternate, context))
			: null;
		if (branches.length <= MAX_ELSE_IF) {
			branches.forEach(({ test, body }, index) => {
				lines.push(`${index === 0 ? "if" : "} else if"} (${test}) {`, ...body);
			});
			if (alternate) lines.push("} else {", ...alternate);
			lines.push("}");
			return lines;
		}
		const label = `if${this.#loops++}`;
		lines.push(`${label}: {`);
		for (const { test, body } of branches) {
			lines.push(
				`\tif (${test}) {`,
				...indent(body),
				`\t\tbreak ${label};`,
				"\t}",
			);
		}
		if (alternate) lines.push(...alternate);
		lines.push("}");
		return lines;
	}

	/**
	 * A loop. Its variables become JavaScript locals, since nothing in generated code can change them, and `loop.index`
	 * and the rest read the loop's counter. Text is written whenever a pass leaves more than `FLUSH_AT` characters, so
	 * the output limit still stops a long loop early.
	 */
	#for(
		statement: Extract<Statement, { type: "For" }>,
		context: Context,
	): string[] {
		const span = this.#span(statement.span);
		const id = this.#loops++;
		const iterable = this.#temp();
		const [items, values, length, keys, index, value, key] = [
			"items",
			"values",
			"n",
			"keys",
			"i",
			"v",
			"k",
		].map((name) => `${name}${id}`) as [
			string,
			string,
			string,
			string,
			string,
			string,
			string,
		];
		const bindings = new Map(context.bindings);
		bindings.set(statement.valueName, {
			kind: "value",
			js: value,
			plain: `p${value}`,
		});
		if (statement.keyName !== null) {
			bindings.set(statement.keyName, {
				kind: "value",
				js: key,
				plain: `p${key}`,
			});
		}
		bindings.set("loop", { kind: "loop", index, length });
		const hasKeys = statement.keyName !== null;
		const sets = [...setsIn(statement.body)];
		const scoped = sets.length > 0 ? `sc${id}` : null;
		const loop: LoopNames = {
			id,
			span,
			scope: scoped,
			outer: context.scope,
			sets,
			values,
			length,
			keys,
			index,
			value,
			key,
			hasKeys,
		};
		const passContext = {
			...context,
			bindings,
			scope: scoped ?? context.scope,
		};
		const looped =
			context.top && !context.inLoop && waitsIn(statement.body)
				? this.#loopFunction(statement, passContext, loop)
				: null;
		const body = looped
			? []
			: this.#body(statement.body, { ...passContext, inLoop: true });
		const alternate = statement.alternate
			? this.#body(statement.alternate, context)
			: [];
		const range = looped ? null : literalRange(statement.iterable);
		if (range) {
			return this.#rangeLoop(statement, context, loop, range, body, alternate);
		}
		const passes = looped
			? this.#wait(
					span,
					`${looped}(run, ${context.scope}, out, ${values}, ${length}, 0${hasKeys ? `, ${keys}` : ""})`,
					context.top,
				)
			: [
					`for (let ${index} = 0; ${index} < ${length}; ${index}++) {`,
					...indent(this.#pass(loop, true)),
					...indent(body),
					`\tif (s.length > ${FLUSH_AT}) {`,
					`\t\twrite(run, out, s, ${span});`,
					'\t\ts = "";',
					"\t}",
					"}",
				];
		return [
			this.#loopStep(span),
			...this.#value(statement.iterable, context, iterable),
			// Arrays, the usual case, need no conversion unless the loop wants keys.
			...(hasKeys
				? [
						`const ${items} = loopItems(run, ${span}, ${iterable}, true);`,
						`const ${values} = ${items}.values;`,
					]
				: [
						`const ${values} = Array.isArray(${iterable}) ? ${iterable} : loopItems(run, ${span}, ${iterable}, false).values;`,
					]),
			`const ${length} = ${values}.length;`,
			`if (${length} === 0) {`,
			...indent(alternate),
			"} else {",
			...(hasKeys ? [`\tconst ${keys} = ${items}.keys;`] : []),
			...indent(passes),
			"}",
			// Variables the body set may live outside the loop, so later lookups start again.
			...sets.flatMap((name) => this.#forget(name)),
		];
	}

	/**
	 * A loop over a range of integer literals, such as `1..5`, counts instead of making the array. It charges the
	 * range's steps and checks its length as `range` does.
	 */
	#rangeLoop(
		statement: Extract<Statement, { type: "For" }>,
		context: Context,
		loop: LoopNames,
		range: { from: number; to: number },
		body: string[],
		alternate: string[],
	): string[] {
		const node = statement.iterable as Extract<Expression, { type: "Binary" }>;
		const rangeSpan = this.#span(node.span);
		const count = Math.abs(range.to - range.from) + 1;
		const direction = range.to < range.from ? "-" : "+";
		const { span, length, index, value, key, hasKeys } = loop;
		return [
			this.#loopStep(span),
			`const ${length} = ${count};`,
			`if (${length} > maxSteps) rangeLimit(run, ${rangeSpan}, ${length});`,
			`if ((steps += ${length}) > maxSteps) stepLimit(run, ${rangeSpan});`,
			...(alternate.length > 0
				? [`if (${length} === 0) {`, ...indent(alternate), "}"]
				: []),
			`for (let ${index} = 0; ${index} < ${length}; ${index}++) {`,
			`\t${this.#loopStep(span)}`,
			...(loop.scope
				? [
						`\tconst ${loop.scope} = childScope(${loop.outer});`,
						...indent(loop.sets.flatMap((name) => this.#forget(name))),
					]
				: []),
			`\tconst ${value} = ${range.from} ${direction} ${index};`,
			...(this.#plainUsed.has(`p${value}`)
				? [`\tconst p${value} = false;`]
				: []),
			...(hasKeys ? [`\tconst ${key} = ${index};`] : []),
			...(hasKeys && this.#plainUsed.has(`p${key}`)
				? [`\tconst p${key} = false;`]
				: []),
			...indent(body),
			`\tif (s.length > ${FLUSH_AT}) {`,
			`\t\twrite(run, out, s, ${span});`,
			'\t\ts = "";',
			"\t}",
			"}",
			...loop.sets.flatMap((name) => this.#forget(name)),
		];
	}

	/** The start of a loop pass: counts a step, unless continuing one, and binds the loop's variables. */
	#pass(loop: LoopNames, counts: boolean): string[] {
		const { span, values, index, value, key, keys, hasKeys } = loop;
		const proto = `q${loop.id}`;
		return [
			...(counts ? [this.#loopStep(span)] : []),
			...(loop.scope
				? [
						`const ${loop.scope} = childScope(${loop.outer});`,
						...loop.sets.flatMap((name) => this.#forget(name)),
					]
				: []),
			`const ${value} = ${values}[${index}] ?? null;`,
			...(this.#plainUsed.has(`p${value}`)
				? [
						`let ${proto};`,
						`const p${value} = typeof ${value} === "object" && ${value} !== null && ((${proto} = getPrototypeOf(${value})) === objectPrototype || ${proto} === null);`,
					]
				: []),
			...(hasKeys
				? [`const ${key} = ${keys} ? (${keys}[${index}] ?? null) : ${index};`]
				: []),
			...(hasKeys && this.#plainUsed.has(`p${key}`)
				? [`const p${key} = ${isPlainCode(key)};`]
				: []),
		];
	}

	/**
	 * A loop at the top of a run whose passes may wait, such as one that includes a template, as plain functions
	 * rather than a generator, which V8 runs more slowly. The loop is a function of its items and the index to start
	 * at. A pass that gets a promise continues in a function for the rest of that pass, which then calls the loop for
	 * the next index. Returns the loop function's name, or null when a pass may wait somewhere a function can't
	 * continue from, such as in a nested loop.
	 */
	#loopFunction(
		statement: Extract<Statement, { type: "For" }>,
		context: Context,
		loop: LoopNames,
	): string | null {
		const outer = this.#fn;
		const restore = this.#snapshot();
		this.#fn = newFunction();
		try {
			const inner: Context = { ...context, inLoop: true, top: true };
			const groups = statement.body.map((child) =>
				this.#setFlags(this.#statement(child, inner)),
			);
			if (!this.#fn.waits || this.#fn.waitsInside) {
				restore();
				return null;
			}
			const segments: string[][] = [[]];
			for (const group of groups) {
				(segments.at(-1) as string[]).push(...group);
				if (group.some((line) => WAIT_LINE.test(line))) segments.push([]);
			}
			const name = `L${this.#generators++}`;
			const params = `run, scope, out, ${loop.values}, ${loop.length}, ${loop.index}${loop.hasKeys ? `, ${loop.keys}` : ""}`;
			const call = (part: number, index: string) =>
				`${name}${part === 0 ? "" : `_${part}`}(run, scope, out, ${loop.values}, ${loop.length}, ${index}${loop.hasKeys ? `, ${loop.keys}` : ""})`;
			// Each wait continues the pass in the function for the segments after it.
			const continued = (from: number) =>
				segments
					.slice(from)
					.flatMap((lines, offset) =>
						lines.map((line) =>
							line.replace(
								WAIT_LINE,
								(_, tabs: string, result: string) =>
									`${tabs}if (${result} !== undefined) return ${result}.then(() => ${call(from + offset + 1, loop.index)});`,
							),
						),
					);
			const start = this.#start();
			const end = ["state.steps = steps;", `write(run, out, s, ${loop.span});`];
			this.#declarations.push(
				`function ${name}(${params}) {`,
				...indent([
					...start,
					`for (; ${loop.index} < ${loop.length}; ${loop.index}++) {`,
					...indent(this.#pass(loop, true)),
					...indent(continued(0)),
					`\tif (s.length > ${FLUSH_AT}) {`,
					`\t\twrite(run, out, s, ${loop.span});`,
					'\t\ts = "";',
					"\t}",
					"}",
					...end,
				]),
				"}",
			);
			for (let part = 1; part < segments.length; part++) {
				this.#declarations.push(
					`function ${name}_${part}(${params}) {`,
					...indent([
						...start,
						...this.#pass(loop, false),
						...continued(part),
						...end,
						`return ${call(0, `${loop.index} + 1`)};`,
					]),
					"}",
				);
			}
			return name;
		} finally {
			this.#fn = outer;
		}
	}

	/**
	 * `set`, through the closures' `assign`, so it finds the variable's scope as they do. Loop variables are locals in
	 * generated code, so setting one stays with the closures.
	 */
	#set(
		statement: Extract<Statement, { type: "Set" }>,
		context: Context,
	): string[] {
		if (context.bindings.has(statement.name)) return unsupported();
		const span = this.#span(statement.span);
		const value = this.#temp();
		return [
			`${this.#step(span)};`,
			...this.#value(statement.value, context, value),
			`assign(run, ${context.scope}, ${JSON.stringify(statement.name)}, ${value}, ${span});`,
			...this.#forget(statement.name),
		];
	}

	/** Forgets lookups of a variable that `set` may have changed. */
	#forget(name: string): string[] {
		return ["plain", "guarded"].flatMap((kind) => {
			const cached = this.#fn.variables.get(`${kind}:${name}`);
			return cached ? [`${cached.value} = undefined;`] : [];
		});
	}

	/**
	 * Lines that put an expression's value in `target`. A call to one of your functions or filters may return a
	 * promise, so it can only be the whole expression, and the function waits for it as a generator.
	 */
	#value(node: Expression, context: Context, target: string): string[] {
		return (
			this.#hostCall(node, context, target) ?? [
				`${target} = ${this.#expr(node, context, false)};`,
			]
		);
	}

	#hostCall(
		node: Expression,
		context: Context,
		target: string,
	): string[] | null {
		let kind: "function" | "filter";
		let name: string;
		let input: Expression | null = null;
		let args: Argument[];
		if (node.type === "Call" && node.callee.type === "Name") {
			kind = "function";
			name = node.callee.name;
			args = node.args;
			if (this.#macros.has(name)) return null;
		} else if (node.type === "Filter") {
			kind = "filter";
			name = node.name;
			input = node.input;
			args = node.args;
		} else {
			return null;
		}
		const entries = kind === "filter" ? this.#env.filters : this.#env.functions;
		if (entries.get(name)?.kind !== "host") return null;
		if (args.some((arg) => arg.type !== "Positional")) return unsupported();
		const fn = this.#constant(
			`host:${kind}:${name}`,
			"X",
			`rt.host(${JSON.stringify(kind)}, ${JSON.stringify(name)})`,
		);
		const span = this.#span(node.span);
		const values = [
			...(input ? [this.#expr(input, context, false)] : []),
			...args.map((arg) => this.#expr(arg.value, context, false)),
		];
		this.#fn.waits = true;
		this.#fn.waitsInside = true;
		return [
			`${this.#step(span)};`,
			"state.steps = steps;",
			`${target} = callHost(run, ${span}, ${fn}, [${values.join(", ")}]);`,
			`if (${target} instanceof Promise) {`,
			// The text so far goes out first, so a streamed render can send it while this waits.
			`\twrite(run, out, s, ${span});`,
			'\ts = "";',
			"\ttry {",
			`\t\t${target} = yield ${target};`,
			"\t} catch (error) {",
			`\t\tthrow hostError(run, ${span}, ${fn}, error);`,
			"\t}",
			"}",
			"steps = state.steps;",
		];
	}

	/**
	 * `props` without types: checks no undeclared names were passed in strict mode, then fills in defaults and nulls.
	 * Typed props and rest props stay with the closures.
	 */
	#props(
		statement: Extract<Statement, { type: "Props" }>,
		context: Context,
	): string[] {
		if (statement.rest || statement.props.some((prop) => prop.type)) {
			return unsupported();
		}
		const span = this.#span(statement.span);
		const names = statement.props.map((prop) => prop.name);
		const declared = this.#constant(
			`props:${JSON.stringify(names)}`,
			"P",
			`rt.declared(${JSON.stringify(names)})`,
		);
		const lines = [`checkPassed(run, ${span}, ${declared});`];
		for (const prop of statement.props) {
			const key = JSON.stringify(prop.name);
			const has = this.#temp();
			const current = this.#temp();
			const fill = prop.default
				? `scope[${key}] = (${this.#expr(prop.default, context, false)}) ?? null;`
				: `if (!${has}) scope[${key}] = missingProp(run, ${span}, ${key});`;
			// The prop is now set in this scope, so it seeds the lookup later reads use, unless it holds a function,
			// which a read must refuse. A default may have looked the prop up before it was set.
			const cached = this.#cached(prop.name, false);
			const guarded = this.#fn.variables.get(`guarded:${prop.name}`);
			lines.push(
				`${has} = hasOwn(scope, ${key});`,
				`${current} = ${has} ? scope[${key}] : undefined;`,
				`if (${current} === undefined || ${current} === null) {`,
				`\t${fill}`,
				`\t${current} = scope[${key}];`,
				"}",
				`${cached.value} = typeof ${current} === "function" ? undefined : ${current}${setPlain(cached.plain, current)};`,
				...(guarded ? [`${guarded.value} = undefined;`] : []),
			);
		}
		return lines;
	}

	#include(
		statement: Extract<Statement, { type: "Include" }>,
		context: Context,
	): string[] {
		const span = this.#span(statement.span);
		const target = this.#target(statement.template, statement.with, context);
		const variables = this.#variables(statement.with, context);
		return [
			`${this.#step(span)};`,
			...target.lines,
			...variables.lines,
			...this.#wait(
				span,
				this.#place(
					statement.indent,
					variables.embed(span, target.name, "null", statement.ignoreMissing),
				),
				context.top,
			),
		];
	}

	/**
	 * An include's or component's template name. `"prefix" ~ key`, with a known `with` hash, keeps the key apart, so
	 * `embedKeyed` can find the template without building the name; a key that isn't a string is joined as usual.
	 */
	#target(
		node: Expression,
		withNode: Expression | null,
		context: Context,
	): { lines: string[]; name: TemplateTarget } {
		if (
			isKnownWith(withNode) &&
			node.type === "Binary" &&
			node.operator === "~" &&
			node.left.type === "Literal" &&
			typeof node.left.value === "string"
		) {
			const prefix = node.left.value;
			const key = this.#temp();
			const joined = this.#temp();
			const nameSpan = this.#span(node.span);
			return {
				lines: [
					`${key} = ${this.#expr(node.right, context, false)};`,
					`${joined} = typeof ${key} === "string" ? null : concat(run, ${nameSpan}, ${JSON.stringify(prefix)}, ${key});`,
				],
				name: { kind: "keyed", prefix, key, joined, nameSpan },
			};
		}
		const js = this.#temp();
		return {
			lines: [`${js} = ${this.#expr(node, context, false)};`],
			name: { kind: "value", js },
		};
	}

	/**
	 * An include's or component's `with` value. A hash of known keys, or none, becomes the template's scope here, so
	 * no hash is made and copied; anything else is passed to `embed`, which checks and copies it.
	 */
	#variables(
		node: Expression | null,
		context: Context,
	): {
		lines: string[];
		embed: (
			span: string,
			name: TemplateTarget,
			slots: string,
			ignoreMissing: boolean,
		) => string;
	} {
		if (node !== null && !isKnownWith(node)) {
			const value = this.#temp();
			return {
				lines: [`${value} = ${this.#expr(node, context, false)};`],
				embed: (span, name, slots, ignoreMissing) =>
					`embed(run, out, ${span}, ${(name as { js: string }).js}, ${value}, ${slots}, ${ignoreMissing})`,
			};
		}
		const scope = this.#temp();
		const lines = [`${scope} = childScope(state.globals);`];
		const keys: string[] = [];
		for (const entry of node?.type === "Hash" ? node.entries : []) {
			if (entry.type !== "Property") return unsupported();
			const key = String((entry.key as { value: unknown }).value);
			if (!keys.includes(key)) keys.push(key);
			lines.push(
				`${scope}[${JSON.stringify(key)}] = (${this.#expr(entry.value, context, false)}) ?? null;`,
			);
		}
		const passed = this.#constant(
			`passed:${JSON.stringify(keys)}`,
			"P",
			`Object.freeze(${JSON.stringify(keys)})`,
		);
		return {
			lines,
			embed: (span, name, slots, ignoreMissing) => {
				const rest = `${scope}, ${passed}, ${slots}, ${ignoreMissing})`;
				return name.kind === "keyed"
					? `(${name.joined} === null ? embedKeyed(run, out, ${span}, ${JSON.stringify(name.prefix)}, ${name.key}, ${name.nameSpan}, ${rest} : embedScope(run, out, ${span}, ${name.joined}, ${rest})`
					: `embedScope(run, out, ${span}, ${name.js}, ${rest}`;
			},
		};
	}

	/** A component. Its fills become functions here, so they can read the loops around them. */
	#component(
		statement: Extract<Statement, { type: "Component" }>,
		context: Context,
	): string[] {
		const span = this.#span(statement.span);
		const fills = statement.fills.map((fill) => ({
			name: fill.name,
			body: fill.body,
		}));
		if (statement.body.some((child) => !isBlank(child))) {
			fills.push({ name: DEFAULT_SLOT, body: statement.body });
		}
		const slots = this.#temp();
		const target = this.#target(statement.template, statement.with, context);
		const variables = this.#variables(statement.with, context);
		return [
			`${this.#step(span)};`,
			...target.lines,
			...variables.lines,
			`${slots} = new Map();`,
			...fills.map(
				(fill) =>
					`${slots}.set(${JSON.stringify(fill.name)}, { body: ${this.#nested(fill.body, statement.span, context)}, run, scope: ${context.scope}, sets: ${setsIn(fill.body).size > 0} });`,
			),
			...this.#wait(
				span,
				this.#place(
					statement.indent,
					variables.embed(span, target.name, slots, false),
				),
				context.top,
			),
		];
	}

	/** A slot: the caller's fill, or the fallback. */
	#slot(
		statement: Extract<Statement, { type: "Slot" }>,
		context: Context,
	): string[] {
		const span = this.#span(statement.span);
		const fill = this.#temp();
		const at = statement.indent;
		let fallback = this.#body(statement.body, context);
		if (at !== "" && !statement.body.every(isBlank)) {
			// The fallback's text reads a new `ind`, inside a block of its own.
			const [saved, inline] = [this.#temp(), this.#temp()];
			fallback = [
				`${saved} = out.indent;`,
				`${inline} = out.inline;`,
				`startPlace(out, ${this.#at(at)});`,
				"{",
				...indent(["const ind = out.indent;", ...fallback]),
				"}",
				`out.indent = ${saved};`,
				`if (out.inline) out.inline = ${inline};`,
			];
		}
		return [
			`${fill} = run.slots === null ? undefined : run.slots.get(${JSON.stringify(statement.name)});`,
			`if (${fill} !== undefined) {`,
			...indent(
				this.#wait(
					span,
					this.#place(at, `fillSlot(run, ${span}, ${fill}, out)`),
					context.top,
				),
			),
			"} else {",
			...indent(fallback),
			"}",
		];
	}

	/**
	 * Places a block. The closure compiler keeps the block's definition, so its body is searched for runs separately.
	 * Blocks inside generated loops stay with the closures, since a block can read the loop it is placed in.
	 */
	#block(
		statement: Extract<Statement, { type: "Block" }>,
		context: Context,
	): string[] {
		if (context.inLoop) return unsupported();
		this.#pending.push([statement.body, context.strategy]);
		const span = this.#span(statement.span);
		return this.#wait(
			span,
			this.#place(
				statement.indent,
				`placeBlock(run, ${span}, ${JSON.stringify(statement.name)}, ${context.scope}, out)`,
			),
			context.top,
		);
	}

	// Expressions

	/** Writes an expression. `guard` is set where a missing variable or property is allowed; see `MISSING`. */
	#expr(node: Expression, context: Context, guard: boolean): string {
		if (++this.#depth > MAX_DEPTH) return unsupported();
		try {
			return this.#expression(node, context, guard);
		} finally {
			this.#depth--;
		}
	}

	#expression(node: Expression, context: Context, guard: boolean): string {
		switch (node.type) {
			case "Literal":
				return literal(node.value);
			case "Name":
				return this.#name(node.name, node.span, context, guard);
			case "Member":
				return this.#member(node, context, guard);
			case "OptionalChain": {
				const value = this.#temp();
				const inner = this.#expr(node.expression, context, true);
				return `(${value} = ${inner}, ${value} === SHORT || ${value} === MISSING ? ${guard ? "MISSING" : "null"} : ${value})`;
			}
			case "Unary":
				return this.#unary(node, context);
			case "Binary":
				return this.#binary(node, context);
			case "Conditional": {
				const test = this.#condition(node.test, context);
				const yes = this.#expr(node.consequent, context, false);
				const no = node.alternate
					? this.#expr(node.alternate, context, false)
					: "null";
				return `(${test} ? ${yes} : ${no})`;
			}
			case "Filter":
				return this.#filter(node, context);
			case "Test":
				return this.#test(node, context);
			case "Call":
				return this.#call(node, context);
			case "Array":
				return `[${node.elements
					.map((element) =>
						element.type === "Spread"
							? unsupported()
							: this.#expr(element, context, false),
					)
					.join(", ")}]`;
			case "Hash":
				return `{ ${node.entries
					.map((entry) => {
						if (entry.type === "Spread" || entry.key.type !== "Literal") {
							return unsupported();
						}
						const key = String(entry.key.value);
						if (key === "__proto__") return unsupported();
						return `${JSON.stringify(key)}: ${this.#expr(entry.value, context, false)}`;
					})
					.join(", ")} }`;
			case "Interpolation": {
				const span = this.#span(node.span);
				const parts = node.parts.map((part) => {
					const value = this.#temp();
					return { value, code: this.#expr(part, context, false) };
				});
				const assigned = parts.map(({ value, code }) => `${value} = ${code}`);
				const joined = parts
					.map(({ value }) => `str(run, ${span}, ${value})`)
					.join(" + ");
				return `(${[...assigned, `joined(run, ${span}, ${joined || '""'})`].join(", ")})`;
			}
			default:
				return unsupported();
		}
	}

	#name(name: string, at: Span, context: Context, guard: boolean): string {
		const binding = context.bindings.get(name);
		const span = this.#span(at);
		if (binding?.kind === "value") {
			const js = binding.js;
			return `(typeof ${js} === "function" ? checkValue(run, ${span}, ${js}, ${JSON.stringify(name)}) : ${js})`;
		}
		if (binding?.kind === "loop") {
			return `loop(${binding.index}, ${binding.length})`;
		}
		// A missing variable still fails where it is first used, as nothing is stored until a lookup succeeds.
		const { value, plain } = this.#cached(name, guard);
		return `(${value} !== undefined ? ${value} : (${value} = ${guard ? "guardedName" : "name"}(run, ${span}, ${context.scope}, ${JSON.stringify(name)})${setPlain(plain, value)}, ${value}))`;
	}

	#cached(name: string, guard: boolean): Cached {
		const key = `${guard ? "guarded" : "plain"}:${name}`;
		let cached = this.#fn.variables.get(key);
		if (cached === undefined) {
			const index = this.#fn.variables.size;
			cached = { value: `${guard ? "g" : "c"}${index}`, plain: `f${index}` };
			this.#fn.variables.set(key, cached);
		}
		return cached;
	}

	#member(
		node: Extract<Expression, { type: "Member" }>,
		context: Context,
		guard: boolean,
	): string {
		const span = this.#span(node.span);
		const { object, property, optional } = node;
		const flags = `${optional}, ${guard}`;
		if (property.type !== "Literal") {
			const target = this.#expr(object, context, guard);
			const key = this.#expr(property, context, false);
			return `readMember(run, ${span}, ${target}, ${key}, ${flags})`;
		}
		const key = property.value;
		// `loop.index` and the rest read the loop's counter.
		if (object.type === "Name" && typeof key === "string") {
			const binding = context.bindings.get(object.name);
			const field = LOOP_FIELDS[key];
			if (
				binding?.kind === "loop" &&
				field &&
				Object.hasOwn(LOOP_FIELDS, key)
			) {
				return field(binding.index, binding.length);
			}
		}
		if (typeof key !== "string" || BLOCKED_NAMES.has(key)) {
			const target = this.#expr(object, context, guard);
			return `readMember(run, ${span}, ${target}, ${literal(key)}, ${flags})`;
		}
		// Own properties of plain objects are read inline, through a property access V8 caches for this one place. A value
		// can only be inherited if it is the one `Object.prototype` holds, so only then is the property checked to be own.
		const value = this.#temp();
		const item = this.#temp();
		const read = access(key);
		const known = this.#plainObject(object, context, guard, value);
		return [
			`(${known.target}, ${known.plain}`,
			`&& (${item} = ${value}${read}) !== undefined && typeof ${item} !== "function"`,
			`&& (${item} !== objectPrototype${read} || hasOwn(${value}, ${JSON.stringify(key)}))`,
			`? ${item} : readMember(run, ${span}, ${known.slow}, ${JSON.stringify(key)}, ${flags}))`,
		].join(" ");
	}

	/**
	 * The object a property is read from, put in `value`, and a check that it is a plain object. Variables already
	 * know: a loop variable is checked once per pass, and a variable from outside once per run. `slow` is the object
	 * for `readMember`, checked as a variable would be when it is a loop variable holding a function.
	 */
	#plainObject(
		object: Expression,
		context: Context,
		guard: boolean,
		value: string,
	): { target: string; plain: string; slow: string } {
		if (object.type === "Name") {
			const binding = context.bindings.get(object.name);
			if (binding?.kind === "value") {
				this.#plainUsed.add(binding.plain);
				const span = this.#span(object.span);
				return {
					target: `${value} = ${binding.js}`,
					plain: binding.plain,
					slow: `(typeof ${value} === "function" ? checkValue(run, ${span}, ${value}, ${JSON.stringify(object.name)}) : ${value})`,
				};
			}
			if (binding === undefined) {
				const target = this.#name(object.name, object.span, context, guard);
				const { plain } = this.#cached(object.name, guard);
				this.#fn.plainUsed.add(plain);
				return { target: `${value} = ${target}`, plain, slow: value };
			}
		}
		const target = this.#expr(object, context, guard);
		return {
			target: `${value} = ${target}`,
			plain: isPlainCode(value),
			slow: value,
		};
	}

	/** An expression as a JavaScript boolean, without `truthy` when it is one already, such as a comparison. */
	#condition(node: Expression, context: Context): string {
		const code = this.#expr(node, context, false);
		return isBoolean(node, context) ? code : `truthy(${code})`;
	}

	#unary(
		node: Extract<Expression, { type: "Unary" }>,
		context: Context,
	): string {
		if (node.operator === "not")
			return `!${this.#condition(node.operand, context)}`;
		const operand = this.#expr(node.operand, context, false);
		const span = this.#span(node.span);
		const value = this.#temp();
		const number = `toNumber(run, ${span}, ${value}, ${JSON.stringify(node.operator)})`;
		return node.operator === "-"
			? `(${value} = ${operand}, typeof ${value} === "number" ? -${value} : -${number})`
			: `(${value} = ${operand}, typeof ${value} === "number" ? ${value} : ${number})`;
	}

	#binary(
		node: Extract<Expression, { type: "Binary" }>,
		context: Context,
	): string {
		const { operator } = node;
		switch (operator) {
			case "and":
				return `(${this.#condition(node.left, context)} ? ${this.#condition(node.right, context)} : false)`;
			case "or":
				return `(${this.#condition(node.left, context)} ? true : ${this.#condition(node.right, context)})`;
			case "??": {
				const value = this.#temp();
				const left = this.#expr(node.left, context, true);
				const right = this.#expr(node.right, context, false);
				return `(${value} = ${left}, ${value} === MISSING || ${value} === null || ${value} === undefined ? ${right} : ${value})`;
			}
			case "?:": {
				const value = this.#temp();
				const left = this.#expr(node.left, context, false);
				const right = this.#expr(node.right, context, false);
				return `(${value} = ${left}, truthy(${value}) ? ${value} : ${right})`;
			}
		}
		const span = this.#span(node.span);
		const left = this.#expr(node.left, context, false);
		const right = this.#expr(node.right, context, false);
		switch (operator) {
			case "..":
				return this.#counted(`range(run, ${span}, ${left}, ${right})`);
			case "~": {
				// Two strings join here when the result fits the output limit; anything else goes to `concat`.
				const a = this.#temp();
				const b = this.#temp();
				return `(${a} = ${left}, ${b} = ${right}, typeof ${a} === "string" && typeof ${b} === "string" && ${a}.length + ${b}.length <= state.maxSize ? ${a} + ${b} : concat(run, ${span}, ${a}, ${b}))`;
			}
			case "==":
				return `equals(${left}, ${right})`;
			case "!=":
				return `!equals(${left}, ${right})`;
		}
		const apply = this.#constant(
			`operator:${operator}`,
			"O",
			`rt.operator(${JSON.stringify(operator)})`,
		);
		if (!NUMBER_OPERATORS.has(operator)) {
			return `binary(run, ${span}, ${apply}, ${left}, ${right})`;
		}
		const a = this.#temp();
		const b = this.#temp();
		return `(${a} = ${left}, ${b} = ${right}, typeof ${a} === "number" && typeof ${b} === "number" ? ${a} ${operator} ${b} : binary(run, ${span}, ${apply}, ${a}, ${b}))`;
	}

	#filter(
		node: Extract<Expression, { type: "Filter" }>,
		context: Context,
	): string {
		const { name, args } = node;
		const span = this.#span(node.span);
		const strategy = context.strategy || "html";
		if (name === "default") {
			const value = this.#temp();
			const input = this.#expr(node.input, context, true);
			const fallback = args[0]
				? this.#expr(args[0].value, context, false)
				: '""';
			return `(${value} = ${input}, ${value} === MISSING || isEmpty(${value}) ? ${fallback} : ${value})`;
		}
		const input = this.#expr(node.input, context, false);
		if (name === "raw") {
			return `raw(run, ${span}, ${input}, ${JSON.stringify(strategy)})`;
		}
		if (name === "escape") {
			const chosen = args[0] ? args[0].value : null;
			const target =
				chosen === null
					? "html"
					: chosen.type === "Literal" &&
						  ESCAPE_STRATEGIES.includes(chosen.value as EscapeStrategy)
						? (chosen.value as EscapeStrategy)
						: unsupported();
			return `escape(run, ${span}, ${input}, ${JSON.stringify(target)})`;
		}
		const call = this.#builtin("filter", name, args);
		return this.#invoke(span, call.fn, [
			input,
			...this.#arguments(call, context),
		]);
	}

	#test(node: Extract<Expression, { type: "Test" }>, context: Context): string {
		const { name, negated, input } = node;
		if (name === "defined") {
			if (
				input.type === "Call" &&
				input.callee.type === "Name" &&
				input.callee.name === "block"
			) {
				return unsupported();
			}
			const value = this.#expr(input, context, true);
			return `(${value} ${negated ? "===" : "!=="} MISSING)`;
		}
		const span = this.#span(node.span);
		const call = this.#builtin("test", name, node.args);
		const value = this.#invoke(span, call.fn, [
			this.#expr(input, context, false),
			...this.#arguments(call, context),
		]);
		return `${negated ? "!" : ""}truthy(${value})`;
	}

	#call(node: Extract<Expression, { type: "Call" }>, context: Context): string {
		const callee = node.callee;
		if (
			callee.type !== "Name" ||
			callee.name === "parent" ||
			callee.name === "block" ||
			this.#macros.has(callee.name)
		) {
			return unsupported();
		}
		const span = this.#span(node.span);
		const call = this.#builtin("function", callee.name, node.args);
		return this.#invoke(span, call.fn, this.#arguments(call, context));
	}

	/** A built-in, with its arguments in parameter order. Host functions may return promises, so they stay with the closures. */
	#builtin(
		kind: "filter" | "test" | "function",
		name: string,
		args: Argument[],
	): { fn: string; args: (Argument | null)[]; options: number } {
		const entries =
			kind === "filter"
				? this.#env.filters
				: kind === "test"
					? this.#env.tests
					: this.#env.functions;
		const entry = entries.get(name);
		if (entry?.kind !== "builtin") return unsupported();
		const placed = placeArguments(entry, args, name, unsupported);
		if (placed.some((arg) => arg?.type === "Spread")) return unsupported();
		const lookup = kind === "function" ? "fn" : kind;
		const fn = this.#constant(
			`${kind}:${name}`,
			kind === "filter" ? "F" : kind === "test" ? "T" : "B",
			`rt.${lookup}(${JSON.stringify(name)})`,
		);
		return {
			fn,
			args: placed,
			options: entry.options ? (entry.params?.length ?? 0) : -1,
		};
	}

	/** Arguments in order. A built-in's options hash of literals is made once, frozen, so formatters can cache by it. */
	#arguments(
		call: { args: (Argument | null)[]; options: number },
		context: Context,
	): string[] {
		return call.args.map((arg, index) => {
			if (!arg) return "undefined";
			const value = arg.value;
			if (index === call.options && value.type === "Hash") {
				const frozen = this.#frozenHash(value);
				if (frozen) return frozen;
			}
			return this.#expr(value, context, false);
		});
	}

	#frozenHash(node: Extract<Expression, { type: "Hash" }>): string | null {
		const entries: string[] = [];
		for (const entry of node.entries) {
			if (entry.type !== "Property" || entry.key.type !== "Literal")
				return null;
			if (entry.value.type !== "Literal") return null;
			const key = String(entry.key.value);
			if (key === "__proto__") return null;
			entries.push(`${JSON.stringify(key)}: ${literal(entry.value.value)}`);
		}
		const code = `rt.options({ ${entries.join(", ")} })`;
		return this.#constant(`hash:${code}`, "H", code);
	}

	/** Counts a step, then calls a built-in with errors located at `span`, as `directCall` does. */
	#invoke(span: string, fn: string, args: string[]): string {
		if (args.length > 4) return unsupported();
		return `(${this.#step(span)}, ${this.#counted(`call${args.length}(run, ${span}, ${fn}${args.map((arg) => `, ${arg}`).join("")})`)})`;
	}
}
