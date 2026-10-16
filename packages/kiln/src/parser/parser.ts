import {
	type LexProblem,
	lex,
	MAX_NESTING,
	type Token,
} from "../lexer/lexer.js";
import type { Span } from "../source.js";
import {
	type Argument,
	type BinaryOperator,
	ESCAPE_STRATEGIES,
	type EscapeStrategy,
	type Expression,
	type FilterCall,
	type HashEntry,
	type Param,
	type PlacedStatement,
	type PropParam,
	type PropType,
	type ShapeKey,
	type Spread,
	type Statement,
	type TemplateNode,
	TYPE_NAMES,
	type TypeName,
} from "./ast.js";
import { arrangeIndentation } from "./indent.js";

const isTypeName = (name: string): name is TypeName =>
	(TYPE_NAMES as readonly string[]).includes(name);

export type ParseOptions = {
	/** Says whether a name is a registered test, so the parser can read two-word tests such as `divisible by`. */
	isTest: (name: string) => boolean;
};

export type ParseResult = { ast: TemplateNode; problems: LexProblem[] };

/** Names that cannot be declared as variables, because Kiln uses them itself. */
export const RESERVED_NAMES = new Set([
	"true",
	"false",
	"null",
	"and",
	"or",
	"not",
	"in",
	"is",
	"loop",
	"slots",
]);

/** Parses template source into a syntax tree, collecting every problem instead of stopping at the first. */
export const parse = (text: string, options: ParseOptions): ParseResult => {
	const lexed = lex(text);
	const parser = new Parser(lexed.tokens, options);
	const ast = parser.parseTemplate(text.length);
	arrangeIndentation(ast, text, lexed, parser.placed);
	return { ast, problems: [...lexed.problems, ...parser.problems] };
};

class ParseFailure {
	constructor(
		readonly code: string,
		readonly message: string,
		readonly span: Span,
	) {}
}

type BodyResult = {
	body: Statement[];
	/** The end tag's name token, already consumed. Null when the template ended or an outer tag's end was found. */
	end: Token | null;
};

/** Words that can follow a one-word test, so they never form part of a two-word test name. */
const NOT_TEST_WORDS = new Set([
	"and",
	"or",
	"not",
	"in",
	"is",
	"starts",
	"ends",
	"with",
	"ignore",
	"as",
]);

const COMPARISON_PUNCTUATORS = new Set(["==", "!=", "<", ">", "<=", ">="]);

const describeToken = (token: Token): string => {
	switch (token.type) {
		case "eof":
			return "the end of the template";
		case "tagClose":
			return '"%}"';
		case "outputClose":
			return '"}}"';
		case "text":
			return "text";
		case "string":
		case "stringStart":
			return "a string";
		case "number":
			return `number ${token.value}`;
		default:
			return `"${token.value}"`;
	}
};

class Parser {
	readonly problems: LexProblem[] = [];
	/** Every tag that inserts content, for `arrangeIndentation`. */
	readonly placed: PlacedStatement[] = [];
	readonly #tokens: Token[];
	readonly #options: ParseOptions;
	#index = 0;
	#lastEnd = 0;
	#nesting = 0;
	/** End tag names of every open block tag, innermost last. */
	readonly #endStack: (readonly string[])[] = [];

	constructor(tokens: Token[], options: ParseOptions) {
		this.#tokens = tokens;
		this.#options = options;
	}

	parseTemplate(length: number): TemplateNode {
		const { body } = this.#parseBody([]);
		return { type: "Template", body, span: { start: 0, end: length } };
	}

	// Token helpers

	#peek(offset = 0): Token {
		return (
			this.#tokens[this.#index + offset] ??
			(this.#tokens[this.#tokens.length - 1] as Token)
		);
	}

