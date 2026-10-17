import type { Span } from "../source.js";

export type EscapeStrategy = "html" | "attr" | "js" | "css" | "url";

export type BinaryOperator =
	| "or"
	| "and"
	| "??"
	| "?:"
	| "=="
	| "!="
	| "<"
	| ">"
	| "<="
	| ">="
	| "in"
	| "not in"
	| "starts with"
	| "ends with"
	| ".."
	| "~"
	| "+"
	| "-"
	| "*"
	| "/"
	| "//"
	| "%"
	| "**";

export type Spread = { type: "Spread"; value: Expression; span: Span };

export type Argument =
	| { type: "Positional"; value: Expression; span: Span }
	| { type: "Named"; name: string; value: Expression; span: Span }
	| Spread;

export type HashEntry =
	| { type: "Property"; key: Expression; value: Expression; span: Span }
	| Spread;

export type Expression =
	| {
			type: "Literal";
			value: null | boolean | number | string;
			span: Span;
	  }
	| { type: "Name"; name: string; span: Span }
	/** A double-quoted string with `#{}` interpolation. */
	| { type: "Interpolation"; parts: Expression[]; span: Span }
	| { type: "Array"; elements: (Expression | Spread)[]; span: Span }
	| { type: "Hash"; entries: HashEntry[]; span: Span }
	| {
			type: "Unary";
			operator: "-" | "+" | "not";
			operand: Expression;
			span: Span;
	  }
	| {
			type: "Binary";
			operator: BinaryOperator;
			left: Expression;
			right: Expression;
			span: Span;
	  }
	| {
			type: "Conditional";
			test: Expression;
			consequent: Expression;
			alternate: Expression | null;
			span: Span;
	  }
	| {
			type: "Member";
			object: Expression;
			property: Expression;
			/** True for `a?.b` and `a?.[b]`. */
			optional: boolean;
			span: Span;
	  }
	| { type: "Call"; callee: Expression; args: Argument[]; span: Span }
	| {
			type: "Filter";
			name: string;
			nameSpan: Span;
			input: Expression;
			args: Argument[];
			span: Span;
	  }
	| {
			type: "Test";
			name: string;
			nameSpan: Span;
			input: Expression;
			args: Argument[];
			negated: boolean;
			span: Span;
	  }
	| { type: "Arrow"; params: string[]; body: Expression; span: Span }
	/** Wraps a member and call chain that contains `?.`, so null short-circuits the whole chain. */
	| { type: "OptionalChain"; expression: Expression; span: Span }
	/** Stands in for an expression that failed to parse. */
	| { type: "Invalid"; span: Span };

export type Param = { name: string; default: Expression | null; span: Span };

/** Type names a prop can declare. See `TYPE_NAMES`. */
export type TypeName = (typeof TYPE_NAMES)[number];

/**
 * One member of a prop's type. A full type is a list of members, read as a union.
 *
 * - A built-in type name, such as `string`.
 * - `{ literal }`: one exact string or number, such as `"primary"`.
 * - `{ list }`: `T[]`, an array of the inner type.
 * - `{ shape }`: `{ name: string }`, a hash or object with these keys.
 * - `{ named }`: a type the host registers, such as `Post`.
 */
export type PropType =
	| TypeName
	| { literal: string | number }
	| { list: PropType[] }
	| { shape: ShapeKey[] }
	| { named: string };

/** One key of a shape type, such as `url?: string`. */
export type ShapeKey = { name: string; optional: boolean; type: PropType[] };

/** A `props` entry. `type` is null when the prop is untyped. */
export type PropParam = Param & { type: PropType[] | null };

export type FilterCall = {
	name: string;
	args: Argument[];
	span: Span;
};

export type Statement =
	| { type: "Text"; value: string; span: Span }
	| { type: "Output"; expression: Expression; span: Span }
	| {
			type: "If";
			branches: { test: Expression; body: Statement[] }[];
			alternate: Statement[] | null;
			span: Span;
	  }
	| {
			type: "For";
			keyName: string | null;
			valueName: string;
			iterable: Expression;
			body: Statement[];
			alternate: Statement[] | null;
			span: Span;
	  }
	| { type: "Set"; name: string; value: Expression; span: Span }
	| { type: "SetBlock"; name: string; body: Statement[]; span: Span }
	/** `rest` names the hash that collects undeclared variables, as in `...attributes`, or is null. */
	| { type: "Props"; props: PropParam[]; rest: string | null; span: Span }
	| { type: "Extends"; template: Expression; span: Span }
	| { type: "Block"; name: string; body: Statement[]; span: Span }
	| {
			type: "Include";
			template: Expression;
			with: Expression | null;
			ignoreMissing: boolean;
			span: Span;
	  }
	| {
			type: "Component";
			template: Expression;
			with: Expression | null;
			fills: { name: string; body: Statement[]; span: Span }[];
			/** Content outside any `fill`, which fills the default slot. */
			body: Statement[];
			span: Span;
	  }
	| { type: "Slot"; name: string; body: Statement[]; span: Span }
	/**
	 * A component that can load after the page. `body` is the fallback, shown until a deferred island loads. A deferred
	 * island writes its tags back as `<kiln-island>` lines where they stand on lines of their own. `indent` is set when
	 * the `island` tag does: its line's indentation. `closing` is set when `endisland` does: its indentation, or null
	 * when it shares that line with the `island` tag, and whether a line break followed it.
	 */
	| {
			type: "Island";
			template: Expression;
			with: Expression | null;
			body: Statement[];
			indent?: string;
			closing?: { indent: string | null; newline: boolean };
			span: Span;
	  }
	| {
			type: "Macro";
			name: string;
			params: Param[];
			body: Statement[];
			span: Span;
	  }
	| { type: "Import"; template: string; alias: string; span: Span }
	| {
			type: "FromImport";
			template: string;
			names: { name: string; alias: string; span: Span }[];
			span: Span;
	  }
	| { type: "With"; value: Expression; body: Statement[]; span: Span }
	/** A place other templates add content to with `add to`, filled when the render ends. */
	| { type: "Outlet"; name: string; span: Span }
	/** Closes the outlets reached so far, so a streamed render can send its output up to here. */
	| { type: "Flush"; span: Span }
	/** Content for the outlet named `outlet`. `once` adds it only the first time the tag runs in a render. */
	| {
			type: "Add";
			outlet: string;
			once: boolean;
			body: Statement[];
			span: Span;
	  }
	/** `seconds` is the `for` value, or null. */
	| {
			type: "Cache";
			key: Expression;
			seconds: Expression | null;
			body: Statement[];
			span: Span;
	  }
	| { type: "Apply"; filters: FilterCall[]; body: Statement[]; span: Span }
	| {
			type: "Autoescape";
			strategy: EscapeStrategy | false;
			body: Statement[];
			span: Span;
	  };

export type TemplateNode = { type: "Template"; body: Statement[]; span: Span };

export type IslandStatement = Extract<Statement, { type: "Island" }>;

/** The name of the default slot, filled by content outside any `fill`. */
export const DEFAULT_SLOT = "default";

export const ESCAPE_STRATEGIES: readonly EscapeStrategy[] = [
	"html",
	"attr",
	"js",
	"css",
	"url",
];

/** The value types a prop can declare, named as in the docs' table of types. */
export const TYPE_NAMES = [
	"null",
	"boolean",
	"number",
	"string",
	"array",
	"hash",
	"set",
	"date",
	"markup",
	"object",
] as const;
