import type { Argument, Expression, PropType } from "@lucidkiln/core/syntax";
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
 * - `Result`: what a call gives once Kiln waits for it. `Params` and `Returns` describe the function for hover.
 * - `Members`: the values whose properties a template can read, so lists, maps and primitives complete nothing.
 */
const PRELUDE = `import type { KilnFilters, KilnFunctions, KilnGlobals, KilnTests, KilnTypes, Markup, RenderAware } from "@lucidkiln/core";
type Named<N extends string> = N extends keyof KilnTypes ? KilnTypes[N] : unknown;
type Get<V, K> = NonNullable<V> extends infer O ? O extends ReadonlyMap<unknown, infer M> ? M : O extends readonly (infer I)[] ? (K extends number ? I : unknown) : K extends keyof O ? O[K] : unknown : never;
type Item<V> = NonNullable<V> extends infer O ? O extends string ? unknown : O extends readonly (infer I)[] ? I : O extends ReadonlyMap<unknown, infer M> ? M : O extends ReadonlySet<infer S> ? S : O extends Iterable<infer I> ? I : O extends object ? O[keyof O] : unknown : never;
type Key<V> = NonNullable<V> extends infer O ? O extends string ? unknown : O extends readonly unknown[] | ReadonlySet<unknown> ? number : O extends ReadonlyMap<infer K, unknown> ? K : O extends object ? keyof O & string : unknown : never;
type Returns<F> = F extends RenderAware<any, any, infer R> ? R : F extends (...args: any) => infer R ? R : unknown;
type Result<F> = Awaited<Returns<F>>;
type Params<F> = F extends RenderAware<any, infer A, any> ? A : F extends (...args: infer A) => any ? A : never;
type Tail<A> = A extends readonly [unknown?, ...infer R] ? R : A;
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

/** The TypeScript type of a variable, from where its value comes from. */
export const bindingType = (
	source: BindingSource,
	context: TypeContext,
	depth = 0,
): string => {
	const of = (expression: Expression) =>
		expressionType(expression, context, depth + 1);
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

const union = (types: string[]) =>
	types.length === 0 ? "never" : [...new Set(types)].join(" | ");

const literalKey = (expression: Expression) =>
	expression.type === "Literal" &&
	(typeof expression.value === "string" || typeof expression.value === "number")
		? JSON.stringify(expression.value)
		: null;

/** Writes the TypeScript type of a Kiln expression, using the helper types in `PRELUDE`. */
export const expressionType = (
	expression: Expression,
	context: TypeContext,
	depth = 0,
): string => {
	if (depth > MAX_DEPTH) return "unknown";
	const of = (inner: Expression) => expressionType(inner, context, depth + 1);
	const args = (list: Argument[]) =>
		list.map((arg) => (arg.type === "Spread" ? "unknown" : of(arg.value)));

	switch (expression.type) {
		case "Literal":
			return expression.value === null ? "null" : typeof expression.value;
		case "Interpolation":
			return "string";
		case "Array":
			return `(${union(
				expression.elements.map((element) =>
					element.type === "Spread"
						? `Item<${of(element.value)}>`
						: of(element),
				),
			)})[]`;
		case "Hash": {
			const keys = expression.entries.flatMap((entry) => {
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
			return expression.operator === "not" ? "boolean" : "number";
		case "Binary":
			switch (expression.operator) {
				case "??":
				case "?:":
					return `NonNullable<${of(expression.left)}> | ${of(expression.right)}`;
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
				of(expression.consequent),
				expression.alternate ? of(expression.alternate) : "null",
			]);
		case "Member": {
			const key = literalKey(expression.property) ?? "string";
			return `Get<${of(expression.object)}, ${key}>`;
		}
		case "Call": {
			const { callee } = expression;
			if (callee.type === "Member") {
				const key = literalKey(callee.property) ?? "string";
				return `Result<Get<${of(callee.object)}, ${key}>>`;
			}
			if (callee.type !== "Name") return "unknown";
			const name = callee.name;
			if (context.macros.has(name)) return "Markup";
			const builtin = BUILTIN_FUNCTIONS[name];
			if (builtin && !context.functions.includes(name)) return builtin;
			return `Result<Get<KilnFunctions, ${JSON.stringify(name)}>>`;
		}
		case "Filter": {
			const input = of(expression.input);
			const builtin = BUILTIN_FILTERS[expression.name];
			if (!builtin || context.filters.includes(expression.name)) {
				return `Result<Get<KilnFilters, ${JSON.stringify(expression.name)}>>`;
			}
			const arrow = expression.args[0]?.value;
			if (expression.name === "map" && arrow?.type === "Arrow") {
				return `(${of(arrow.body)})[]`;
			}
			return builtin(input, args(expression.args));
		}
		case "Test":
			return "boolean";
		case "OptionalChain":
			return of(expression.expression);
		case "Name": {
			if (expression.name === "loop") return "unknown";
			const binding = bindingAt(
				context.scopes,
				expression.name,
				expression.span.start,
			);
			if (binding) return bindingType(binding.source, context, depth + 1);
			return `Get<KilnGlobals, ${JSON.stringify(expression.name)}>`;
		}
		default:
			return "unknown";
	}
};

/** The registries a project describes in TypeScript, by the kind of name the language server looks up. */
export const REGISTRIES = {
	function: "KilnFunctions",
	filter: "KilnFilters",
	test: "KilnTests",
	global: "KilnGlobals",
} as const;

/** Checks a file of `type name = type` aliases with the project's TypeScript, and reads it with `use`. */
export const withTypes = <T>(
	typescript: TypeScriptProject,
	aliases: Record<string, string>,
	use: (read: {
		describe: (alias: string) => string | null;
		members: (alias: string) => Member[];
	}) => T,
): T | null => {
	const source =
		PRELUDE +
		Object.entries(aliases)
			.map(([name, type]) => `type ${name} = ${type};\n`)
			.join("");
	return typescript.query(source, use);
};

/** A host function, filter or test as hover shows it, such as `documents(collection: string): Promise<Page[]>`. */
export const describeCallable = (
	typescript: TypeScriptProject,
	kind: "function" | "filter" | "test",
	name: string,
): { signature: string; member: Member } | null => {
	const registry = REGISTRIES[kind];
	const callable = `Get<${registry}, ${JSON.stringify(name)}>`;
	const params =
		kind === "function" ? `Params<${callable}>` : `Tail<Params<${callable}>>`;
	return withTypes(
		typescript,
		{ Registry: registry, Parameters: params, Return: `Returns<${callable}>` },
		(read) => {
			const member = read
				.members("Registry")
				.find((item) => item.name === name);
			const parameters = read.describe("Parameters");
			const result = read.describe("Return");
			if (!member || !parameters || !result) return null;
			const list = parameters.replace(/^\[|\]$/g, "");
			const prefix = kind === "filter" ? "|" : kind === "test" ? "is " : "";
			return { signature: `${prefix}${name}(${list}): ${result}`, member };
		},
	);
};
