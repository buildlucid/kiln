import { analyzeTemplate, childStatements } from "./analyzer.js";
import { createDiagnostic, type Diagnostic } from "./errors.js";
import { resolveTemplateName } from "./names.js";
import type { Expression, HashEntry, Statement } from "./parser/ast.js";
import type {
	CompiledTemplate,
	EnvironmentCore,
	Scope,
} from "./runtime/types.js";
import { describeType, describeValue, matchesType } from "./runtime/values.js";
import type { Span } from "./source.js";
import { suggest } from "./suggest.js";

type Property = Extract<HashEntry, { type: "Property" }>;
type PropsNode = Extract<Statement, { type: "Props" }>;

/** A template's `props` tag, or null when it has none. */
const propsOf = (template: CompiledTemplate): PropsNode | null => {
	for (const node of template.ast.body) {
		if (node.type === "Props") return node;
	}
	return null;
};

/** Variables a template sets at its top level. A child template's run before its layout. */
const setsOf = (template: CompiledTemplate): string[] =>
	template.ast.body.flatMap((node) =>
		node.type === "Set" || node.type === "SetBlock" ? [node.name] : [],
	);

/** The resolved name of a template written as a plain string, or null when it is built at render time. */
const literalName = (expression: Expression, from: string): string | null => {
	if (expression.type !== "Literal" || typeof expression.value !== "string") {
		return null;
	}
	try {
		return resolveTemplateName(expression.value, from);
	} catch {
		return null;
	}
};

/** The keys a `with` passes, by name. Null when they can't be known, such as `with data` or a spread. */
const passedKeys = (
	expression: Expression | null,
): Map<string, Property> | null => {
	const keys = new Map<string, Property>();
	if (expression === null) return keys;
	if (expression.type !== "Hash") return null;
	for (const entry of expression.entries) {
		if (
			entry.type !== "Property" ||
			entry.key.type !== "Literal" ||
			typeof entry.key.value !== "string"
		) {
			return null;
		}
		keys.set(entry.key.value, entry);
	}
	return keys;
};

const withHint = (message: string, hint: string | undefined) =>
	hint ? `${message}. ${hint}` : message;

/**
 * Checks a template against the templates it names, for `check`. Never renders.
 *
 * - Reports templates that don't exist.
 * - In strict mode, compares `include` and `component` calls, and a page's layouts, with the `props` they declare.
 * - In strict mode, warns about variables a template with `props` reads without declaring.
 */
export const checkReferences = async (
	env: EnvironmentCore & { readonly globals: Scope },
	template: CompiledTemplate,
): Promise<Diagnostic[]> => {
	const diagnostics: Diagnostic[] = [];
	const report = (
		code: string,
		message: string,
		span: Span,
		severity: Diagnostic["severity"] = "error",
	) => {
		diagnostics.push(
			createDiagnostic(template.source, code, message, span, severity),
		);
	};
	const ownProps = propsOf(template)?.props ?? null;

	/** Loads a named template, reporting it when it doesn't exist. */
	const use = async (name: string, span: Span, optional = false) => {
		const used = await env.load(name);
		if (!used && !optional) {
			report("missing-template", `Template "${name}" was not found`, span);
		}
		return used;
	};

	const call = async (
		node: Extract<Statement, { type: "Include" | "Component" | "Island" }>,
	) => {
		const name = literalName(node.template, template.name);
		if (!name) return;
		const used = await use(
			name,
			node.template.span,
			node.type === "Include" && node.ignoreMissing,
		);
		if (!used || used.hasErrors || !env.strict) return;
		const tag = propsOf(used);
		const passed = passedKeys(node.with);
		if (!tag || !passed) return;

		const props = tag.props;
		const declared = props.map((prop) => prop.name);
		for (const [key, entry] of passed) {
			// A rest prop accepts any key.
			if (tag.rest !== null || key === "slots" || declared.includes(key)) {
				continue;
			}
			report(
				"unknown-prop",
				withHint(
					`"${key}" was passed to ${name}, which does not declare it in "props"`,
					suggest(key, declared),
				),
				entry.key.span,
			);
		}
		for (const prop of props) {
			const value = passed.get(prop.name)?.value;
			if (!value) {
				if (!prop.default) {
					report(
						"missing-prop",
						`Required prop "${prop.name}" was not passed to ${name}`,
						node.template.span,
					);
				}
				continue;
			}
			// Null uses the default, which the template's own check covers.
			if (
				!prop.type ||
				value.type !== "Literal" ||
				(value.value === null && prop.default)
			) {
				continue;
			}
			if (!matchesType(value.value, prop.type, env.types)) {
				report(
					"prop-type",
					`Prop "${prop.name}" of ${name} must be ${describeType(prop.type)}, but got ${describeValue(value.value, prop.type)}`,
					value.span,
				);
			}
		}
	};

	// A page with `props` accepts only those, so its layouts can only get props it declares or sets.
	const layouts = async (node: Extract<Statement, { type: "Extends" }>) => {
		let name = literalName(node.template, template.name);
		if (!name) return;
		let layout = await use(name, node.template.span);
		if (!ownProps || !env.strict) return;
		const provided = new Set([
			...ownProps.map((prop) => prop.name),
			...setsOf(template),
		]);
		const seen = new Set([template.name]);
		while (layout && !layout.hasErrors && !seen.has(layout.name)) {
			seen.add(layout.name);
			for (const prop of propsOf(layout)?.props ?? []) {
				if (!prop.default && !provided.has(prop.name)) {
					report(
						"missing-prop",
						`${name} needs prop "${prop.name}", which ${template.name} does not declare in "props" or set`,
						node.template.span,
					);
				}
				provided.add(prop.name);
			}
			for (const set of setsOf(layout)) provided.add(set);
			const parent = layout.ast.body.find((child) => child.type === "Extends");
			name = parent ? literalName(parent.template, layout.name) : null;
			layout = name ? await env.load(name) : null;
		}
	};

	const visit = async (list: Statement[]): Promise<void> => {
		for (const node of list) {
			if (
				node.type === "Include" ||
				node.type === "Component" ||
				node.type === "Island"
			) {
				await call(node);
			} else if (node.type === "Extends") await layouts(node);
			for (const children of childStatements(node)) await visit(children);
		}
	};

	for (const imported of template.imports)
		await use(imported.name, imported.span);
	await visit(template.ast.body);

	if (ownProps && env.strict) {
		const reads = new Map<string, Span>();
		analyzeTemplate(template, env.globals, reads);
		const declared = ownProps.map((prop) => prop.name);
		for (const [name, span] of reads) {
			report(
				"undeclared-variable",
				withHint(
					`"${name}" is not a prop, a global or a variable set in this template`,
					suggest(name, declared),
				),
				span,
				"warning",
			);
		}
	}
	return diagnostics;
};
