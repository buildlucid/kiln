import type { Argument, Expression, PropType } from "@lucidkiln/core/syntax";
import { splitParameters } from "./calls.js";
import {
	type BindingSource,
	bindingAt,
	type TemplateScopes,
} from "./scopes.js";
import type { Member, TypeScriptProject } from "./typescript.js";

/**
 * Kiln's rules for values, written as TypeScript helper types. Each Kiln expression becomes a type built from these,
 * and the project's own TypeScript works out what it is.
 *
 * - `Get`: `a.b` and `a[0]`, reading a property, a map's value or a list's item.
 * - `Item`, `Key`: what `for` gives for each pass.
 * - `Params` and `Returns` describe a function for hover. A function made with `withRender` is an object whose `call`
 *   takes `RenderInfo` first, so `Params` leaves that out.
 * - `arg`, `plain`, `aware`, `dropRender`, `Called`: a call to a host function, written as a real call so TypeScript
 *   works out a generic function's type parameters from the arguments. See `typeWriter`.
 * - `Members`: the values whose properties a template can read, so lists, maps and primitives complete nothing.
 * - `Last`: a function's last parameter, which named arguments are gathered into.
 * - `Fits`, `NamedFit`: whether an argument fits its parameter. Unknown types always fit, so the editor never guesses.
 */
const PRELUDE = `import type { KilnFilters, KilnFunctions, KilnGlobals, KilnTests, KilnTypes, Markup } from "@lucidkiln/core";
type Named<N extends string> = N extends keyof KilnTypes ? KilnTypes[N] : unknown;
type Get<V, K> = NonNullable<V> extends infer O ? O extends ReadonlyMap<unknown, infer M> ? M : O extends readonly (infer I)[] ? (K extends number ? I : unknown) : K extends keyof O ? O[K] : unknown : never;
type Item<V> = NonNullable<V> extends infer O ? O extends string ? unknown : O extends readonly (infer I)[] ? I : O extends ReadonlyMap<unknown, infer M> ? M : O extends ReadonlySet<infer S> ? S : O extends Iterable<infer I> ? I : O extends object ? O[keyof O] : unknown : never;
type Key<V> = NonNullable<V> extends infer O ? O extends string ? unknown : O extends readonly unknown[] | ReadonlySet<unknown> ? number : O extends ReadonlyMap<infer K, unknown> ? K : O extends object ? keyof O & string : unknown : never;
type Returns<F> = F extends (...args: never) => infer R ? R : F extends { readonly call: (...args: never) => infer R } ? R : unknown;
type Params<F> = F extends (...args: infer A) => unknown ? A : F extends { readonly call: (render: never, ...args: infer A) => unknown } ? A : never;
declare function arg<T>(): T;
declare function plain<F>(fn: F): F extends (...args: never) => unknown ? F : never;
declare function aware<F>(fn: F): F extends (...args: never) => unknown ? never : F extends { readonly call: infer C } ? C : never;
declare function dropRender<A extends unknown[], R>(fn: (render: never, ...args: A) => R): (...args: A) => R;
type Called<F, Plain, Aware> = unknown extends F ? unknown : F extends (...args: never) => unknown ? Awaited<Plain> : F extends { readonly call: unknown } ? Awaited<Aware> : unknown;
type Tail<A> = A extends readonly [unknown?, ...infer R] ? R : A;
type Last<A> = Required<A> extends readonly [...unknown[], infer L] ? L : A extends readonly (infer E)[] ? E : unknown;
type Fits<A, P> = [P] extends [never] ? true : unknown extends P ? true : unknown extends A ? true : [Exclude<A, Markup>] extends [P] ? true : false;
type NamedFit<L, K, A> = unknown extends L ? "ok" : [L] extends [never] ? "ok" : NonNullable<L> extends infer O ? string extends keyof O ? "ok" : K extends keyof O ? Fits<A, Exclude<O[K], undefined>> extends true ? "ok" : "mismatch" : "missing" : "ok";
type Members<V> = NonNullable<V> extends infer O ? O extends string | number | boolean | bigint | symbol | Function | Date | Markup | readonly unknown[] | ReadonlyMap<unknown, unknown> | ReadonlySet<unknown> ? never : O : never;
`;

