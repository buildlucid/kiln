import {
	type Argument,
	type Expression,
	type HashEntry,
	type PropType,
	parse,
	type Span,
	type Statement,
	type TemplateNode,
} from "@lucidkiln/core/syntax";

/**
 * Where a variable's value comes from, so its type can be worked out.
 *
 * - `prop`: a `props` entry, or `rest` for `...attributes`.
 * - `set`: `set name = value`. `capture` is a `set` block, which holds markup.
 * - `item`, `key`: a `for` loop's value or key.
 * - `arrow`: an arrow function's parameter, `index` counting from 0, passed to `filter` with `input` before the `|`.
 * - `with`: a key of the hash a `with` tag passes.
 * - `param`, `import`: a macro argument, or a name brought in with `import` or `from`. Their types are unknown.
 */
export type BindingSource =
	| { kind: "prop"; type: PropType[] | null; optional: boolean }
	| { kind: "rest" }
	| { kind: "set"; value: Expression }
	| { kind: "capture" }
	| { kind: "item" | "key"; iterable: Expression }
	| { kind: "arrow"; filter: string; input: Expression; index: number }
	| { kind: "with"; value: Expression; key: string }
	| { kind: "param" | "import" };

/** A variable a template brings into scope: where its name is written, and the range of text that can see it. */
export type Binding = {
	name: string;
	source: BindingSource;
	/** The name where it's declared. */
	definition: Span;
	/** The scope it lives in. */
	scope: Span;
	/** It can be used from here to the end of `scope`. */
	from: number;
};

export type TemplateScopes = { ast: TemplateNode; bindings: Binding[] };

/** Whether a variable can be used at `offset`. A scope's end is exclusive, except at the end of the template. */
const sees = (binding: Binding, offset: number, length: number) =>
	offset >= binding.from &&
	(offset < binding.scope.end || binding.scope.end === length);

/** The offset of `name` as a whole word in `text`, searching `span` from `after`. Falls back to the span's start. */
const nameIn = (text: string, span: Span, name: string, after = span.start) => {
	const pattern = new RegExp(`(?<![\\w$])${name}(?![\\w$])`, "g");
	pattern.lastIndex = after;
	const match = pattern.exec(text.slice(0, span.end));
	const start = match ? match.index : span.start;
	return { start, end: start + name.length };
};

/** The expressions directly inside an expression. */
const childExpressions = (expression: Expression): Expression[] => {
	const ofArgs = (args: Argument[]) => args.map((arg) => arg.value);
	switch (expression.type) {
		case "Interpolation":
			return expression.parts;
		case "Array":
			return expression.elements.map((element) =>
				element.type === "Spread" ? element.value : element,
			);
		case "Hash":
			return expression.entries.flatMap((entry: HashEntry) =>
				entry.type === "Spread" ? [entry.value] : [entry.key, entry.value],
			);
		case "Unary":
			return [expression.operand];
		case "Binary":
			return [expression.left, expression.right];
		case "Conditional":
			return [
				expression.test,
				expression.consequent,
				...(expression.alternate ? [expression.alternate] : []),
			];
		case "Member":
			return [expression.object, expression.property];
		case "Call":
			return [expression.callee, ...ofArgs(expression.args)];
		case "Filter":
		case "Test":
			return [expression.input, ...ofArgs(expression.args)];
		case "Arrow":
			return [expression.body];
		case "OptionalChain":
			return [expression.expression];
		default:
			return [];
	}
};

/** The expressions a statement holds itself, not those in nested statements. */
const statementExpressions = (statement: Statement): Expression[] => {
	switch (statement.type) {
		case "Output":
			return [statement.expression];
		case "If":
			return statement.branches.map((branch) => branch.test);
		case "For":
			return [statement.iterable];
		case "Set":
			return [statement.value];
		case "Props":
			return statement.props.flatMap((prop) =>
				prop.default ? [prop.default] : [],
			);
		case "Extends":
			return [statement.template];
		case "Include":
		case "Component":
		case "Island":
			return [statement.template, ...(statement.with ? [statement.with] : [])];
		case "Macro":
			return statement.params.flatMap((param) =>
				param.default ? [param.default] : [],
			);
		case "With":
			return [statement.value];
		case "Cache":
			return [statement.key, ...(statement.seconds ? [statement.seconds] : [])];
		case "Apply":
			return statement.filters.flatMap((filter) =>
				filter.args.map((arg) => arg.value),
			);
		default:
			return [];
	}
};

