import type { Diagnostic } from "./errors.js";
import { resolveTemplateName } from "./names.js";
import type {
	Argument,
	Expression,
	PropType,
	Statement,
} from "./parser/ast.js";
import type { CompiledTemplate, Scope } from "./runtime/types.js";
import type { Position, Span } from "./source.js";

export type TemplateReference = {
	kind: "extends" | "include" | "component" | "import";
	/** Resolved name, or `null` when the name is computed at render time. */
	name: string | null;
	start: Position;
	end: Position;
};

export type AnalysedProp = {
	name: string;
	required: boolean;
	type: PropType[] | null;
};

export type Analysis = {
	diagnostics: Diagnostic[];
	/** Variables the template reads from its context, excluding globals, props and locals. */
	variables: string[];
	/** `type` lists the members of the prop's type, or is `null` when the prop is untyped. */
	props: AnalysedProp[];
	/** The name of the rest prop, as in `...attributes`, or null. With one, the template accepts any variable. */
	rest: string | null;
	/** Variables set at the top level. A layout sees those its child template sets. */
	sets: string[];
	functions: string[];
	filters: string[];
	tests: string[];
	templates: TemplateReference[];
	blocks: string[];
	macros: string[];
};

const MAX_DEPTH = 1000;

/** The statement lists nested inside a statement. */
export const childStatements = (node: Statement): Statement[][] => {
	switch (node.type) {
		case "If":
			return [
				...node.branches.map((branch) => branch.body),
				node.alternate ?? [],
			];
		case "For":
			return [node.body, node.alternate ?? []];
		case "Component":
			return [node.body, ...node.fills.map((fill) => fill.body)];
		case "SetBlock":
		case "Block":
		case "Slot":
		case "Macro":
		case "Cache":
		case "With":
		case "Apply":
		case "Autoescape":
			return [node.body];
		default:
			return [];
	}
};

/**
 * Walks a compiled template's syntax tree and reports what it uses.
 *
 * When `reads` is given, it collects where each variable in `variables` is first read without a guard such as `??`, `?.`, `default` or `is defined`. Strict mode fails on those reads when the variable is missing.
 */