const BUILTIN_TYPES: Record<string, string> = {
	null: "null",
	boolean: "boolean",
	number: "number",
	string: "string | Markup",
	array: "readonly unknown[]",
	hash: "Readonly<Record<string, unknown>> | ReadonlyMap<string, unknown>",
	set: "ReadonlySet<unknown>",
	date: "Date",
	markup: "Markup",
	object: "object",
};

/** A prop's declared type as TypeScript, the same way `generateTypes` writes it. */
export const propType = (type: readonly PropType[] | null): string => {
	if (type === null) return "unknown";
	if (type.length === 0) return "never";
	return type
		.map((member): string => {
			if (typeof member === "string") return BUILTIN_TYPES[member] ?? "unknown";
			if ("literal" in member) return JSON.stringify(member.literal);
			if ("named" in member) return `Named<${JSON.stringify(member.named)}>`;
			if ("list" in member) return `readonly (${propType(member.list)})[]`;
			if (member.shape.length === 0) return "object";
			const keys = member.shape.map(
				(key) =>
					`${JSON.stringify(key.name)}${key.optional ? "?" : ""}: ${propType(key.type)}`,
			);
			return `{ ${keys.join("; ")} }`;
		})
		.join(" | ");
};

const BUILTIN_FUNCTIONS: Record<string, string> = {
	range: "number[]",
	max: "number",
	min: "number",
	cycle: "unknown",
	date: "Date",
	attrs: "Markup",
	dump: "Markup",
	parent: "Markup",
	block: "Markup",
};

/** What each built-in filter gives, from the type of the value before the `|` and the types of its arguments. */
const BUILTIN_FILTERS: Record<
	string,
	(input: string, args: string[]) => string
> = {
	upper: () => "string",
	lower: () => "string",
	capitalize: () => "string",
	title: () => "string",
	trim: () => "string",
	replace: () => "string",
	split: () => "string[]",
	truncate: () => "string",
	stripTags: () => "string",
	urlEncode: () => "string",
	json: () => "Markup",
	escape: () => "Markup",
	raw: () => "Markup",
	default: (input, [fallback = "string"]) =>
		`NonNullable<${input}> | ${fallback}`,
	length: () => "number",
	first: (input) => `Item<${input}>`,
	last: (input) => `Item<${input}>`,
	slice: (input) => input,
	join: () => "string",
	keys: (input) => `Key<${input}>[]`,
	merge: (input) => input,
	reverse: (input) => input,
	sort: (input) => input,
	map: () => "unknown[]",
	filter: (input) => input,
	reduce: () => "unknown",
	find: (input) => `Item<${input}> | null`,
	column: () => "unknown[]",
	batch: (input) => `Item<${input}>[][]`,
	abs: () => "number",
	round: () => "number",
	formatNumber: () => "string",
	plural: () => "string",
	formatDate: () => "string",
};

/** The list item an arrow function's parameter gets, by filter: which parameter it is. */
const ITEM_PARAMS: Record<string, readonly number[]> = {
	map: [0],
	filter: [0],
	find: [0],
	sort: [0, 1],
	reduce: [1],
};

/** What a template knows besides its own variables: which names the project registers. */
export type TypeContext = {
	scopes: TemplateScopes;
	/** Function and filter names the project registers, from `kiln.json`. A registered name replaces a built-in. */
	functions: readonly string[];
	filters: readonly string[];
	/** Macros the template defines or imports. Calling one gives markup. */
	macros: ReadonlySet<string>;
};

const MAX_DEPTH = 32;

const union = (types: string[]) =>
	types.length === 0 ? "never" : [...new Set(types)].join(" | ");

const literalKey = (expression: Expression) =>
	expression.type === "Literal" &&
	(typeof expression.value === "string" || typeof expression.value === "number")
		? JSON.stringify(expression.value)
		: null;