/** The statement lists inside a statement, and whether each starts a new scope. */
const childBodies = (
	statement: Statement,
): { body: Statement[]; scoped: boolean }[] => {
	switch (statement.type) {
		case "If":
			return [
				...statement.branches.map((branch) => ({
					body: branch.body,
					scoped: false,
				})),
				...(statement.alternate
					? [{ body: statement.alternate, scoped: false }]
					: []),
			];
		case "For":
			return [
				{ body: statement.body, scoped: true },
				...(statement.alternate
					? [{ body: statement.alternate, scoped: false }]
					: []),
			];
		case "Component":
			return [
				{ body: statement.body, scoped: true },
				...statement.fills.map((fill) => ({ body: fill.body, scoped: true })),
			];
		case "SetBlock":
		case "Add":
		case "Cache":
		case "Apply":
		case "Autoescape":
		case "Island":
		case "Slot":
			return [{ body: statement.body, scoped: false }];
		case "Block":
		case "Macro":
		case "With":
			return [{ body: statement.body, scoped: true }];
		default:
			return [];
	}
};

/** Every expression in a list of statements, including nested ones, outermost first. */
export function* expressionsIn(statements: Statement[]): Generator<Expression> {
	const visit = function* (expression: Expression): Generator<Expression> {
		yield expression;
		for (const child of childExpressions(expression)) yield* visit(child);
	};
	for (const statement of statements) {
		for (const expression of statementExpressions(statement))
			yield* visit(expression);
		for (const { body } of childBodies(statement)) yield* expressionsIn(body);
	}
}

/** The innermost expression whose span holds `offset`, and the expressions around it, outermost first. */
export const expressionPathAt = (
	ast: TemplateNode,
	offset: number,
): Expression[] => {
	const path: Expression[] = [];
	const visit = (expression: Expression): boolean => {
		if (offset < expression.span.start || offset > expression.span.end)
			return false;
		path.push(expression);
		for (const child of childExpressions(expression)) {
			if (visit(child)) return true;
		}
		return true;
	};
	for (const expression of expressionsIn(ast.body)) {
		if (visit(expression)) break;
	}
	return path;
};

/**
 * Parses a template and finds every variable it brings into scope, following Kiln's rules: `for`, `with`, `block`,
 * `macro`, `component` and `fill` start a scope, and `set` updates a variable that is already visible or creates one in
 * the current scope.
 */
