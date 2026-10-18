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
import {
	containsNode,
	emitter,
	mayWrite,
	placeArguments,
	setsVariables,
} from "./compiler.js";
import { effectsOf, planOf } from "./effects.js";
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
	/**
	 * At the top level of a loop function's pass, where a call to your function can end the function too, and the
	 * pass continue with its value in the next. See `#loopFunction`.
	 */
	pass: boolean;
	/** The JavaScript name of the scope variables are looked up and set in: the function's, or a loop pass's. */
	scope: string;
};

/** One generated function: a run, or a component's fill. */
type FunctionState = {
	/** Temporaries it declares. */
	temps: number;
	/**
	 * Variables from outside generated code, each looked up once. Code that may change a variable, such as `set`, a
	 * block or a component's fills, forgets the lookups it may have changed.
	 */
	variables: Map<string, Cached>;
	/** Plain-object flags of variables that property reads use. Only these are set; see `PLAIN`. */
	plainUsed: Set<string>;
	/** It may wait for a promise. */
	waits: boolean;
	/** It may wait somewhere other than at the end of a top-level statement, such as in a loop, so it is a generator. */
	waitsInside: boolean;
	/** Waits it has somewhere a run can't continue from, such as inside an `if`. See `#list`. */
	inner: number;
	/** Top-level waits that start the rest of the run ahead of them. See `#list`. */
	aheadWaits: number;
	/**
	 * It reads properties inline, where a getter in your data may throw. Each read puts its place in `at`, so the
	 * function can locate the error; see `#guard`.
	 */
	reads: boolean;
};

const newFunction = (): FunctionState => ({
	temps: 0,
	variables: new Map(),
	plainUsed: new Set(),
	waits: false,
	waitsInside: false,
	inner: 0,
	aheadWaits: 0,
	reads: false,
});

/**
 * Stands for a wait in generated lines until `#function` knows whether it yields or continues in a new function.
 *
 * Markers use control characters because `JSON.stringify` escapes them, so text from a template never contains one.
 */
const WAIT = "\u0000wait ";

// oxlint-disable-next-line no-control-regex -- matches the marker, see `WAIT`
const WAIT_LINE = /^(\t*)\u0000wait (t\d+)( ahead| guarded)?$/;

/**
 * Stands for waiting for a call to one of your functions at the top of a loop function's pass, `\u0000value t S X`:
 * the call's result, its span and the function. When the result is a promise, the pass continues in another function
 * with its value. See `#loopFunction`.
 */
const VALUE = "\u0000value ";

// oxlint-disable-next-line no-control-regex -- matches the marker, see `WAIT`
const VALUE_LINE = /^(\t*)\u0000value (t\d+) (S\[\d+\]) (X\d+)$/;

/** Marks a wait whose statement lets the rest of the run start ahead of it, in `WAIT` lines. See `#list`. */
const AHEAD = " ahead";

/** Marks a wait that lets the rest of the run start ahead of it unless the render's blocks or fills set variables. */
const GUARDED = " guarded";

/**
 * Stands for starting the passes after the current one, where a loop that pauses inside its passes is about to wait.
 * `#loopGenerator` writes it out, and other functions drop it.
 */
const FORK = "\u0003fork";

/**
 * Stands for setting a variable's plain-object flag, `\u0001flag:value\u0001`, until `#function` knows whether any
 * property read uses the flag. It becomes `, flag = plain(value)` or nothing.
 */
// oxlint-disable-next-line no-control-regex -- matches the marker, see `WAIT`
const PLAIN = /\u0001(f\d+):([\w$]+)\u0001/g;

/**
 * Stands for forgetting every variable lookup, until the function's lookups are all known: in a loop, a lookup made
 * later in the pass is cached by the next pass too. `#function` writes it out.
 */
const FORGET_ALL = "\u0002forget";

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
	"unhold",
	"restAhead",
	"contentSets",
	"passAhead",
	"startAhead",
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
	"contains",
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
	"readError",
	"blockSets",
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

/** A call to one of your functions or filters. See `#isHostCall`. */
type HostCallNode =
	| (Extract<Expression, { type: "Call" }> & {
			callee: Extract<Expression, { type: "Name" }>;
	  })
	| Extract<Expression, { type: "Filter" }>;

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