	#next(): Token {
		const token = this.#peek();
		if (token.type !== "eof") this.#index++;
		this.#lastEnd = token.end;
		return token;
	}

	#isPunct(value: string, offset = 0): boolean {
		const token = this.#peek(offset);
		return token.type === "punct" && token.value === value;
	}

	#isName(value: string, offset = 0): boolean {
		const token = this.#peek(offset);
		return token.type === "name" && token.value === value;
	}

	#fail(
		message: string,
		token = this.#peek(),
		code = "unexpected-token",
	): never {
		throw new ParseFailure(code, message, {
			start: token.start,
			end: Math.max(token.end, token.start + 1),
		});
	}

	#expectPunct(value: string): Token {
		if (!this.#isPunct(value)) {
			this.#fail(
				`Expected "${value}" but found ${describeToken(this.#peek())}`,
			);
		}
		return this.#next();
	}

	#expectName(what = "a name"): Token {
		const token = this.#peek();
		if (token.type !== "name") {
			this.#fail(`Expected ${what} but found ${describeToken(token)}`);
		}
		return this.#next();
	}

	#expectKeyword(value: string): Token {
		if (!this.#isName(value)) {
			this.#fail(
				`Expected "${value}" but found ${describeToken(this.#peek())}`,
			);
		}
		return this.#next();
	}

	#expectTagEnd(): Token {
		const token = this.#peek();
		if (token.type !== "tagClose") {
			this.#fail(`Expected "%}" but found ${describeToken(token)}`);
		}
		return this.#next();
	}

	#expectDeclarableName(what: string): Token {
		const token = this.#expectName(what);
		if (RESERVED_NAMES.has(token.value)) {
			this.#problem(
				"reserved-name",
				`"${token.value}" is reserved and cannot be used as a name`,
				token,
			);
		}
		return token;
	}

	#problem(code: string, message: string, span: Span): void {
		this.problems.push({
			code,
			message,
			span: { start: span.start, end: span.end },
		});
	}

	/** Skips to just after the end of the current tag or output. */
	#recover(): void {
		for (;;) {
			const token = this.#peek();
			if (token.type === "eof") return;
			if (token.type === "tagClose" || token.type === "outputClose") {
				this.#next();
				return;
			}
			if (
				token.type === "text" ||
				token.type === "tagOpen" ||
				token.type === "outputOpen"
			) {
				return;
			}
			this.#next();
		}
	}

	#record(failure: unknown): void {
		if (!(failure instanceof ParseFailure)) throw failure;
		this.#problem(failure.code, failure.message, failure.span);
		this.#recover();
	}

	/**
	 * Parses a block tag's header and its `%}`. If that fails, records the problem and skips to the end of the tag, so the body still parses.
	 */
	#header<T>(parse: () => T, fallback: T): T {
		try {
			const result = parse();
			this.#expectTagEnd();
			return result;
		} catch (failure) {
			this.#record(failure);
			return fallback;
		}
	}

	#invalid(): Expression {
		const token = this.#peek();
		return { type: "Invalid", span: { start: token.start, end: token.end } };
	}

	// Statements

	#parseBody(ends: readonly string[]): BodyResult {
		this.#enter();
		const body: Statement[] = [];
		this.#endStack.push(ends);
		try {
			for (;;) {
				const token = this.#peek();
				switch (token.type) {
					case "eof":
						return { body, end: null };
					case "text": {
						this.#next();
						const previous = body[body.length - 1];
						if (previous?.type === "Text") {
							previous.value += token.value;
							previous.span = { start: previous.span.start, end: token.end };
						} else {
							body.push({
								type: "Text",
								value: token.value,
								span: { start: token.start, end: token.end },
							});
						}
						break;
					}
					case "outputOpen":
						this.#parseOutput(body);
						break;
					case "tagOpen": {
						const name = this.#peek(1);
						if (name.type === "name") {
							if (ends.includes(name.value)) {
								this.#next();
								this.#next();
								return { body, end: name };
							}
							if (this.#endStack.some((outer) => outer.includes(name.value))) {
								return { body, end: null };
							}
						}
						this.#parseTag(body);
						break;
					}
					default:
						// Only reachable after a lexer problem. Skip the stray token.
						this.#next();
				}
			}
		} finally {
			this.#endStack.pop();
			this.#nesting--;
		}
	}

	#parseOutput(body: Statement[]): void {
		const open = this.#next();
		try {
			const expression = this.#parseExpression();
			const close = this.#peek();
			if (close.type !== "outputClose") {
				this.#fail(`Expected "}}" but found ${describeToken(close)}`);
			}
			this.#next();
			body.push({
				type: "Output",
				expression,
				span: { start: open.start, end: close.end },
			});
		} catch (failure) {
			this.#record(failure);
		}
	}

	#parseTag(body: Statement[]): void {
		const open = this.#next();
		const nameToken = this.#peek();
		if (nameToken.type !== "name") {
			this.#problem(
				"unexpected-token",
				`Expected a tag name but found ${describeToken(nameToken)}`,
				nameToken,
			);
			this.#recover();
			return;
		}
		this.#next();
		const name = nameToken.value;

		try {
			const statement = this.#parseNamedTag(name, open, nameToken);
			if (statement) body.push(statement);
		} catch (failure) {
			this.#record(failure);
		}
	}

	#parseNamedTag(
		name: string,
		open: Token,
		nameToken: Token,
	): Statement | null {
		switch (name) {
			case "if":
				return this.#parseIf(open);
			case "for":
				return this.#parseFor(open);
			case "set":
				return this.#parseSet(open);
			case "props":
				return this.#parseProps(open);
			case "extends": {
				const template = this.#parseExpression();
				const close = this.#expectTagEnd();
				return {
					type: "Extends",
					template,
					span: { start: open.start, end: close.end },
				};
			}
			case "block":
				return this.#parseBlock(open);
			case "include":
				return this.#parseInclude(open);
			case "component":
				return this.#parseComponent(open);
			case "slot":
				return this.#parseSlot(open);
			case "macro":
				return this.#parseMacro(open);
			case "import":
				return this.#parseImport(open);
			case "from":
				return this.#parseFromImport(open);
			case "with":
				return this.#parseWith(open);
			case "cache":
				return this.#parseCache(open);
			case "island":
				return this.#parseIsland(open);
			case "outlet": {
				const name = this.#parseStringLiteral("an outlet name");
				const close = this.#expectTagEnd();
				return this.#placed({
					type: "Outlet",
					name,
					span: { start: open.start, end: close.end },
				});
			}
			case "flush": {
				const close = this.#expectTagEnd();
				return { type: "Flush", span: { start: open.start, end: close.end } };
			}
			case "add":
				return this.#parseAdd(open);
			case "apply":
				return this.#parseApply(open);
			case "autoescape":
				return this.#parseAutoescape(open);
			case "verbatim":
				return this.#parseVerbatim(open);
			default: {
				const stray =
					name.startsWith("end") ||
					name === "else" ||
					name === "elseif" ||
					name === "fill";
				this.#problem(
					stray ? "unexpected-tag" : "unknown-tag",
					stray
						? `"${name}" has no matching opening tag here`
						: `Unknown tag "${name}"`,
					nameToken,
				);
				this.#recover();
				return null;
			}
		}
	}

	/** Reports a block tag whose end tag never came. */
	#unclosed(name: string, open: Token, endName: string): void {
		this.#problem(
			"unclosed-block",
			`"${name}" is missing its "${endName}" tag`,
			{ start: open.start, end: open.end },
		);
	}

	/** Consumes an end tag's `%}`, plus an optional repeated name such as `endblock content`. */
	#finishEndTag(expectedName?: string): void {
		try {
			if (expectedName !== undefined && this.#peek().type === "name") {
				const repeated = this.#next();
				if (repeated.value !== expectedName) {
					this.#problem(
						"mismatched-end",
						`End tag names "${repeated.value}" but closes "${expectedName}"`,
						repeated,
					);
				}
			}
			this.#expectTagEnd();
		} catch (failure) {
			this.#record(failure);
		}
	}

	#parseIf(open: Token): Statement {
		const branches: { test: Expression; body: Statement[] }[] = [];
		let test = this.#header(() => this.#parseExpression(), this.#invalid());
		let alternate: Statement[] | null = null;

		for (;;) {
			const { body, end } = this.#parseBody(["elseif", "else", "endif"]);
			branches.push({ test, body });
			if (!end) {
				this.#unclosed("if", open, "endif");
				break;
			}
			if (end.value === "elseif") {
				test = this.#header(() => this.#parseExpression(), this.#invalid());
				continue;
			}
			if (end.value === "else") {
				this.#finishEndTag();
				const rest = this.#parseBody(["endif"]);
				alternate = rest.body;
				if (rest.end) this.#finishEndTag();
				else this.#unclosed("if", open, "endif");
				break;
			}
			this.#finishEndTag();
			break;
		}
		return {
			type: "If",
			branches,
			alternate,
			span: { start: open.start, end: this.#lastEnd },
		};
	}

	#parseFor(open: Token): Statement {
		const header = this.#header(
			() => {
				let keyName: string | null = null;
				let valueName = this.#expectDeclarableName("a loop variable").value;
				if (this.#isPunct(",")) {
					this.#next();
					keyName = valueName;
					valueName = this.#expectDeclarableName("a loop variable").value;
				}
				this.#expectKeyword("in");
				const iterable = this.#parseExpression();
				return { keyName, valueName, iterable };
			},
			{ keyName: null, valueName: "_", iterable: this.#invalid() },
		);

		const { body, end } = this.#parseBody(["else", "endfor"]);
		let alternate: Statement[] | null = null;
		if (!end) this.#unclosed("for", open, "endfor");
		else if (end.value === "else") {
			this.#finishEndTag();
			const rest = this.#parseBody(["endfor"]);
			alternate = rest.body;
			if (rest.end) this.#finishEndTag();
			else this.#unclosed("for", open, "endfor");
		} else this.#finishEndTag();

		return {
			type: "For",
			...header,
			body,
			alternate,
			span: { start: open.start, end: this.#lastEnd },
		};
	}

	#parseSet(open: Token): Statement {
		const name = this.#expectDeclarableName("a variable name").value;
		if (this.#isPunct("=")) {
			this.#next();
			const value = this.#parseExpression();
			const close = this.#expectTagEnd();
			return {
				type: "Set",
				name,
				value,
				span: { start: open.start, end: close.end },
			};
		}
		this.#expectTagEnd();
		const { body, end } = this.#parseBody(["endset"]);
		if (end) this.#finishEndTag();
		else this.#unclosed("set", open, "endset");
		return {
			type: "SetBlock",
			name,
			body,
			span: { start: open.start, end: this.#lastEnd },
		};
	}

	/** Reads parameters for `macro` and `props`. Only `props` may declare types, so macros' `type` is always null. */
	#parseParams(closing: string | null, typed = false): PropParam[] {
		const params: PropParam[] = [];
		// A rest prop, `...name`, ends the list. `#parseProps` reads it.
		const done = () =>
			closing === null
				? this.#peek().type === "tagClose" || this.#isPunct("...")
				: this.#isPunct(closing);
		while (!done()) {
			const nameToken = this.#expectDeclarableName("a parameter name");
			if (params.some((param) => param.name === nameToken.value)) {
				this.#problem(
					"duplicate-parameter",
					`"${nameToken.value}" is declared more than once`,
					nameToken,
				);
			}
			let type: PropType[] | null = null;
			if (typed && this.#isPunct(":")) {
				this.#next();
				type = this.#parsePropType();
			}
			let defaultValue: Expression | null = null;
			if (this.#isPunct("=")) {
				this.#next();
				defaultValue = this.#parseExpression();
			}
			params.push({
				name: nameToken.value,
				type,
				default: defaultValue,
				span: { start: nameToken.start, end: this.#lastEnd },
			});
			if (!this.#isPunct(",")) break;
			this.#next();
		}
		return params;
	}

	/** Reads a prop type such as `string | null`, `"primary" | "secondary"`, `Post[]` or `{ name: string }`. */
	#parsePropType(): PropType[] {
		this.#enter();
		const nesting = this.#nesting;
		try {
			const members: PropType[] = [];
			for (;;) {
				let type = this.#parsePropTypeTerm();
				// Each `[]` nests the type inside a list, so it counts as a level.
				while (this.#isPunct("[") && this.#isPunct("]", 1)) {
					this.#enter();
					this.#next();
					this.#next();
					type = [{ list: type }];
				}
				this.#nesting = nesting;
				members.push(...type);
				if (!this.#isPunct("|")) return members;
				this.#next();
			}
		} finally {
			this.#nesting = nesting - 1;
		}
	}

	/** Reads one part of a union. Brackets return the union inside them, so `(2 | 3)[]` lists either. */
	#parsePropTypeTerm(): PropType[] {
		const token = this.#peek();
		if (token.type === "punct" && token.value === "(") {
			this.#next();
			const inner = this.#parsePropType();
			this.#expectPunct(")");
			return inner;
		}
		if (token.type === "punct" && token.value === "{") {
			return [{ shape: this.#parseShape() }];
		}
		this.#next();
		if (token.type === "string") return [{ literal: token.value }];
		if (token.type === "number") return [{ literal: Number(token.value) }];
		if (token.type === "name" && isTypeName(token.value)) return [token.value];
		// Host types start with a capital letter, so they never clash with built-in names.
		if (token.type === "name" && /^[A-Z]/.test(token.value)) {
			return [{ named: token.value }];
		}
		if (token.type === "name") {
			this.#problem("unknown-type", `Unknown type "${token.value}"`, token);
			return [];
		}
		return this.#fail(
			`Expected a type but found ${describeToken(token)}`,
			token,
		);
	}

	/** Reads a shape type such as `{ name: string, url?: string }`. */
	#parseShape(): ShapeKey[] {
		this.#expectPunct("{");
		const keys: ShapeKey[] = [];
		while (!this.#isPunct("}")) {
			const token = this.#next();
			if (token.type !== "name" && token.type !== "string") {
				this.#fail(`Expected a key but found ${describeToken(token)}`, token);
			}
			if (keys.some((key) => key.name === token.value)) {
				this.#problem(
					"duplicate-key",
					`"${token.value}" is declared more than once`,
					token,
				);
			}
			// The lexer reads `?:` as one token, as in `url?: string`.
			const optional = this.#isPunct("?:") || this.#isPunct("?");
			if (this.#isPunct("?:")) this.#next();
			else {
				if (optional) this.#next();
				this.#expectPunct(":");
			}
			keys.push({ name: token.value, optional, type: this.#parsePropType() });
			if (!this.#isPunct(",")) break;
			this.#next();
		}
		this.#expectPunct("}");
		return keys;
	}

	#parseProps(open: Token): Statement {
		const props = this.#parseParams(null, true);
		let rest: string | null = null;
		if (this.#isPunct("...")) {
			this.#next();
			const nameToken = this.#expectDeclarableName("a rest prop name");
			if (props.some((prop) => prop.name === nameToken.value)) {
				this.#problem(
					"duplicate-parameter",
					`"${nameToken.value}" is declared more than once`,
					nameToken,
				);
			}
			rest = nameToken.value;
			if (this.#isPunct(",")) this.#next();
			if (this.#peek().type !== "tagClose") {
				this.#fail("The rest prop must come last, with no type or default");
			}
		}
		const close = this.#expectTagEnd();
		return {
			type: "Props",
			props,
			rest,
			span: { start: open.start, end: close.end },
		};
	}

	#parseBlock(open: Token): Statement {
		const name = this.#expectName("a block name").value;
		if (this.#peek().type !== "tagClose") {
			// Short form: {% block title page.title %}
			const expression = this.#parseExpression();
			const close = this.#expectTagEnd();
			return this.#placed({
				type: "Block",
				name,
				body: [
					{
						type: "Output",
						expression,
						span: { start: expression.span.start, end: expression.span.end },
					},
				],
				span: { start: open.start, end: close.end },
			});
		}
		this.#expectTagEnd();
		const { body, end } = this.#parseBody(["endblock"]);
		if (end) this.#finishEndTag(name);
		else this.#unclosed("block", open, "endblock");
		return this.#placed({
			type: "Block",
			name,
			body,
			span: { start: open.start, end: this.#lastEnd },
		});
	}

	#parseInclude(open: Token): Statement {
		const template = this.#parseExpression();
		let withValue: Expression | null = null;
		let ignoreMissing = false;
		if (this.#isName("with")) {
			this.#next();
			withValue = this.#parseExpression();
		}
		if (this.#isName("ignore")) {
			this.#next();
			this.#expectKeyword("missing");
			ignoreMissing = true;
		}
		const close = this.#expectTagEnd();
		return this.#placed({
			type: "Include",
			template,
			with: withValue,
			ignoreMissing,
			span: { start: open.start, end: close.end },
		});
	}

	#parseComponent(open: Token): Statement {
		const header = this.#header(
			() => {
				const template = this.#parseExpression();
				let withValue: Expression | null = null;
				if (this.#isName("with")) {
					this.#next();
					withValue = this.#parseExpression();
				}
				return { template, with: withValue };
			},
			{ template: this.#invalid(), with: null },
		);

		const body: Statement[] = [];
		const fills: { name: string; body: Statement[]; span: Span }[] = [];
		for (;;) {
			const part = this.#parseBody(["fill", "endcomponent"]);
			body.push(...part.body);
			if (!part.end) {
				this.#unclosed("component", open, "endcomponent");
				break;
			}
			if (part.end.value === "endcomponent") {
				this.#finishEndTag();
				break;
			}

			const fillStart = this.#tokens[this.#index - 2] ?? part.end;
			const name = this.#header(
				() => this.#parseStringLiteral("a slot name"),
				"",
			);
			const fill = this.#parseBody(["endfill"]);
			if (fill.end) this.#finishEndTag();
			else this.#unclosed("fill", fillStart, "endfill");
			if (fills.some((existing) => existing.name === name)) {
				this.#problem(
					"duplicate-fill",
					`Slot "${name}" is filled more than once`,
					{ start: fillStart.start, end: fillStart.end },
				);
			}
			fills.push({
				name,
				body: fill.body,
				span: { start: fillStart.start, end: this.#lastEnd },
			});
		}

		return this.#placed({
			type: "Component",
			...header,
			fills,
			body,
			span: { start: open.start, end: this.#lastEnd },
		});
	}

	#placed<T extends PlacedStatement>(node: T): T {
		this.placed.push(node);
		return node;
	}

	#parseStringLiteral(what: string): string {
		const token = this.#peek();
		if (token.type !== "string") {
			this.#fail(
				`Expected ${what} as a string but found ${describeToken(token)}`,
			);
		}
		this.#next();
		return token.value;
	}

	#parseSlot(open: Token): Statement {
		let name = "default";
		if (this.#peek().type !== "tagClose") {
			name = this.#parseStringLiteral("a slot name");
		}
		this.#expectTagEnd();
		const { body, end } = this.#parseBody(["endslot"]);
		if (end) this.#finishEndTag();
		else this.#unclosed("slot", open, "endslot");
		return this.#placed({
			type: "Slot",
			name,
			body,
			span: { start: open.start, end: this.#lastEnd },
		});
	}

	#parseMacro(open: Token): Statement {
		const header = this.#header(
			() => {
				const name = this.#expectDeclarableName("a macro name").value;
				this.#expectPunct("(");
				const params = this.#parseParams(")");
				this.#expectPunct(")");
				return { name, params };
			},
			{ name: "", params: [] as Param[] },
		);
		const { body, end } = this.#parseBody(["endmacro"]);
		if (end) this.#finishEndTag(header.name);
		else this.#unclosed("macro", open, "endmacro");
		return {
			type: "Macro",
			...header,
			body,
			span: { start: open.start, end: this.#lastEnd },
		};
	}

	#parseImport(open: Token): Statement {
		const template = this.#parseStringLiteral("a template name");
		this.#expectKeyword("as");
		const alias = this.#expectDeclarableName("an alias").value;
		const close = this.#expectTagEnd();
		return {
			type: "Import",
			template,
			alias,
			span: { start: open.start, end: close.end },
		};
	}

	#parseFromImport(open: Token): Statement {
		const template = this.#parseStringLiteral("a template name");
		this.#expectKeyword("import");
		const names: { name: string; alias: string; span: Span }[] = [];
		do {
			if (names.length > 0) this.#next();
			const nameToken = this.#expectName("a macro name");
			let alias = nameToken.value;
			if (this.#isName("as")) {
				this.#next();
				alias = this.#expectDeclarableName("an alias").value;
			}
			names.push({
				name: nameToken.value,
				alias,
				span: { start: nameToken.start, end: this.#lastEnd },
			});
		} while (this.#isPunct(","));
		const close = this.#expectTagEnd();
		return {
			type: "FromImport",
			template,
			names,
			span: { start: open.start, end: close.end },
		};
	}

	#parseWith(open: Token): Statement {
		const value = this.#header(() => this.#parseExpression(), this.#invalid());
		const { body, end } = this.#parseBody(["endwith"]);
		if (end) this.#finishEndTag();
		else this.#unclosed("with", open, "endwith");
		return {
			type: "With",
			value,
			body,
			span: { start: open.start, end: this.#lastEnd },
		};
	}

	#parseAdd(open: Token): Statement {
		const { outlet, once } = this.#header(
			() => {
				this.#expectKeyword("to");
				const outlet = this.#parseStringLiteral("an outlet name");
				const once = this.#isName("once");
				if (once) this.#next();
				return { outlet, once };
			},
			{ outlet: "", once: false },
		);
		const { body, end } = this.#parseBody(["endadd"]);
		if (end) this.#finishEndTag();
		else this.#unclosed("add", open, "endadd");
		return {
			type: "Add",
			outlet,
			once,
			body,
			span: { start: open.start, end: this.#lastEnd },
		};
	}

	#parseCache(open: Token): Statement {
		const { key, seconds } = this.#header(
			() => {
				const key = this.#parseExpression();
				let seconds: Expression | null = null;
				if (this.#isName("for")) {
					this.#next();
					seconds = this.#parseExpression();
				}
				return { key, seconds };
			},
			{ key: this.#invalid(), seconds: null },
		);
		const { body, end } = this.#parseBody(["endcache"]);
		if (end) this.#finishEndTag();
		else this.#unclosed("cache", open, "endcache");
		return {
			type: "Cache",
			key,
			seconds,
			body,
			span: { start: open.start, end: this.#lastEnd },
		};
	}

	#parseIsland(open: Token): Statement {
		const header = this.#header(
			() => {
				const template = this.#parseExpression();
				let withValue: Expression | null = null;
				if (this.#isName("with")) {
					this.#next();
					withValue = this.#parseExpression();
				}
				return { template, with: withValue };
			},
			{ template: this.#invalid(), with: null },
		);
		const { body, end } = this.#parseBody(["endisland"]);
		if (end) this.#finishEndTag();
		else this.#unclosed("island", open, "endisland");
		return this.#placed({
			type: "Island",
			...header,
			body,
			span: { start: open.start, end: this.#lastEnd },
		});
	}

	#parseApply(open: Token): Statement {
		const filters = this.#header(() => {
			const list: FilterCall[] = [];
			do {
				if (list.length > 0) this.#next();
				const nameToken = this.#expectName("a filter name");
				const args = this.#isPunct("(") ? this.#parseArguments() : [];
				list.push({
					name: nameToken.value,
					args,
					span: { start: nameToken.start, end: this.#lastEnd },
				});
			} while (this.#isPunct("|"));
			return list;
		}, [] as FilterCall[]);
		const { body, end } = this.#parseBody(["endapply"]);
		if (end) this.#finishEndTag();
		else this.#unclosed("apply", open, "endapply");
		return {
			type: "Apply",
			filters,
			body,
			span: { start: open.start, end: this.#lastEnd },
		};
	}

	#parseAutoescape(open: Token): Statement {
		const strategy = this.#header((): EscapeStrategy | false => {
			const token = this.#peek();
			if (token.type === "tagClose") return "html";
			if (token.type === "name" && token.value === "false") {
				this.#next();
				return false;
			}
			const value = this.#parseStringLiteral("an escaping strategy");
			if (!ESCAPE_STRATEGIES.includes(value as EscapeStrategy)) {
				this.#fail(
					`Unknown escaping strategy "${value}". Use ${ESCAPE_STRATEGIES.map((s) => `"${s}"`).join(", ")} or false`,
					token,
					"unknown-strategy",
				);
			}
			return value as EscapeStrategy;
		}, "html");
		const { body, end } = this.#parseBody(["endautoescape"]);
		if (end) this.#finishEndTag();
		else this.#unclosed("autoescape", open, "endautoescape");
		return {
			type: "Autoescape",
			strategy,
			body,
			span: { start: open.start, end: this.#lastEnd },
		};
	}

	#parseVerbatim(open: Token): Statement | null {
		this.#expectTagEnd();
		let value = "";
		let start = this.#lastEnd;
		let end = start;
		const token = this.#peek();
		if (token.type === "text") {
			this.#next();
			value = token.value;
			start = token.start;
			end = token.end;
		}
		if (this.#peek().type === "tagOpen" && this.#isName("endverbatim", 1)) {
			this.#next();
			this.#next();
			this.#finishEndTag();
		}
		// The lexer already reported a missing `endverbatim`.
		if (value === "") return null;
		return {
			type: "Text",
			value,
			span: { start: Math.max(start, open.end), end },
		};
	}

	// Expressions

	/** Guards against source nested so deeply that parsing it would overflow the call stack. */
	#enter(): void {
		if (++this.#nesting > MAX_NESTING) {
			this.#nesting--;
			this.#fail(
				`Template is nested more than ${MAX_NESTING} levels deep`,
				this.#peek(),
				"too-deep",
			);
		}
	}

	#parseExpression(): Expression {
		this.#enter();
		try {
			return this.#parseConditional();
		} finally {
			this.#nesting--;
		}
	}

	#parseConditional(): Expression {
		const test = this.#parseCoalesce();
		if (this.#isPunct("?")) {
			this.#next();
			const consequent = this.#parseExpression();
			let alternate: Expression | null = null;
			if (this.#isPunct(":")) {
				this.#next();
				alternate = this.#parseExpression();
			}
			return {
				type: "Conditional",
				test,
				consequent,
				alternate,
				span: { start: test.span.start, end: this.#lastEnd },
			};
		}
		if (this.#isPunct("?:")) {
			this.#next();
			const right = this.#parseExpression();
			return this.#binary("?:", test, right);
		}
		return test;
	}

	#binary(
		operator: BinaryOperator,
		left: Expression,
		right: Expression,
	): Expression {
		return {
			type: "Binary",
			operator,
			left,
			right,
			span: { start: left.span.start, end: right.span.end },
		};
	}

	#parseCoalesce(): Expression {
		const left = this.#parseOr();
		if (!this.#isPunct("??")) return left;
		this.#next();
		// `??` groups to the right, so each one nests the rest of the chain inside it.
		this.#enter();
		try {
			return this.#binary("??", left, this.#parseCoalesce());
		} finally {
			this.#nesting--;
		}
	}

	#parseOr(): Expression {
		let left = this.#parseAnd();
		while (this.#isName("or")) {
			this.#next();
			left = this.#binary("or", left, this.#parseAnd());
		}
		return left;
	}

	#parseAnd(): Expression {
		let left = this.#parseNot();
		while (this.#isName("and")) {
			this.#next();
			left = this.#binary("and", left, this.#parseNot());
		}
		return left;
	}

	#parseNot(): Expression {
		this.#enter();
		try {
			return this.#parseNotInner();
		} finally {
			this.#nesting--;
		}
	}

	#parseNotInner(): Expression {
		if (this.#isName("not")) {
			const token = this.#next();
			const operand = this.#parseNot();
			return {
				type: "Unary",
				operator: "not",
				operand,
				span: { start: token.start, end: operand.span.end },
			};
		}
		return this.#parseComparison();
	}

	/** Reads a comparison operator at the cursor without consuming it, and how many tokens it spans. */
	#comparisonAhead(): {
		operator: BinaryOperator | "is";
		length: number;
	} | null {
		const token = this.#peek();
		if (token.type === "punct" && COMPARISON_PUNCTUATORS.has(token.value)) {
			return { operator: token.value as BinaryOperator, length: 1 };
		}
		if (token.type !== "name") return null;
		switch (token.value) {
			case "in":
				return { operator: "in", length: 1 };
			case "is":
				return { operator: "is", length: 1 };
			case "not":
				return this.#isName("in", 1) ? { operator: "not in", length: 2 } : null;
			case "starts":
				return this.#isName("with", 1)
					? { operator: "starts with", length: 2 }
					: null;
			case "ends":
				return this.#isName("with", 1)
					? { operator: "ends with", length: 2 }
					: null;
			default:
				return null;
		}
	}

	#parseComparison(): Expression {
		const left = this.#parseRange();
		const ahead = this.#comparisonAhead();
		if (!ahead) return left;

		let result: Expression;
		if (ahead.operator === "is") {
			result = this.#parseTest(left);
		} else {
			for (let i = 0; i < ahead.length; i++) this.#next();
			result = this.#binary(ahead.operator, left, this.#parseRange());
		}

		if (this.#comparisonAhead()) {
			this.#fail(
				'Comparisons cannot be chained. Join them with "and" or "or"',
				this.#peek(),
				"chained-comparison",
			);
		}
		return result;
	}

	#parseTest(input: Expression): Expression {
		this.#next();
		let negated = false;
		if (this.#isName("not")) {
			this.#next();
			negated = true;
		}
		const first = this.#expectName("a test name");
		let name = first.value;
		let nameEnd = first.end;
		const second = this.#peek();
		// Tests can be two words, such as `divisible by`. An unknown pair is kept together, so the error names the whole test.
		if (
			second.type === "name" &&
			(this.#options.isTest(`${name} ${second.value}`) ||
				(!this.#options.isTest(name) && !NOT_TEST_WORDS.has(second.value)))
		) {
			this.#next();
			name = `${name} ${second.value}`;
			nameEnd = second.end;
		}
		const args = this.#isPunct("(") ? this.#parseArguments() : [];
		return {
			type: "Test",
			name,
			nameSpan: { start: first.start, end: nameEnd },
			input,
			args,
			negated,
			span: { start: input.span.start, end: this.#lastEnd },
		};
	}

	#parseRange(): Expression {
		const left = this.#parseConcat();
		if (this.#isPunct("..")) {
			this.#next();
			return this.#binary("..", left, this.#parseConcat());
		}
		return left;
	}

	#parseConcat(): Expression {
		let left = this.#parseAdditive();
		while (this.#isPunct("~")) {
			this.#next();
			left = this.#binary("~", left, this.#parseAdditive());
		}
		return left;
	}

	#parseAdditive(): Expression {
		let left = this.#parseMultiplicative();
		while (this.#isPunct("+") || this.#isPunct("-")) {
			const operator = this.#next().value as "+" | "-";
			left = this.#binary(operator, left, this.#parseMultiplicative());
		}
		return left;
	}

	#parseMultiplicative(): Expression {
		let left = this.#parseUnary();
		for (;;) {
			const token = this.#peek();
			if (
				token.type === "punct" &&
				(token.value === "*" ||
					token.value === "/" ||
					token.value === "//" ||
					token.value === "%")
			) {
				this.#next();
				left = this.#binary(
					token.value as BinaryOperator,
					left,
					this.#parseUnary(),
				);
			} else return left;
		}
	}

	#parseUnary(): Expression {
		this.#enter();
		try {
			return this.#parseUnaryInner();
		} finally {
			this.#nesting--;
		}
	}

	#parseUnaryInner(): Expression {
		if (this.#isPunct("-") || this.#isPunct("+")) {
			const token = this.#next();
			const operand = this.#parseUnary();
			return {
				type: "Unary",
				operator: token.value as "-" | "+",
				operand,
				span: { start: token.start, end: operand.span.end },
			};
		}
		return this.#parsePower();
	}

	#parsePower(): Expression {
		const base = this.#parsePostfix();
		if (this.#isPunct("**")) {
			this.#next();
			return this.#binary("**", base, this.#parseUnary());
		}
		return base;
	}

	#parsePostfix(): Expression {
		let expression = this.#parsePrimary();
		let optional = false;
		const start = expression.span.start;
		const span = () => ({ start, end: this.#lastEnd });
		const closeChain = () => {
			if (optional) {
				expression = { type: "OptionalChain", expression, span: span() };
				optional = false;
			}
		};

		for (;;) {
			if (this.#isPunct(".") || this.#isPunct("?.")) {
				const isOptional = this.#next().value === "?.";
				if (isOptional) optional = true;
				if (isOptional && this.#isPunct("[")) {
					this.#next();
					const property = this.#parseExpression();
					this.#expectPunct("]");
					expression = {
						type: "Member",
						object: expression,
						property,
						optional: true,
						span: span(),
					};
					continue;
				}
				const token = this.#peek();
				if (token.type === "name") {
					this.#next();
					expression = {
						type: "Member",
						object: expression,
						property: {
							type: "Literal",
							value: token.value,
							span: { start: token.start, end: token.end },
						},
						optional: isOptional,
						span: span(),
					};
					continue;
				}
				if (token.type === "number" && /^\d+$/.test(token.value)) {
					this.#next();
					expression = {
						type: "Member",
						object: expression,
						property: {
							type: "Literal",
							value: Number(token.value),
							span: { start: token.start, end: token.end },
						},
						optional: isOptional,
						span: span(),
					};
					continue;
				}
				this.#fail(
					`Expected a property name but found ${describeToken(token)}`,
				);
			}

			if (this.#isPunct("[")) {
				this.#next();
				const property = this.#parseExpression();
				this.#expectPunct("]");
				expression = {
					type: "Member",
					object: expression,
					property,
					optional: false,
					span: span(),
				};
				continue;
			}

			if (this.#isPunct("(")) {
				const callee = expression;
				if (callee.type !== "Name" && callee.type !== "Member") {
					this.#fail(
						"Only named functions, macros and exposed methods can be called",
						this.#peek(),
						"invalid-call",
					);
				}
				const args = this.#parseArguments();
				expression = { type: "Call", callee, args, span: span() };
				continue;
			}

			if (this.#isPunct("|")) {
				closeChain();
				this.#next();
				const nameToken = this.#expectName("a filter name");
				const args = this.#isPunct("(") ? this.#parseArguments() : [];
				expression = {
					type: "Filter",
					name: nameToken.value,
					nameSpan: { start: nameToken.start, end: nameToken.end },
					input: expression,
					args,
					span: span(),
				};
				continue;
			}

			closeChain();
			return expression;
		}
	}

	#parsePrimary(): Expression {
		const token = this.#peek();
		const tokenSpan = { start: token.start, end: token.end };

		switch (token.type) {
			case "number":
				this.#next();
				return { type: "Literal", value: Number(token.value), span: tokenSpan };
			case "string":
				this.#next();
				return { type: "Literal", value: token.value, span: tokenSpan };
			case "stringStart":
				return this.#parseInterpolation();
			case "name": {
				switch (token.value) {
					case "true":
					case "false":
						this.#next();
						return {
							type: "Literal",
							value: token.value === "true",
							span: tokenSpan,
						};
					case "null":
						this.#next();
						return { type: "Literal", value: null, span: tokenSpan };
					case "and":
					case "or":
					case "not":
					case "in":
					case "is":
						this.#fail(`Expected a value but found "${token.value}"`);
				}
				if (this.#isPunct("=>", 1)) {
					this.#fail(
						"Arrow functions can only be passed as arguments to filters, functions and methods",
						token,
						"invalid-arrow",
					);
				}
				this.#next();
				return { type: "Name", name: token.value, span: tokenSpan };
			}
			case "punct":
				switch (token.value) {
					case "[":
						return this.#parseArray();
					case "{":
						return this.#parseHash();
					case "(": {
						if (this.#arrowAhead()) {
							this.#fail(
								"Arrow functions can only be passed as arguments to filters, functions and methods",
								token,
								"invalid-arrow",
							);
						}
						this.#next();
						const inner = this.#parseExpression();
						this.#expectPunct(")");
						return {
							...inner,
							span: { start: token.start, end: this.#lastEnd },
						};
					}
				}
		}
		return this.#fail(`Expected a value but found ${describeToken(token)}`);
	}

	#parseInterpolation(): Expression {
		const start = this.#next();
		const parts: Expression[] = [];
		for (;;) {
			const token = this.#peek();
			if (token.type === "stringEnd") {
				this.#next();
				break;
			}
			if (token.type === "string") {
				this.#next();
				parts.push({
					type: "Literal",
					value: token.value,
					span: { start: token.start, end: token.end },
				});
				continue;
			}
			if (token.type === "interpOpen") {
				this.#next();
				parts.push(this.#parseExpression());
				const close = this.#peek();
				if (close.type !== "interpClose") {
					this.#fail(`Expected "}" but found ${describeToken(close)}`);
				}
				this.#next();
				continue;
			}
			this.#fail(`Unexpected ${describeToken(token)} in string`);
		}
		return {
			type: "Interpolation",
			parts,
			span: { start: start.start, end: this.#lastEnd },
		};
	}

	#parseSpread(): Spread {
		const token = this.#next();
		const value = this.#parseExpression();
		return {
			type: "Spread",
			value,
			span: { start: token.start, end: value.span.end },
		};
	}

	#parseArray(): Expression {
		const open = this.#next();
		const elements: (Expression | Spread)[] = [];
		while (!this.#isPunct("]")) {
			elements.push(
				this.#isPunct("...") ? this.#parseSpread() : this.#parseExpression(),
			);
			if (!this.#isPunct(",")) break;
			this.#next();
		}
		this.#expectPunct("]");
		return {
			type: "Array",
			elements,
			span: { start: open.start, end: this.#lastEnd },
		};
	}

	#parseHash(): Expression {
		const open = this.#next();
		const entries: HashEntry[] = [];
		while (!this.#isPunct("}")) {
			if (this.#isPunct("...")) {
				entries.push(this.#parseSpread());
			} else {
				const token = this.#peek();
				let key: Expression;
				if (token.type === "name") {
					this.#next();
					key = {
						type: "Literal",
						value: token.value,
						span: { start: token.start, end: token.end },
					};
					if (!this.#isPunct(":")) {
						// Shorthand: { title } means { title: title }.
						if (RESERVED_NAMES.has(token.value) && token.value !== "loop") {
							this.#fail(`Expected ":" after "${token.value}"`);
						}
						entries.push({
							type: "Property",
							key,
							value: {
								type: "Name",
								name: token.value,
								span: { start: token.start, end: token.end },
							},
							span: { start: token.start, end: token.end },
						});
						if (!this.#isPunct(",")) break;
						this.#next();
						continue;
					}
				} else if (token.type === "string" || token.type === "number") {
					this.#next();
					key = {
						type: "Literal",
						value: token.value,
						span: { start: token.start, end: token.end },
					};
				} else if (this.#isPunct("(")) {
					this.#next();
					key = this.#parseExpression();
					this.#expectPunct(")");
				} else {
					this.#fail(`Expected a hash key but found ${describeToken(token)}`);
				}
				this.#expectPunct(":");
				const value = this.#parseExpression();
				entries.push({
					type: "Property",
					key,
					value,
					span: { start: token.start, end: value.span.end },
				});
			}
			if (!this.#isPunct(",")) break;
			this.#next();
		}
		this.#expectPunct("}");
		return {
			type: "Hash",
			entries,
			span: { start: open.start, end: this.#lastEnd },
		};
	}

	/** Checks whether the tokens at the cursor start an arrow function such as `(a, b) =>`. */
	#arrowAhead(): boolean {
		if (this.#peek().type === "name") return this.#isPunct("=>", 1);
		if (!this.#isPunct("(")) return false;
		let offset = 1;
		if (this.#isPunct(")", offset)) return this.#isPunct("=>", offset + 1);
		for (;;) {
			if (this.#peek(offset).type !== "name") return false;
			offset++;
			if (this.#isPunct(")", offset)) return this.#isPunct("=>", offset + 1);
			if (!this.#isPunct(",", offset)) return false;
			offset++;
		}
	}

	#parseArrow(): Expression {
		const start = this.#peek();
		const params: string[] = [];
		if (start.type === "name") {
			params.push(this.#expectDeclarableName("a parameter name").value);
		} else {
			this.#next();
			while (!this.#isPunct(")")) {
				params.push(this.#expectDeclarableName("a parameter name").value);
				if (!this.#isPunct(",")) break;
				this.#next();
			}
			this.#expectPunct(")");
		}
		this.#expectPunct("=>");
		const body = this.#parseExpression();
		return {
			type: "Arrow",
			params,
			body,
			span: { start: start.start, end: body.span.end },
		};
	}

	#parseArguments(): Argument[] {
		this.#expectPunct("(");
		const args: Argument[] = [];
		let named = false;
		while (!this.#isPunct(")")) {
			const token = this.#peek();
			if (this.#isPunct("...")) {
				if (named) {
					this.#fail(
						"Positional arguments cannot follow named arguments",
						this.#peek(),
						"positional-after-named",
					);
				}
				args.push(this.#parseSpread());
			} else if (token.type === "name" && this.#isPunct(":", 1)) {
				this.#next();
				this.#next();
				named = true;
				const value = this.#arrowAhead()
					? this.#parseArrow()
					: this.#parseExpression();
				args.push({
					type: "Named",
					name: token.value,
					value,
					span: { start: token.start, end: value.span.end },
				});
			} else {
				if (named) {
					this.#fail(
						"Positional arguments cannot follow named arguments",
						token,
						"positional-after-named",
					);
				}
				const value = this.#arrowAhead()
					? this.#parseArrow()
					: this.#parseExpression();
				args.push({ type: "Positional", value, span: value.span });
			}
			if (!this.#isPunct(",")) break;
			this.#next();
		}
		this.#expectPunct(")");
		return args;
	}
}