/** Writes TypeScript for a template's values. Its types read the declarations in `statements`. */
export type TypeWriter = {
	/** The TypeScript type of a Kiln expression, using the helper types in `PRELUDE`. */
	expression(expression: Expression): string;
	/** The TypeScript type of a variable, from where its value comes from. */
	binding(source: BindingSource): string;
	/** The calls the types written so far read. Pass them to `withTypes` with the aliases that use them. */
	readonly statements: readonly string[];
};

/**
 * Writes the types of a template's values. A literal's type is its value, so `"page"` is `"page"`. A call to a host
 * function or filter becomes a real call in `statements`, so TypeScript works out a generic function's type parameters
 * from the arguments:
 *
 * ```ts
 * declare const $fn0: Get<KilnFunctions, "document">;
 * const $plain0 = plain($fn0)(arg<"page">());
 * const $aware0 = dropRender(aware($fn0))(arg<"page">());
 * ```
 *
 * The call's type is `Called<typeof $fn0, typeof $plain0, typeof $aware0>`: the first call for a plain function, the
 * second for one made with `withRender`. Each expression is written once, however often a template reads it.
 */
export const typeWriter = (context: TypeContext): TypeWriter => {
	const statements: string[] = [];
	const written = new Map<Expression, string>();

	/** Writes a call to `callee`, a TypeScript type, with the types of its arguments, and returns the result's type. */
	const call = (callee: string, args: string[]) => {
		const id = statements.length;
		const list = args.join(", ");
		statements.push(
			`declare const $fn${id}: ${callee};\n` +
				`const $plain${id} = plain($fn${id})(${list});\n` +
				`const $aware${id} = dropRender(aware($fn${id}))(${list});\n`,
		);
		return `Called<typeof $fn${id}, typeof $plain${id}, typeof $aware${id}>`;
	};

	/** A call's arguments as TypeScript: named arguments are gathered into one hash at the end, as Kiln does. */
	const callArgs = (list: Argument[], depth: number, input?: string) => {
		const named = list.flatMap((item) =>
			item.type === "Named"
				? [`${JSON.stringify(item.name)}: ${expression(item.value, depth)}`]
				: [],
		);
		return [
			...(input ? [`arg<${input}>()`] : []),
			...list.flatMap((item) => {
				if (item.type === "Named") return [];
				const type = expression(item.value, depth);
				return [
					item.type === "Spread"
						? `...arg<Item<${type}>[]>()`
						: `arg<${type}>()`,
				];
			}),
			...(named.length > 0 ? [`arg<{ ${named.join("; ")} }>()`] : []),
		];
	};

	const binding = (source: BindingSource, depth: number): string => {
		const of = (value: Expression) => expression(value, depth + 1);
		switch (source.kind) {
			case "prop":
				return propType(source.type);
			case "rest":
				return "Readonly<Record<string, unknown>>";
			case "set":
				return of(source.value);
			case "capture":
				return "Markup";
			case "item":
				return `Item<${of(source.iterable)}>`;
			case "key":
				return `Key<${of(source.iterable)}>`;
			case "arrow":
				return ITEM_PARAMS[source.filter]?.includes(source.index)
					? `Item<${of(source.input)}>`
					: "unknown";
			case "with":
				return `Get<${of(source.value)}, ${JSON.stringify(source.key)}>`;
			default:
				return "unknown";
		}
	};

	const expression = (node: Expression, depth: number): string => {
		if (depth > MAX_DEPTH) return "unknown";
		const known = written.get(node);
		if (known) return known;
		const type = write(node, depth + 1);
		written.set(node, type);
		return type;
	};

	const write = (node: Expression, depth: number): string => {
		const of = (inner: Expression) => expression(inner, depth);
		switch (node.type) {
			case "Literal":
				return typeof node.value === "string"
					? JSON.stringify(node.value)
					: String(node.value);
			case "Interpolation":
				return "string";
			case "Array":
				return `(${union(
					node.elements.map((element) =>
						element.type === "Spread"
							? `Item<${of(element.value)}>`
							: of(element),
					),
				)})[]`;
			case "Hash": {
				const keys = node.entries.flatMap((entry) => {
					if (entry.type === "Spread") return [];
					const key =
						entry.key.type === "Name"
							? JSON.stringify(entry.key.name)
							: literalKey(entry.key);
					return key ? [`${key}: ${of(entry.value)}`] : [];
				});
				return `{ ${keys.join("; ")} }`;
			}
			case "Unary":
				return node.operator === "not" ? "boolean" : "number";
			case "Binary":
				switch (node.operator) {
					case "??":
					case "?:":
						return `NonNullable<${of(node.left)}> | ${of(node.right)}`;
					case "~":
						return "string";
					case "..":
						return "number[]";
					case "+":
					case "-":
					case "*":
					case "/":
					case "//":
					case "%":
					case "**":
						return "number";
					default:
						return "boolean";
				}
			case "Conditional":
				return union([
					of(node.consequent),
					node.alternate ? of(node.alternate) : "null",
				]);
			case "Member": {
				const key = literalKey(node.property) ?? "string";
				return `Get<${of(node.object)}, ${key}>`;
			}
			case "Call": {
				const { callee } = node;
				if (callee.type === "Member") {
					const key = literalKey(callee.property) ?? "string";
					return call(
						`Get<${of(callee.object)}, ${key}>`,
						callArgs(node.args, depth),
					);
				}
				if (callee.type !== "Name") return "unknown";
				const name = callee.name;
				if (context.macros.has(name)) return "Markup";
				const builtin = BUILTIN_FUNCTIONS[name];
				if (builtin && !context.functions.includes(name)) return builtin;
				return call(
					`Get<KilnFunctions, ${JSON.stringify(name)}>`,
					callArgs(node.args, depth),
				);
			}
			case "Filter": {
				const input = of(node.input);
				const builtin = BUILTIN_FILTERS[node.name];
				if (!builtin || context.filters.includes(node.name)) {
					return call(
						`Get<KilnFilters, ${JSON.stringify(node.name)}>`,
						callArgs(node.args, depth, input),
					);
				}
				const arrow = node.args[0]?.value;
				if (node.name === "map" && arrow?.type === "Arrow") {
					return `(${of(arrow.body)})[]`;
				}
				return builtin(
					input,
					node.args.map((item) =>
						item.type === "Spread" ? "unknown" : of(item.value),
					),
				);
			}
			case "Test":
				return "boolean";
			case "OptionalChain":
				return of(node.expression);
			case "Name": {
				if (node.name === "loop") return "unknown";
				const found = bindingAt(context.scopes, node.name, node.span.start);
				if (found) return binding(found.source, depth);
				return `Get<KilnGlobals, ${JSON.stringify(node.name)}>`;
			}
			default:
				return "unknown";
		}
	};

	return {
		expression: (node) => expression(node, 0),
		binding: (source) => binding(source, 0),
		statements,
	};
};