/** Lines without `FORK` markers, for functions that never start passes ahead. */
const dropForks = (lines: string[]): string[] =>
	lines.filter((line) => line.trim() !== FORK);

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
	/**
	 * Whether the top-level statement being generated lets the rest of the run start while it waits: `AHEAD`, or
	 * `GUARDED` when only for renders whose blocks and fills set nothing. See `#list`.
	 */
	#forkable: typeof AHEAD | typeof GUARDED | null = null;

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
		this.#list(this.#ast.body, this.#env.autoescape, child, true);
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
	 * `top` is set for the template's top level.
	 */
	#list(
		list: Statement[],
		strategy: EscapeStrategy | false,
		searchOnly: boolean,
		top = false,
	): void {
		const context: Context = {
			bindings: new Map(),
			strategy,
			inLoop: false,
			top: true,
			pass: false,
			scope: "scope",
		};
		// Which statements may start while each waits, as the closures find it. See `planOf`. Runs are cut by the plan
		// for renders whose blocks and fills set nothing, and the closures pick a plan for each render.
		const effects = searchOnly
			? []
			: list.map((statement) => effectsOf([statement], this.#env));
		const plan = planOf(effects, false);
		const strict = planOf(effects, true);
		// Statements a run must end at, so the closures' sequence can start the statements after them early.
		const stops: number[] = [];
		// A layout's blocks get runs of their own. While the page's top-level statements wait, a block waits for them,
		// and the runs between blocks can start; see `Gate`.
		if (top) {
			list.forEach((statement, index) => {
				if (statement.type === "Block") stops.push(index - 1, index);
			});
		}
		const stopFrom = (index: number) =>
			Math.min(list.length - 1, ...stops.filter((stop) => stop >= index));
		let i = 0;
		while (i < list.length) {
			if (searchOnly) {
				this.#children(list[i] as Statement, strategy);
				i++;
				continue;
			}
			this.#fn = newFunction();
			let groups: string[][] = [];
			let end = i;
			let work = false;
			let last = stopFrom(i);
			while (end < list.length) {
				// Text alone goes on into the next run, rather than leave a run with nothing to do before it.
				if (end > last) {
					if (work) break;
					last = stopFrom(end);
				}
				const statement = list[end] as Statement;
				const after = plan.after[end] as number;
				const reach = plan.reach[end] as number;
				const forkable = reach > after;
				// A wait in a run's chain of functions can only start the rest of the run, which must not depend on it.
				// When blocks or fills that set variables would change that, it checks when it waits.
				const chained = forkable && after === end;
				const { inner, aheadWaits } = this.#fn;
				const restore = this.#snapshot();
				this.#forkable = !chained
					? null
					: strict.after[end] === end && (strict.reach[end] as number) >= reach
						? AHEAD
						: GUARDED;
				const generated = this.#attempt(() =>
					this.#statement(statement, context),
				);
				this.#forkable = null;
				if (!generated) break;
				const waitsInside = this.#fn.inner > inner;
				// A run that waits inside a statement is a generator, which can't start the rest of the run while it
				// waits, and a chain can't run statements that depend on a wait before the ones that start early. Then
				// the statement gets a run of its own, and so do the statements that depend on it and the ones that start
				// early, so the closures' sequence can start them. A statement that waits inside after a wait that
				// starts the rest of the run ahead gets a run of its own too, so the chain stays a chain.
				const own = forkable && (waitsInside || !chained || this.#fn.inner > 0);
				if (own || (waitsInside && aheadWaits > 0)) {
					if (end > i && work) {
						restore();
						break;
					}
					groups.push(generated);
					work = true;
					end++;
					if (forkable) stops.push(after, reach);
					break;
				}
				groups.push(generated);
				if (statement.type !== "Text") work = true;
				end++;
				// A wait that starts the rest of the run ahead needs all of it within its reach.
				if (chained) last = Math.min(last, reach);
			}
			if (end === i) {
				this.#children(list[i] as Statement, strategy);
				i++;
				continue;
			}
			if (work) {
				groups = this.#parts(list.slice(i, end), groups);
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
		groups = groups.map((lines) =>
			this.#forgetLines(this.#setFlags(dropForks(lines))),
		);
		// Steps are counted in a local, and `state.steps` kept up to date wherever other code may read or count them.
		const start = this.#start(span);
		const end = ["state.steps = steps;", `write(run, out, s, ${span});`];
		const wrap = (lines: string[]) =>
			indent(lines).map((line) => `\t\t\t${line}`);

		if (!fn.waits) {
			const body = wrap([...start, ...this.#guard([...groups.flat(), ...end])]);
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
				// A wait that lets the rest of the run start ahead runs it in another buffer while it waits.
				const body = lines.map((line) =>
					line.replace(
						WAIT_LINE,
						(_, tabs: string, result: string, ahead?: string) => {
							const then = `${result}.then(() => ${next})`;
							const rest = `restAhead(run, out, ${result}, (run, out) => ${next}, ${span})`;
							return `${tabs}if (${result} !== undefined) return ${
								ahead === AHEAD
									? rest
									: ahead === GUARDED
										? `contentSets(run) ? ${then} : ${rest}`
										: then
							};`;
						},
					),
				);
				// Each function writes its own text, such as a slot's fallback, before the next takes over.
				const last = index === segments.length - 1;
				this.#declarations.push(
					`function ${base}_${index}(run, scope, out) {`,
					...indent([
						...start,
						...this.#guard([
							...body,
							...end,
							...(last ? [] : [`return ${next};`]),
						]),
					]),
					"}",
				);
			});
			return `${base}_0`;
		}

		const body = wrap([
			...start,
			...this.#guard([...groups.flat(), ...end]),
		]).map((line) =>
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

	/** Wraps a function's statements so an error a getter in your data throws is located at the read; see `reads`. */
	#guard(lines: string[]): string[] {
		if (!this.#fn.reads) return lines;
		return [
			"try {",
			...indent(lines),
			"} catch (error) {",
			"\tthrow readError(run, at, error);",
			"}",
		];
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

	/**
	 * Declarations at the start of a generated function: steps are counted in a local, see `#function`, and `b` marks
	 * where the current run of text and outputs starts in `s`, see `#parts`. Checks the abort signal too, since a
	 * function may continue a run after a wait.
	 */
	#start(span: string): string[] {
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
			"const maxSize = state.maxSize;",
			"let steps = state.steps;",
			"const signal = state.signal;",
			`signal !== undefined && signal.aborted && aborted(run, ${span});`,
			'let s = "";',
			`let ${["q", "b", ...declared].join(", ")};`,
			...(fn.reads ? ["let at = null;"] : []),
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
			case "Island":
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

	/**
	 * Counts a step and checks the abort signal, as `step` does: in loops, so a long render stops soon after an abort,
	 * and before calls to your functions and filters.
	 */
	#checkedStep(span: string): string {
		return `${this.#step(span)}; signal !== undefined && signal.aborted && aborted(run, ${span});`;
	}

	/** Calls something that may read or count steps, with `state.steps` up to date around it. */
	#counted(call: string): string {
		const result = this.#temp();
		return `(state.steps = steps, ${result} = ${call}, steps = state.steps, ${result})`;
	}

	/**
	 * Writes the text so far, runs something that writes to `out` and may return a promise, and waits for it. `top`
	 * is set when the wait ends a top-level statement. A wait that continues in a new function is checked for an abort
	 * by `#start`, and one in a generator after it resumes.
	 */
	#wait(span: string, call: string, top: boolean): string[] {
		this.#fn.waits = true;
		if (!top) {
			this.#fn.waitsInside = true;
			this.#fn.inner++;
		}
		const result = this.#temp();
		const ahead = top ? this.#forkable : null;
		if (ahead !== null) this.#fn.aheadWaits++;
		return [
			`write(run, out, s, ${span});`,
			's = "";',
			"state.steps = steps;",
			`${result} = ${call};`,
			`${WAIT}${result}${ahead ?? ""}`,
			"steps = state.steps;",
			`signal !== undefined && signal.aborted && aborted(run, ${span});`,
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
				return [`s += ${JSON.stringify(statement.value)};`];
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
			// Exports never run in a render.
			case "Export":
				return [];
			default:
				return unsupported();
		}
	}

	/** Statements inside another, such as a loop's body. */
	#body(list: Statement[], context: Context): string[] {
		const inner = { ...context, top: false, pass: false };
		return this.#parts(
			list,
			list.map((statement) => this.#statement(statement, inner)),
		).flat();
	}

	/**
	 * Checks the output limit where the closures do, given a list's statements and their lines. The closures print each
	 * run of text and outputs as one string, see `printParts`: an output fails when that string alone is too long, and
	 * the run fails when writing it makes the output too long, located at its start. Generated code gathers text in
	 * `s` for longer, so it marks where each run starts in `b`, and checks the whole output after each run.
	 */
	#parts(list: Statement[], groups: string[][]): string[][] {
		const isPart = (statement: Statement) =>
			statement.type === "Text" ||
			(statement.type === "Output" && !this.#isHostCall(statement.expression));
		const result: string[][] = [];
		let i = 0;
		while (i < list.length) {
			if (!isPart(list[i] as Statement)) {
				result.push(groups[i] as string[]);
				i++;
				continue;
			}
			let end = i;
			while (end < list.length && isPart(list[end] as Statement)) end++;
			const run = groups.slice(i, end);
			// Only outputs read where the run starts.
			if (list.slice(i, end).some((statement) => statement.type === "Output")) {
				run[0] = ["b = s.length;", ...(run[0] as string[])];
			}
			const at = this.#span((list[i] as Statement).span);
			const last = run.length - 1;
			run[last] = [
				...(run[last] as string[]),
				`if (out.s.length + s.length > maxSize) write(run, out, s, ${at});`,
			];
			result.push(...run);
			i = end;
		}
		return result;
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
		// Values can be long, so stop at the output limit before they make a string too long for JavaScript. An output in
		// a run of text and outputs checks the run's text, and a call to one of your functions, which the closures write
		// on its own, checks the whole output. See `#parts`.
		const limit = this.#isHostCall(expression)
			? `if (out.s.length + s.length > maxSize) write(run, out, s, ${span});`
			: `if (s.length - b > maxSize) write(run, out, s, ${span});`;
		if (expression.type === "Literal") {
			return [step, `s += ${emitted(expression.value)};`, limit];
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
		// Strings and numbers print in place. Numbers need no escaping in HTML.
		const print =
			strategy === "html"
				? `typeof ${value} === "string" ? escapeHtml(${value}) : typeof ${value} === "number" ? String(${value}) : print(run, ${span}, ${value}, "html")`
				: strategy === false
					? `typeof ${value} === "string" ? ${value} : typeof ${value} === "number" ? String(${value}) : print(run, ${span}, ${value}, "none")`
					: `print(run, ${span}, ${value}, ${JSON.stringify(strategy)})`;
		return [step, ...code, `s += ${print};`, limit];
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
			context.top &&
			!context.inLoop &&
			effectsOf(statement.body, this.#env).waits
				? this.#loopFunction(statement, passContext, loop)
				: null;
		const range = looped ? null : literalRange(statement.iterable);
		const paused =
			looped || range
				? null
				: this.#loopGenerator(statement, passContext, loop);
		const body =
			looped || paused
				? []
				: this.#body(statement.body, { ...passContext, inLoop: true });
		const alternate = statement.alternate
			? this.#body(statement.alternate, context)
			: [];
		if (range) {
			return this.#rangeLoop(statement, context, loop, range, body, alternate);
		}
		const passes = looped
			? this.#wait(
					span,
					`${looped}(run, ${context.scope}, out, ${values}, ${length}, 0, ${length}${hasKeys ? `, ${keys}` : ""})`,
					context.top,
				)
			: paused
				? [
						...paused,
						...this.#wait(
							span,
							`drive(LG${id}(run, out, 0, ${length}))`,
							context.top,
						),
					]
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
			this.#checkedStep(span),
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
			this.#checkedStep(span),
			`const ${length} = ${count};`,
			`if (${length} > maxSteps) rangeLimit(run, ${rangeSpan}, ${length});`,
			`if ((steps += ${length}) > maxSteps) stepLimit(run, ${rangeSpan});`,
			...(alternate.length > 0
				? [`if (${length} === 0) {`, ...indent(alternate), "}"]
				: []),
			`for (let ${index} = 0; ${index} < ${length}; ${index}++) {`,
			`\t${this.#checkedStep(span)}`,
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

	/**
	 * The start of a loop pass: counts a step and makes the pass's scope, unless continuing one, which is passed its
	 * scope, and binds the loop's variables.
	 */
	#pass(loop: LoopNames, starts: boolean): string[] {
		const { span, values, index, value, key, keys, hasKeys } = loop;
		const proto = `q${loop.id}`;
		return [
			...(starts ? [this.#checkedStep(span)] : []),
			...(loop.scope && starts
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
	 * at. A pass that gets a promise continues in a function for the rest of that pass, and `passAhead` calls the loop
	 * for the next index: at once, ahead of the pass, when it may. Returns the loop function's name, or null when a pass
	 * may wait somewhere a function can't continue from, such as in a nested loop.
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
			const inner: Context = {
				...context,
				inLoop: true,
				top: true,
				pass: true,
			};
			const generated = this.#parts(
				statement.body,
				statement.body.map((child) => this.#statement(child, inner)),
			);
			if (!this.#fn.waits || this.#fn.waitsInside) {
				restore();
				return null;
			}
			// Flags are set once every statement is generated, so every lookup of a variable sets the flag a later read
			// uses. A lookup that skipped it would leave the flag of an earlier value, which may not be a plain object.
			const groups = generated.map((lines) => this.#setFlags(lines));
			// A pass is split after each statement that waits, and after each call to your function, whose value the
			// next function takes: `values[k]` names the local it goes in for segment k.
			const segments: string[][] = [[]];
			const values: (string | null)[] = [null];
			for (const group of groups) {
				for (const line of group) {
					(segments.at(-1) as string[]).push(line);
					const value = VALUE_LINE.exec(line);
					if (value) {
						segments.push([]);
						values.push(value[2] as string);
					}
				}
				if (group.some((line) => WAIT_LINE.test(line))) {
					segments.push([]);
					values.push(null);
				}
			}
			const name = `L${this.#generators++}`;
			const keys = loop.hasKeys ? `, ${loop.keys}` : "";
			// The loop function runs passes up to `stop`; each function after a wait finishes one pass.
			const params = `run, scope, out, ${loop.values}, ${loop.length}, ${loop.index}, stop${keys}`;
			// A pass continues in the scope it started, so variables it set before waiting are still there.
			const passScope = loop.scope ? `, ${loop.scope}` : "";
			const partParams = `run, scope, out, ${loop.values}, ${loop.length}, ${loop.index}${keys}${passScope}`;
			const call = (part: number, value?: string) =>
				`${name}_${part}(${partParams}${value === undefined ? "" : `, ${value}`})`;
			const one = `(run, out, j) => ${name}(run, scope, out, ${loop.values}, ${loop.length}, j, j + 1${keys})`;
			const { sets, elsewhere } = this.#setsOf(statement);
			// Each wait continues the pass in the function for the segments after it. The first wait in a pass, in the
			// loop function, also starts the passes after it, ahead of it when they may. See `passAhead`.
			const handOff = (from: number, tabs: string, rest: string) =>
				from === 0
					? `${tabs}return ${loop.index} + 1 < stop ? passAhead(run, scope, out, ${rest}, ${sets}, ${elsewhere}, ${loop.index} + 1, stop, ${one}, ${loop.span}) : ${rest};`
					: `${tabs}return ${rest};`;
			const continued = (from: number) =>
				segments.slice(from).flatMap((lines, offset) =>
					this.#forgetLines(lines).flatMap((line) => {
						const next = from + offset + 1;
						const value = VALUE_LINE.exec(line);
						if (value) {
							const [, tabs, result, span, fn] = value as unknown as string[];
							return [
								`${tabs}if (${result} instanceof Promise) {`,
								// The text so far goes out first, so a streamed render can send it while this waits.
								`${tabs}\twrite(run, out, s, ${span});`,
								handOff(
									from,
									`${tabs}\t`,
									`${result}.then((w) => ${call(next, "unhold(w)")}, (error) => { throw hostError(run, ${span}, ${fn}, error); })`,
								),
								`${tabs}}`,
							];
						}
						const wait = WAIT_LINE.exec(line);
						if (!wait) return [line];
						const [, tabs, result] = wait as unknown as string[];
						return [
							`${tabs}if (${result} !== undefined) {`,
							handOff(from, `${tabs}\t`, `${result}.then(() => ${call(next)})`),
							`${tabs}}`,
						];
					}),
				);
			const start = this.#start(loop.span);
			const end = ["state.steps = steps;", `write(run, out, s, ${loop.span});`];
			this.#declarations.push(
				`function ${name}(${params}) {`,
				...indent([
					...start,
					...this.#guard([
						`for (; ${loop.index} < stop; ${loop.index}++) {`,
						...indent(this.#pass(loop, true)),
						...indent(continued(0)),
						`\tif (s.length > ${FLUSH_AT}) {`,
						`\t\twrite(run, out, s, ${loop.span});`,
						'\t\ts = "";',
						"\t}",
						"}",
						...end,
					]),
				]),
				"}",
			);
			for (let part = 1; part < segments.length; part++) {
				const value = values[part] ?? null;
				this.#declarations.push(
					`function ${name}_${part}(${partParams}${value === null ? "" : ", w"}) {`,
					...indent([
						...start,
						...(value === null ? [] : [`${value} = w;`]),
						...this.#guard([
							...this.#pass(loop, false),
							...continued(part),
							...end,
						]),
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
	 * The variables a loop's body sets, as a frozen list made once, and whether it places content from elsewhere, for
	 * `passesAhead`.
	 */
	#setsOf(statement: Extract<Statement, { type: "For" }>): {
		sets: string;
		elsewhere: boolean;
	} {
		const effects = effectsOf(statement.body, this.#env);
		const names = [...effects.sets];
		const sets = this.#constant(
			`sets:${JSON.stringify(names)}`,
			"N",
			`Object.freeze(${JSON.stringify(names)})`,
		);
		return { sets, elsewhere: effects.elsewhere };
	}

	/**
	 * A loop whose passes may pause anywhere, such as at a call to one of your functions, as a generator of its own over
	 * the index to start at. It is declared where the loop is, so it reads the locals around it, such as the loops
	 * outside. When a pass pauses, the passes after it start at once in another run of the generator, when they may;
	 * see `startAhead`. The loop then stops after that pass and waits for them. Returns the generator's lines, or null
	 * when no pass waits.
	 */
	#loopGenerator(
		statement: Extract<Statement, { type: "For" }>,
		context: Context,
		loop: LoopNames,
	): string[] | null {
		if (!effectsOf(statement.body, this.#env).waits) return null;
		const outer = this.#fn;
		const restore = this.#snapshot();
		this.#fn = newFunction();
		try {
			const lines = this.#body(statement.body, { ...context, inLoop: true });
			if (!this.#fn.waits) {
				restore();
				return null;
			}
			const name = `LG${loop.id}`;
			const ahead = `a${loop.id}`;
			const { index, span } = loop;
			// Only the first run of the generator starts passes ahead. The ones it starts run one pass each.
			const { sets, elsewhere } = this.#setsOf(statement);
			const fork = `if (${ahead} === null && ${index} + 1 < stop) ${ahead} = startAhead(run, ${loop.outer}, out, ${sets}, ${elsewhere}, ${index} + 1, stop, (run, out, j) => drive(${name}(run, out, j, j + 1)), ${span});`;
			const body = this.#forgetLines(this.#setFlags(lines)).flatMap((line) => {
				if (line.trim() === FORK) return [line.replace(FORK, fork)];
				const wait = WAIT_LINE.exec(line);
				if (!wait) return [line];
				const [, tabs, result] = wait as unknown as [string, string, string];
				return [
					`${tabs}if (${result} !== undefined) {`,
					`${tabs}\t${fork}`,
					`${tabs}\tyield ${result};`,
					`${tabs}}`,
				];
			});
			const pass = this.#pass(loop, true);
			const reads = this.#fn.reads;
			return [
				`const ${name} = function* (run, out, ${index}, stop) {`,
				...indent([
					...this.#start(span),
					`let ${ahead} = null;`,
					...this.#guard([
						"try {",
						`\tfor (; ${index} < stop; ${index}++) {`,
						...indent(indent([...pass, ...body])),
						`\t\tif (${ahead} !== null) break;`,
						`\t\tif (s.length > ${FLUSH_AT}) {`,
						`\t\t\twrite(run, out, s, ${span});`,
						'\t\t\ts = "";',
						"\t\t}",
						"\t}",
						"} catch (error) {",
						`\tif (${ahead} !== null) yield ${ahead}.fail(error);`,
						"\tthrow error;",
						"}",
						`if (${ahead} !== null) {`,
						`\twrite(run, out, s, ${span});`,
						'\ts = "";',
						"\tstate.steps = steps;",
						// The passes ahead locate their own errors.
						...(reads ? ["\tat = null;"] : []),
						`\tyield ${ahead}.join();`,
						"}",
						"state.steps = steps;",
						`write(run, out, s, ${span});`,
					]),
				]),
				"};",
			];
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

	/** Forgets every variable lookup, after code that may set any variable, so later lookups start again. */
	#forgetAll(): string[] {
		return [FORGET_ALL];
	}

	/** Writes out `FORGET_ALL`, once the current function's lookups are all known. */
	#forgetLines(lines: string[]): string[] {
		const forget = [...this.#fn.variables.values()]
			.map(({ value }) => `${value} = undefined;`)
			.join(" ");
		return lines.map((line) =>
			line.endsWith(FORGET_ALL)
				? line.slice(0, -FORGET_ALL.length) + forget
				: line,
		);
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

	/** Whether an expression is a call to one of your functions or filters, which `#hostCall` generates. */
	#isHostCall(node: Expression): node is HostCallNode {
		if (node.type === "Call") {
			const callee = node.callee;
			return (
				callee.type === "Name" &&
				!this.#macros.has(callee.name) &&
				this.#env.functions.get(callee.name)?.kind === "host"
			);
		}
		return (
			node.type === "Filter" &&
			this.#env.filters.get(node.name)?.kind === "host"
		);
	}

	#hostCall(
		node: Expression,
		context: Context,
		target: string,
	): string[] | null {
		if (!this.#isHostCall(node)) return null;
		const kind = node.type === "Filter" ? "filter" : "function";
		const name = node.type === "Filter" ? node.name : node.callee.name;
		const input = node.type === "Filter" ? node.input : null;
		const args = node.args;
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
		if (context.pass) {
			return [
				this.#checkedStep(span),
				"state.steps = steps;",
				`${target} = callHost(run, ${span}, ${fn}, [${values.join(", ")}]);`,
				`${VALUE}${target} ${span} ${fn}`,
				"steps = state.steps;",
				`signal !== undefined && signal.aborted && aborted(run, ${span});`,
			];
		}
		this.#fn.waitsInside = true;
		this.#fn.inner++;
		return [
			// An abort, perhaps from a getter in your data, stops the render before your function is called, as `step` does.
			this.#checkedStep(span),
			"state.steps = steps;",
			`${target} = callHost(run, ${span}, ${fn}, [${values.join(", ")}]);`,
			`if (${target} instanceof Promise) {`,
			// The text so far goes out first, so a streamed render can send it while this waits.
			`\twrite(run, out, s, ${span});`,
			'\ts = "";',
			`\t${FORK}`,
			"\ttry {",
			`\t\t${target} = yield ${target};`,
			"\t} catch (error) {",
			`\t\tthrow hostError(run, ${span}, ${fn}, error);`,
			"\t}",
			"}",
			"steps = state.steps;",
			// Your function may have aborted the render, as the next step would notice in a template rendered from source.
			`signal !== undefined && signal.aborted && aborted(run, ${span});`,
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
			...variables.charge(span),
			...this.#wait(
				span,
				variables.embed(span, target.name, "null", statement.ignoreMissing),
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
	 * no hash is made and copied, and each name passed counts a step, as `embed` counts them; anything else is passed
	 * to `embed`, which checks, counts and copies it.
	 */
	#variables(
		node: Expression | null,
		context: Context,
	): {
		lines: string[];
		/** Lines that count the steps for the names passed, at the tag. */
		charge: (span: string) => string[];
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
				charge: () => [],
				embed: (span, name, slots, ignoreMissing) =>
					`embed(run, out, ${span}, ${(name as { js: string }).js}, ${value}, ${slots}, ${ignoreMissing})`,
			};
		}
		const scope = this.#temp();
		const lines = [`${scope} = childScope(state.globals);`];
		// The names passed, in the order a hash holds its keys, as `embed` lists them: whole numbers first.
		const order: Record<string, true> = Object.create(null);
		for (const entry of node?.type === "Hash" ? node.entries : []) {
			if (entry.type !== "Property") return unsupported();
			const key = String((entry.key as { value: unknown }).value);
			order[key] = true;
			lines.push(
				`${scope}[${JSON.stringify(key)}] = (${this.#expr(entry.value, context, false)}) ?? null;`,
			);
		}
		const keys = Object.keys(order);
		const passed = this.#constant(
			`passed:${JSON.stringify(keys)}`,
			"P",
			`Object.freeze(${JSON.stringify(keys)})`,
		);
		return {
			lines,
			charge: (span) =>
				keys.length === 0
					? []
					: [
							`if ((steps += ${keys.length}) > maxSteps) stepLimit(run, ${span});`,
						],
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
					`${slots}.set(${JSON.stringify(fill.name)}, { body: ${this.#nested(fill.body, statement.span, context)}, run, scope: ${context.scope}, sets: ${mayWrite(fill.body)} });`,
			),
			...variables.charge(span),
			...this.#wait(
				span,
				variables.embed(span, target.name, slots, false),
				context.top,
			),
			// Fills render in this scope, and may set variables in it, as may a block they place.
			...(fills.some((fill) => setsVariables(fill.body))
				? this.#forgetAll()
				: fills.some((fill) =>
							containsNode(fill.body, (record) => record.type === "Block"),
					  )
					? this.#afterBlocks()
					: []),
		];
	}

	/** A slot: the caller's fill, or the fallback. */
	#slot(
		statement: Extract<Statement, { type: "Slot" }>,
		context: Context,
	): string[] {
		const span = this.#span(statement.span);
		const fill = this.#temp();
		// The fallback renders in a scope of its own, so variables it declares stay inside it.
		const sets = [...setsIn(statement.body)];
		const scope = sets.length > 0 ? this.#temp() : context.scope;
		let fallback = this.#body(statement.body, { ...context, scope });
		if (sets.length > 0) {
			fallback = [
				`${scope} = childScope(${context.scope});`,
				...fallback,
				...sets.flatMap((name) => this.#forget(name)),
			];
		}
		return [
			`${fill} = run.slots === null ? undefined : run.slots.get(${JSON.stringify(statement.name)});`,
			`if (${fill} !== undefined) {`,
			...indent(
				this.#wait(span, `fillSlot(run, ${span}, ${fill}, out)`, context.top),
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
		return [
			...this.#wait(
				span,
				`placeBlock(run, ${span}, ${JSON.stringify(statement.name)}, ${context.scope}, out)`,
				context.top,
			),
			...this.#afterBlocks(),
		];
	}

	/** Forgets every variable lookup after a block is placed when the block, perhaps a child template's version, may set any variable. */
	#afterBlocks(): string[] {
		return ["if (blockSets(run)) {", ...indent(this.#forgetAll()), "}"];
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
			const value = this.#temp();
			const target = this.#expr(object, context, guard);
			const key = this.#expr(property, context, false);
			// A chain that stops at a `?.` leaves the key unevaluated.
			const stops = optional
				? `${value} === SHORT || ${value} === MISSING || ${value} === null || ${value} === undefined`
				: `${value} === SHORT`;
			return `(${value} = ${target}, ${stops} ? SHORT : readMember(run, ${span}, ${value}, ${key}, ${flags}))`;
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
		const site = this.#constant(
			`read:${span}:${key}`,
			"P",
			`[${span}, ${JSON.stringify(key)}]`,
		);
		this.#fn.reads = true;
		// The object is read first, since reading it may set `at` for its own property.
		return [
			`(${known.target}, at = ${site}, ${known.plain}`,
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
				return `(${a} = ${left}, ${b} = ${right}, typeof ${a} === "string" && typeof ${b} === "string" && ${a}.length + ${b}.length <= maxSize ? ${a} + ${b} : concat(run, ${span}, ${a}, ${b}))`;
			}
			case "==":
				return `equals(${left}, ${right})`;
			case "!=":
				return `!equals(${left}, ${right})`;
			case "in":
				return this.#counted(`contains(run, ${span}, ${left}, ${right})`);
			case "not in":
				return `!${this.#counted(`contains(run, ${span}, ${left}, ${right})`)}`;
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
		// `odd` and `even` never fail and count no steps of their own, so they are written out, after the call's step.
		// The built-in is still looked up, so a module loaded where `odd` is something else fails as usual.
		if ((name === "odd" || name === "even") && node.args.length === 0) {
			const value = this.#temp();
			const test =
				name === "even"
					? `${value} % 2 === 0`
					: `(${value} % 2 === 1 || ${value} % 2 === -1)`;
			return `(${this.#step(span)}, ${value} = ${this.#expr(input, context, false)}, ${negated ? "!" : ""}(typeof ${value} === "number" && ${test}))`;
		}
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