export const analyzeTemplate = (
	template: CompiledTemplate,
	globals: Scope,
	reads?: Map<string, Span>,
): Analysis => {
	const source = template.source;
	const variables = new Set<string>();
	const functions = new Set<string>();
	const filters = new Set<string>();
	const tests = new Set<string>();
	const templates: TemplateReference[] = [];
	const blocks: string[] = [];
	const props: AnalysedProp[] = [];
	let rest: string | null = null;
	const macroNames = new Set(template.macros.keys());
	const importedNames = new Set<string>();
	const importAliases = new Set<string>();

	const reference = (
		kind: TemplateReference["kind"],
		name: Expression | string,
		span: Span,
	) => {
		let resolved: string | null = null;
		const literal =
			typeof name === "string"
				? name
				: name.type === "Literal"
					? name.value
					: null;
		if (typeof literal === "string") {
			try {
				resolved = resolveTemplateName(literal, template.name);
			} catch {
				resolved = null;
			}
		}
		templates.push({
			kind,
			name: resolved,
			start: source.position(span.start),
			end: source.position(span.end),
		});
	};

	// Scopes of declared names, innermost last. `null` marks an isolated scope, such as a macro body.
	const scopes: (Set<string> | null)[] = [new Set()];
	const declared = (name: string) => {
		for (let i = scopes.length - 1; i >= 0; i--) {
			const scope = scopes[i];
			if (scope === null || scope?.has(name)) return true;
		}
		return name in globals;
	};
	const declare = (name: string) => {
		if (!declared(name)) scopes[scopes.length - 1]?.add(name);
	};
	const withScope = (
		names: Iterable<string>,
		work: () => void,
		isolated = false,
	) => {
		if (isolated) scopes.push(null);
		scopes.push(new Set(names));
		work();
		scopes.pop();
		if (isolated) scopes.pop();
	};

	const visitArguments = (args: Argument[]) => {
		for (const arg of args) expression(arg.value);
	};

	// Expressions deeper than the compiler accepts were already reported, so stop there instead of overflowing the stack.
	let depth = 0;
	const expression = (node: Expression): void => {
		if (depth >= MAX_DEPTH) return;
		depth++;
		try {
			visitExpression(node);
		} finally {
			depth--;
		}
	};

	// A guarded expression, such as the left of `??`, is null rather than an error when its variable is missing.
	const guarded = (node: Expression): void => {
		if (node.type === "Name") read(node.name, node.span, true);
		else if (node.type === "Member") {
			guarded(node.object);
			if (node.property.type !== "Literal") expression(node.property);
		} else if (node.type === "OptionalChain") guarded(node.expression);
		else expression(node);
	};

	const read = (name: string, span: Span, isGuarded: boolean) => {
		if (name === "loop" || name === "slots" || declared(name)) return;
		variables.add(name);
		if (reads && !isGuarded && !reads.has(name)) reads.set(name, span);
	};

	const visitExpression = (node: Expression): void => {
		switch (node.type) {
			case "Literal":
			case "Invalid":
				return;
			case "Name":
				read(node.name, node.span, false);
				return;
			case "Interpolation":
				node.parts.forEach(expression);
				return;
			case "Array":
				for (const element of node.elements) {
					expression(element.type === "Spread" ? element.value : element);
				}
				return;
			case "Hash":
				for (const entry of node.entries) {
					if (entry.type === "Property" && entry.key.type !== "Literal") {
						expression(entry.key);
					}
					expression(entry.value);
				}
				return;
			case "Unary":
				expression(node.operand);
				return;
			case "Binary":
				if (node.operator === "??") guarded(node.left);
				else expression(node.left);
				expression(node.right);
				return;
			case "Conditional":
				expression(node.test);
				expression(node.consequent);
				if (node.alternate) expression(node.alternate);
				return;
			case "Member":
				expression(node.object);
				if (node.property.type !== "Literal") expression(node.property);
				return;
			case "OptionalChain":
				guarded(node.expression);
				return;
			case "Call": {
				const callee = node.callee;
				if (callee.type === "Name") {
					const name = callee.name;
					if (
						name !== "parent" &&
						name !== "block" &&
						!macroNames.has(name) &&
						!importedNames.has(name)
					) {
						functions.add(name);
					}
				} else if (
					!(
						callee.type === "Member" &&
						callee.object.type === "Name" &&
						importAliases.has(callee.object.name)
					)
				) {
					expression(callee);
				}
				visitArguments(node.args);
				return;
			}
			case "Filter":
				filters.add(node.name);
				if (node.name === "default") guarded(node.input);
				else expression(node.input);
				visitArguments(node.args);
				return;
			case "Test":
				tests.add(node.name);
				if (node.name === "defined") guarded(node.input);
				else expression(node.input);
				visitArguments(node.args);
				return;
			case "Arrow":
				withScope(node.params, () => expression(node.body));
				return;
		}
	};

	const statements = (list: Statement[]) => {
		for (const node of list) statement(node);
	};

	const statement = (node: Statement): void => {
		switch (node.type) {
			case "Text":
				return;
			case "Output":
				expression(node.expression);
				return;
			case "If":
				for (const branch of node.branches) {
					expression(branch.test);
					statements(branch.body);
				}
				if (node.alternate) statements(node.alternate);
				return;
			case "For":
				expression(node.iterable);
				withScope(
					node.keyName ? [node.valueName, node.keyName] : [node.valueName],
					() => statements(node.body),
				);
				if (node.alternate) statements(node.alternate);
				return;
			case "Set":
				expression(node.value);
				declare(node.name);
				return;
			case "SetBlock":
				statements(node.body);
				declare(node.name);
				return;
			case "Props":
				for (const prop of node.props) {
					if (prop.default) expression(prop.default);
					props.push({
						name: prop.name,
						required: prop.default === null,
						type: prop.type,
					});
					declare(prop.name);
				}
				if (node.rest !== null) {
					rest = node.rest;
					declare(node.rest);
				}
				return;
			case "Extends":
				expression(node.template);
				reference("extends", node.template, node.span);
				return;
			case "Block":
				blocks.push(node.name);
				withScope([], () => statements(node.body));
				return;
			case "Include":
				expression(node.template);
				if (node.with) expression(node.with);
				reference("include", node.template, node.span);
				return;
			case "Component":
				expression(node.template);
				if (node.with) expression(node.with);
				reference("component", node.template, node.span);
				withScope([], () => statements(node.body));
				for (const fill of node.fills)
					withScope([], () => statements(fill.body));
				return;
			case "Slot":
				withScope([], () => statements(node.body));
				return;
			case "Macro":
				withScope(
					node.params.map((param) => param.name),
					() => {
						for (const param of node.params)
							if (param.default) expression(param.default);
						statements(node.body);
					},
					true,
				);
				return;
			case "Import":
			case "FromImport":
				return;
			case "With": {
				expression(node.value);
				const names =
					node.value.type === "Hash"
						? node.value.entries.flatMap((entry) =>
								entry.type === "Property" &&
								entry.key.type === "Literal" &&
								typeof entry.key.value === "string"
									? [entry.key.value]
									: [],
							)
						: [];
				withScope(names, () => statements(node.body));
				return;
			}
			case "Cache":
				expression(node.key);
				if (node.seconds) expression(node.seconds);
				withScope([], () => statements(node.body));
				return;
			case "Apply":
				for (const filter of node.filters) {
					filters.add(filter.name);
					visitArguments(filter.args);
				}
				statements(node.body);
				return;
			case "Autoescape":
				statements(node.body);
				return;
		}
	};

	// Imports are hoisted, so record them before walking.
	// Imports can sit anywhere in the template. Only statements hold them, so expressions are not searched.
	const collectImports = (list: Statement[]): void => {
		for (const node of list) {
			if (node.type === "Import") {
				importAliases.add(node.alias);
				reference("import", node.template, node.span);
			} else if (node.type === "FromImport") {
				for (const entry of node.names) importedNames.add(entry.alias);
				reference("import", node.template, node.span);
			}
			for (const children of childStatements(node)) collectImports(children);
		}
	};
	collectImports(template.ast.body);

	// A child template's top-level `set` statements run before its layout, so blocks see them wherever they are written.
	if (template.parent) {
		for (const node of template.ast.body) {
			if (node.type === "Set" || node.type === "SetBlock") declare(node.name);
		}
	}
	statements(template.ast.body);

	return {
		diagnostics: template.diagnostics,
		variables: [...variables],
		props,
		rest,
		sets: template.ast.body.flatMap((node) =>
			node.type === "Set" || node.type === "SetBlock" ? [node.name] : [],
		),
		functions: [...functions],
		filters: [...filters],
		tests: [...tests],
		templates,
		blocks,
		macros: [...macroNames],
	};
};