/** The registries a project describes in TypeScript, by the kind of name the language server looks up. */
export const REGISTRIES = {
	function: "KilnFunctions",
	filter: "KilnFilters",
	test: "KilnTests",
	global: "KilnGlobals",
} as const;

/**
 * Checks a file of `type name = type` aliases with the project's TypeScript, and reads it with `use`. `statements` are
 * what the aliases read, from a `TypeWriter`.
 */
export const withTypes = <T>(
	typescript: TypeScriptProject,
	aliases: Record<string, string>,
	use: (read: {
		describe: (alias: string) => string | null;
		members: (alias: string) => Member[];
	}) => T,
	statements: readonly string[] = [],
): T | null => {
	const source =
		PRELUDE +
		statements.join("") +
		Object.entries(aliases)
			.map(([name, type]) => `type ${name} = ${type};\n`)
			.join("");
	return typescript.query(source, use);
};

/** The TypeScript type of a registered function, filter or test, by kind and name. */
const callableType = (kind: keyof typeof REGISTRIES, name: string) =>
	`Get<${REGISTRIES[kind]}, ${JSON.stringify(name)}>`;

/** Its parameters as a tuple: a filter's first parameter is the value before the `|`, so `withInput` keeps it. */
export const parametersType = (
	kind: "function" | "filter" | "test",
	name: string,
	withInput = false,
) => {
	const params = `Params<${callableType(kind, name)}>`;
	return kind === "function" || withInput ? params : `Tail<${params}>`;
};