export const templateScopes = (
	text: string,
	isTest: (name: string) => boolean,
): TemplateScopes => {
	const { ast } = parse(text, { isTest });
	const bindings: Binding[] = [];

	const visible = (name: string, offset: number) =>
		bindings.some(
			(binding) => binding.name === name && sees(binding, offset, text.length),
		);

	const arrows = (expression: Expression) => {
		for (const node of expressionsIn([
			{ type: "Output", expression, span: expression.span },
		])) {
			if (node.type !== "Filter") continue;
			for (const arg of node.args) {
				if (arg.value.type !== "Arrow") continue;
				const arrow = arg.value;
				const head = text.slice(arrow.span.start, arrow.body.span.start);
				arrow.params.forEach((name, index) => {
					const at = nameIn(head, { start: 0, end: head.length }, name);
					bindings.push({
						name,
						source: {
							kind: "arrow",
							filter: node.name,
							input: node.input,
							index,
						},
						definition: {
							start: arrow.span.start + at.start,
							end: arrow.span.start + at.end,
						},
						scope: arrow.span,
						from: arrow.span.start,
					});
				});
			}
		}
	};

	const walk = (statements: Statement[], scope: Span) => {
		for (const statement of statements) {
			for (const expression of statementExpressions(statement))
				arrows(expression);
			const add = (
				name: string,
				source: BindingSource,
				definition: Span,
				inner: Span = scope,
				from = statement.span.end,
			) => bindings.push({ name, source, definition, scope: inner, from });

			switch (statement.type) {
				case "Props":
					for (const prop of statement.props) {
						add(
							prop.name,
							{
								kind: "prop",
								type: prop.type,
								optional: prop.default !== null,
							},
							{
								start: prop.span.start,
								end: prop.span.start + prop.name.length,
							},
							scope,
							scope.start,
						);
					}
					if (statement.rest) {
						const rest = statement.rest;
						add(
							rest,
							{ kind: "rest" },
							nameIn(text, statement.span, rest),
							scope,
							scope.start,
						);
					}
					break;
				case "Set":
				case "SetBlock":
					if (!visible(statement.name, statement.span.start)) {
						const after = text.indexOf("set", statement.span.start) + 3;
						add(
							statement.name,
							statement.type === "Set"
								? { kind: "set", value: statement.value }
								: { kind: "capture" },
							nameIn(text, statement.span, statement.name, after),
						);
					}
					break;
				case "For": {
					const after = text.indexOf("for", statement.span.start) + 3;
					const from = statement.iterable.span.end;
					if (statement.keyName) {
						add(
							statement.keyName,
							{ kind: "key", iterable: statement.iterable },
							nameIn(text, statement.span, statement.keyName, after),
							statement.span,
							from,
						);
					}
					add(
						statement.valueName,
						{ kind: "item", iterable: statement.iterable },
						nameIn(
							text,
							statement.span,
							statement.valueName,
							statement.keyName
								? nameIn(text, statement.span, statement.keyName, after).end
								: after,
						),
						statement.span,
						from,
					);
					break;
				}
				case "Macro":
					for (const param of statement.params) {
						add(
							param.name,
							{ kind: "param" },
							{
								start: param.span.start,
								end: param.span.start + param.name.length,
							},
							statement.span,
							param.span.end,
						);
					}
					break;
				case "With":
					if (statement.value.type === "Hash") {
						for (const entry of statement.value.entries) {
							if (
								entry.type !== "Property" ||
								entry.key.type !== "Literal" ||
								typeof entry.key.value !== "string"
							)
								continue;
							add(
								entry.key.value,
								{ kind: "with", value: statement.value, key: entry.key.value },
								entry.key.span,
								statement.span,
								statement.value.span.end,
							);
						}
					}
					break;
				case "Import": {
					const after = text.lastIndexOf(" as ", statement.span.end);
					add(
						statement.alias,
						{ kind: "import" },
						nameIn(text, statement.span, statement.alias, Math.max(after, 0)),
					);
					break;
				}
				case "FromImport":
					for (const item of statement.names) {
						add(
							item.alias,
							{ kind: "import" },
							nameIn(text, item.span, item.alias, item.span.start),
						);
					}
					break;
			}

			for (const { body, scoped } of childBodies(statement)) {
				walk(body, scoped ? statement.span : scope);
			}
		}
	};

	walk(ast.body, ast.span);
	return { ast, bindings };
};

/** The variable `name` refers to at `offset`: the one in the innermost scope that can see it there. */
export const bindingAt = (
	scopes: TemplateScopes,
	name: string,
	offset: number,
): Binding | null => {
	let found: Binding | null = null;
	for (const binding of scopes.bindings) {
		if (binding.name !== name || !sees(binding, offset, scopes.ast.span.end))
			continue;
		if (
			!found ||
			binding.scope.end - binding.scope.start <
				found.scope.end - found.scope.start
		) {
			found = binding;
		}
	}
	return found;
};

/** Every variable visible at `offset`, innermost first, one per name. */
export const bindingsAt = (scopes: TemplateScopes, offset: number) => {
	const names = new Set(scopes.bindings.map((binding) => binding.name));
	return [...names].flatMap((name) => {
		const binding = bindingAt(scopes, name, offset);
		return binding ? [binding] : [];
	});
};
