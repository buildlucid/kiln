import type { AnalysedProp, Analysis } from "./analyzer.js";
import type { Kiln } from "./environment.js";
import { KilnRenderError } from "./errors.js";
import { resolveTemplateName, TEMPLATE_EXTENSION } from "./names.js";
import type { PropType, TypeName } from "./parser/ast.js";

const BUILTIN_TYPES: Record<TypeName, string> = {
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

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const key = (name: string) =>
	IDENTIFIER.test(name) ? name : JSON.stringify(name);

/** Writes a Kiln prop type as TypeScript. Host types read `KilnTypes` through `Named`. */
const tsType = (type: readonly PropType[] | null): string => {
	if (type === null) return "unknown";
	if (type.length === 0) return "never";
	return type.map(tsMember).join(" | ");
};

const tsMember = (member: PropType): string => {
	if (typeof member === "string") return BUILTIN_TYPES[member];
	if ("literal" in member) return JSON.stringify(member.literal);
	if ("named" in member) return `Named<${JSON.stringify(member.named)}>`;
	if ("list" in member) {
		const inner = tsType(member.list);
		return inner.includes(" | ")
			? `readonly (${inner})[]`
			: `readonly ${inner}[]`;
	}
	if (member.shape.length === 0) return "object";
	const keys = member.shape.map(
		(entry) =>
			`${key(entry.name)}${entry.optional ? "?" : ""}: ${tsType(entry.type)}`,
	);
	return `{ ${keys.join("; ")} }`;
};

/** A prop as an object type member. A default makes it optional, and null then picks the default. */
const field = (prop: AnalysedProp, optional: boolean) =>
	optional
		? `${key(prop.name)}?: ${prop.type ? `${tsType(prop.type)} | null` : "unknown"}`
		: `${key(prop.name)}: ${tsType(prop.type)}`;

const objectType = (fields: string[], indent: string) =>
	fields.length === 0
		? "{}"
		: `{\n${fields.map((line) => `${indent}\t${line};`).join("\n")}\n${indent}}`;

/**
 * Writes a TypeScript declaration file describing each template's data and blocks, from their `props`. With the file in your project, `render` and `renderBlock` check template names, data and block names.
 *
 * Pass the names of the templates to describe, such as a loader's `list()`. The result is the file's contents; write it wherever your `tsconfig.json` includes.
 *
 * ```ts
 * await writeFile("src/kiln.d.ts", await generateTypes(kiln, await loader.list()));
 * ```
 */
export const generateTypes = async (
	kiln: Pick<Kiln, "analyze">,
	names: Iterable<string>,
): Promise<string> => {
	const analyses = new Map<string, Promise<Analysis | null>>();
	const analyse = (name: string) => {
		let analysis = analyses.get(name);
		if (!analysis) {
			analysis = kiln.analyze(name).catch((error: unknown) => {
				if (
					error instanceof KilnRenderError &&
					error.code === "missing-template"
				) {
					return null;
				}
				throw error;
			});
			analyses.set(name, analysis);
		}
		return analysis;
	};

	/** The layouts a template extends, nearest first. `complete` is false when one is built at render time or missing. */
	const layoutsOf = async (analysis: Analysis) => {
		const layouts: Analysis[] = [];
		const seen = new Set<string>();
		let current = analysis;
		for (;;) {
			const parent = current.templates.find((ref) => ref.kind === "extends");
			if (!parent) return { layouts, complete: true };
			if (!parent.name || seen.has(parent.name))
				return { layouts, complete: false };
			seen.add(parent.name);
			const layout = await analyse(parent.name);
			if (!layout) return { layouts, complete: false };
			layouts.push(layout);
			current = layout;
		}
	};

	const entries: string[] = [];
	let usesMarkup = false;
	let usesNamed = false;
	const resolved = [
		...new Set([...names].map((name) => resolveTemplateName(name))),
	].sort();
	for (const name of resolved) {
		const analysis = await analyse(name);
		if (!analysis) continue;
		const { layouts, complete } = await layoutsOf(analysis);

		let context: string;
		if (analysis.props.length > 0) {
			// Strict mode rejects anything a template with `props` doesn't declare.
			context = objectType(
				analysis.props.map((prop) => field(prop, !prop.required)),
				"\t\t\t",
			);
		} else {
			// Without `props`, a page takes any data, plus its layouts' props that it doesn't set itself.
			const provided = new Set(analysis.sets);
			const fields: string[] = [];
			for (const layout of layouts) {
				for (const prop of layout.props) {
					if (!provided.has(prop.name))
						fields.push(field(prop, !prop.required));
					provided.add(prop.name);
				}
				for (const set of layout.sets) provided.add(set);
			}
			context =
				fields.length === 0
					? "Record<string, unknown>"
					: `${objectType(fields, "\t\t\t")} & Record<string, unknown>`;
		}

		const blockNames = new Set([analysis, ...layouts].flatMap((a) => a.blocks));
		const blocks = !complete
			? "string"
			: blockNames.size === 0
				? "never"
				: [...blockNames].map((block) => JSON.stringify(block)).join(" | ");

		usesMarkup ||= context.includes("Markup");
		usesNamed ||= context.includes("Named<");
		const templateKey = name.endsWith(TEMPLATE_EXTENSION)
			? name.slice(0, -TEMPLATE_EXTENSION.length)
			: name;
		entries.push(
			`\t\t${JSON.stringify(templateKey)}: {\n\t\t\tcontext: ${context};\n\t\t\tblocks: ${blocks};\n\t\t};`,
		);
	}

	const imports = [
		...(usesNamed ? ["KilnTypes"] : []),
		...(usesMarkup ? ["Markup"] : []),
	];
	return [
		"// Generated by Kiln's generateTypes. Do not edit.",
		imports.length > 0
			? `import type { ${imports.join(", ")} } from "@lucidkiln/core";\n`
			: "export {};\n",
		...(usesNamed
			? [
					"type Named<Name extends string> = Name extends keyof KilnTypes ? KilnTypes[Name] : unknown;\n",
				]
			: []),
		'declare module "@lucidkiln/core" {',
		entries.length > 0
			? `\tinterface KilnTemplates {\n${entries.join("\n")}\n\t}`
			: "\tinterface KilnTemplates {}",
		"}",
		"",
	].join("\n");
};