/** A described function, filter or test: its signature and where each parameter sits in it. */
export type Signature = {
	label: string;
	parameters: { name: string; start: number; end: number }[];
	member: Member;
};

/** A host function, filter or test as hover shows it, such as `documents(collection: string): Promise<Page[]>`. */
export const describeCallable = (
	typescript: TypeScriptProject,
	kind: "function" | "filter" | "test",
	name: string,
): Signature | null =>
	withTypes(
		typescript,
		{
			Registry: REGISTRIES[kind],
			Parameters: parametersType(kind, name),
			Return: `Returns<${callableType(kind, name)}>`,
		},
		(read) => {
			const member = read
				.members("Registry")
				.find((item) => item.name === name);
			const parameters = read.describe("Parameters");
			const result = read.describe("Return");
			if (!member || !parameters || !result) return null;
			const list = parameters.replace(/^\[|\]$/g, "");
			const prefix = `${kind === "filter" ? "|" : kind === "test" ? "is " : ""}${name}(`;
			return {
				label: `${prefix}${list}): ${result}`,
				parameters: splitParameters(list).map((part) => ({
					name: /^(?:\.\.\.)?([\w$]+)/.exec(part.text)?.[1] ?? part.text,
					start: prefix.length + part.start,
					end: prefix.length + part.end,
				})),
				member,
			};
		},
	);

/** The names a function or filter takes as named arguments: the properties of its last parameter. */
export const namedOptions = (
	typescript: TypeScriptProject,
	kind: "function" | "filter",
	name: string,
): Member[] =>
	withTypes(
		typescript,
		{ Options: `Members<Last<${parametersType(kind, name)}>>` },
		(read) => read.members("Options"),
	) ?? [];

/** One argument to check: its type, and the parameter it goes to, by position or by name. */
export type ArgumentCheck = {
	type: string;
	parameters: string;
} & ({ index: number } | { name: string });

/** What's wrong with an argument, with the types to show: `missing` is a named argument the function doesn't take. */
export type ArgumentProblem =
	| { kind: "mismatch"; expected: string; actual: string }
	| { kind: "missing" };

/**
 * Checks arguments against their parameters with one TypeScript query. Null for an argument that fits. `statements` are
 * what the argument types read, from a `TypeWriter`.
 */
export const checkArguments = (
	typescript: TypeScriptProject,
	checks: ArgumentCheck[],
	statements: readonly string[] = [],
): (ArgumentProblem | null)[] => {
	if (checks.length === 0) return [];
	const aliases: Record<string, string> = {};
	checks.forEach((check, index) => {
		const expected =
			"index" in check
				? `Required<${check.parameters}>[${check.index}]`
				: `Exclude<Get<Last<${check.parameters}>, ${JSON.stringify(check.name)}>, undefined>`;
		aliases[`Fit${index}`] =
			"index" in check
				? `Fits<${check.type}, ${expected}> extends true ? "ok" : "mismatch"`
				: `NamedFit<Last<${check.parameters}>, ${JSON.stringify(check.name)}, ${check.type}>`;
		aliases[`Expected${index}`] = expected;
		aliases[`Actual${index}`] = check.type;
	});
	return (
		withTypes(
			typescript,
			aliases,
			(read) =>
				checks.map((_, index): ArgumentProblem | null => {
					const fit = read.describe(`Fit${index}`);
					if (fit === '"missing"') return { kind: "missing" };
					if (fit !== '"mismatch"') return null;
					return {
						kind: "mismatch",
						expected: read.describe(`Expected${index}`) ?? "unknown",
						actual: read.describe(`Actual${index}`) ?? "unknown",
					};
				}),
			statements,
		) ?? checks.map(() => null)
	);
};
