import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { AnalysedProp, Analysis, PropType } from "@lucidkiln/core";
import type { Expression, Span } from "@lucidkiln/core/syntax";
import {
	type CompletionItem,
	CompletionItemKind,
	type DocumentLink,
	type DocumentSymbol,
	type Hover,
	InsertTextFormat,
	InsertTextMode,
	type LocationLink,
	MarkupKind,
	SymbolKind,
} from "vscode-languageserver";
import type { TextDocument } from "vscode-languageserver-textdocument";
import {
	type BuiltinDoc,
	FILTERS,
	FUNCTIONS,
	KEYWORDS,
	LOOP_PROPERTIES,
	TAGS,
	TESTS,
} from "./builtins.js";
import {
	cursorContext,
	enclosingDelimiter,
	symbolAt,
	templateStrings,
} from "./context.js";
import { type DocKind, docsFor } from "./docs.js";
import { htmlCompletions, htmlHover } from "./html.js";
import { listTemplates, pathOf, type Project, resolveName } from "./project.js";
import {
	type Binding,
	bindingAt,
	bindingsAt,
	expressionPathAt,
	type TemplateScopes,
	templateScopes,
} from "./scopes.js";
import {
	bindingType,
	describeCallable,
	expressionType,
	REGISTRIES,
	type TypeContext,
	withTypes,
} from "./types.js";
import type { Member, SourceLocation } from "./typescript.js";

/** A template open in the editor, with its project and template name. */
export type OpenTemplate = {
	document: TextDocument;
	project: Project;
	/** Null when the file is outside the project's root. */
	name: string | null;
};

const analyse = async (
	project: Project,
	name: string,
	text?: string,
): Promise<Analysis | null> => {
	try {
		return await project.kiln.analyze(name, text);
	} catch {
		return null;
	}
};

/** Writes a prop type as it appears in `props`, such as `"a" | "b"` or `{ url?: string }[]`. */
export const describeType = (type: readonly PropType[] | null): string => {
	if (type === null) return "any";
	return type
		.map((member): string => {
			if (typeof member === "string") return member;
			if ("literal" in member) return JSON.stringify(member.literal);
			if ("named" in member) return member.named;
			if ("list" in member) {
				const inner = describeType(member.list);
				return member.list.length > 1 ? `(${inner})[]` : `${inner}[]`;
			}
			const keys = member.shape.map(
				(key) =>
					`${key.name}${key.optional ? "?" : ""}: ${describeType(key.type)}`,
			);
			return `{ ${keys.join(", ")} }`;
		})
		.join(" | ");
};

const describeProp = (prop: AnalysedProp) =>
	`${prop.name}${prop.required ? "" : "?"}: ${describeType(prop.type)}`;

const markdown = (value: string) => ({ kind: MarkupKind.Markdown, value });

/** Markdown for an item's docs, or nothing when it has none. */
const documentation = (kind: DocKind, name: string) => {
	const docs = docsFor(kind, name);
	return docs ? markdown(docs) : undefined;
};

const builtinItems = (
	builtins: Record<string, BuiltinDoc>,
	docKind: DocKind,
	kind: CompletionItemKind,
	extra: readonly string[],
): CompletionItem[] => [
	...Object.entries(builtins).map(([label, doc]) => ({
		label,
		kind,
		detail: doc.signature,
		documentation: documentation(docKind, label),
	})),
	...extra
		.filter((name) => !(name in builtins))
		.map((label) => ({ label, kind, detail: "From your project" })),
];

/** Parses a template and finds its variables, with what `expressionType` needs to work out their types. */
const templateTypes = (
	open: OpenTemplate,
	text: string,
): { scopes: TemplateScopes; context: TypeContext } => {
	const manifest = open.project.manifest;
	const scopes = templateScopes(
		text,
		(name) => name in TESTS || (manifest?.tests.includes(name) ?? false),
	);
	const macros = new Set([
		...macrosIn(text).keys(),
		...scopes.bindings
			.filter((binding) => binding.source.kind === "import")
			.map((binding) => binding.name),
	]);
	return {
		scopes,
		context: {
			scopes,
			functions: manifest?.functions ?? [],
			filters: manifest?.filters ?? [],
			macros,
		},
	};
};

/** The property under the cursor in `a.b`, with the expression it's read from. */
const propertyAt = (
	scopes: TemplateScopes,
	text: string,
	offset: number,
): { name: string; object: Expression; span: Span } | null => {
	const path = expressionPathAt(scopes.ast, offset);
	for (let index = path.length - 1; index >= 0; index--) {
		const node = path[index] as Expression;
		if (node.type !== "Member") continue;
		const { property } = node;
		if (
			property.type === "Literal" &&
			typeof property.value === "string" &&
			offset >= property.span.start &&
			offset <= property.span.end &&
			text[property.span.start - 1] === "."
		) {
			return { name: property.value, object: node.object, span: property.span };
		}
	}
	return null;
};

/** A member's doc comment and tags, as Markdown. */
const memberDocs = (member: Member) =>
	[
		member.docs,
		...member.tags.map((tag) => `*@${tag.name}* ${tag.text}`.trim()),
	]
		.filter(Boolean)
		.join("\n\n");

/** The properties TypeScript finds on the value of `object`. Empty without TypeScript. */
const membersOf = async (
	open: OpenTemplate,
	object: Expression,
	context: TypeContext,
): Promise<Member[]> => {
	const typescript = await open.project.typescript();
	if (!typescript) return [];
	const type = expressionType(object, context);
	return (
		withTypes(typescript, { Value: `Members<${type}>` }, (read) =>
			read.members("Value"),
		) ?? []
	);
};

/** A function, filter, test or global the project describes in TypeScript. */
const registered = async (
	open: OpenTemplate,
	kind: keyof typeof REGISTRIES,
	name: string,
): Promise<Member | null> => {
	const typescript = await open.project.typescript();
	if (!typescript) return null;
	return (
		withTypes(typescript, { Registry: REGISTRIES[kind] }, (read) =>
			read.members("Registry").find((member) => member.name === name),
		) ?? null
	);
};

const BINDING_NOTES: Record<Binding["source"]["kind"], string> = {
	prop: "A prop of this template.",
	rest: "The variables passed to this template that it doesn't declare.",
	set: "Set in this template.",
	capture: "Set in this template, from a `set` block.",
	item: "A loop variable.",
	key: "A loop variable.",
	arrow: "An arrow function's parameter.",
	with: "From the `with` tag.",
	param: "A macro argument.",
	import: "Imported macros.",
};

export const complete = async (
	open: OpenTemplate,
	offset: number,
): Promise<CompletionItem[]> => {
	const { document, project, name } = open;
	const text = document.getText();
	const context = cursorContext(text, offset);
	if (!context) {
		return enclosingDelimiter(text, offset)
			? []
			: htmlCompletions(document, offset);
	}
	const replace = (end = offset) => ({
		start: document.positionAt(context.start),
		end: document.positionAt(end),
	});
	const manifest = project.manifest;

	switch (context.kind) {
		case "tag": {
			const items: CompletionItem[] = Object.entries(TAGS).map(
				([label, tag]) => ({
					label,
					kind: CompletionItemKind.Keyword,
					documentation: documentation("tags", label),
					insertTextFormat: InsertTextFormat.Snippet,
					insertTextMode: InsertTextMode.adjustIndentation,
					// Replaces a `%}` already on the line, since the snippet brings its own.
					textEdit: {
						range: replace(context.end ?? offset),
						newText: tag.snippet,
					},
				}),
			);
			if (context.open) {
				const label = `end${context.open}`;
				items.unshift({
					label,
					kind: CompletionItemKind.Keyword,
					detail: `Closes the open ${context.open}`,
					sortText: "0",
					textEdit: {
						range: replace(context.end ?? offset),
						newText: `${label} %}`,
					},
				});
			}
			return items;
		}
		case "template": {
			const templates = await listTemplates(project);
			return templates.map((template) => {
				const label = template.replace(/\.kiln$/, "");
				return {
					label,
					kind: CompletionItemKind.File,
					textEdit: { range: replace(), newText: label },
				};
			});
		}
		case "filter":
			return builtinItems(
				FILTERS,
				"filters",
				CompletionItemKind.Function,
				manifest?.filters ?? [],
			);
		case "test":
			return builtinItems(
				TESTS,
				"tests",
				CompletionItemKind.Function,
				manifest?.tests ?? [],
			);
		case "member": {
			// A placeholder name lets the template parse while nothing follows the dot yet.
			const patched =
				context.start === offset
					? `${text.slice(0, offset)}__kiln__${text.slice(offset)}`
					: text;
			const types = templateTypes(open, patched);
			const property = propertyAt(types.scopes, patched, context.start);
			if (!property) return [];
			const members = await membersOf(open, property.object, types.context);
			return members.map((member) => ({
				label: member.name,
				kind: CompletionItemKind.Property,
				detail: `${member.name}${member.optional ? "?" : ""}: ${member.type}`,
				documentation: memberDocs(member)
					? markdown(memberDocs(member))
					: undefined,
				textEdit: { range: replace(), newText: member.name },
			}));
		}
		case "loop":
			return Object.entries(LOOP_PROPERTIES).map(([label, description]) => ({
				label,
				kind: CompletionItemKind.Property,
				documentation: markdown(description),
			}));
		case "prop": {
			const target = resolveName(context.template, name ?? undefined);
			const analysis = target ? await analyse(project, target) : null;
			return (analysis?.props ?? []).map((prop) => ({
				label: prop.name,
				kind: CompletionItemKind.Field,
				detail: describeProp(prop),
				insertText: `${prop.name}: `,
			}));
		}
		case "expression": {
			const analysis = name ? await analyse(project, name, text) : null;
			const { scopes } = templateTypes(open, text);
			const variables = new Set([
				...(analysis?.props.map((prop) => prop.name) ?? []),
				...(analysis?.rest ? [analysis.rest] : []),
				...bindingsAt(scopes, offset).map((binding) => binding.name),
				...macrosIn(text).keys(),
				...(manifest?.globals ?? []),
			]);
			const props = new Map(analysis?.props.map((prop) => [prop.name, prop]));
			return [
				...[...variables].map((label) => {
					const prop = props.get(label);
					return {
						label,
						kind: CompletionItemKind.Variable,
						detail: prop ? describeProp(prop) : undefined,
					};
				}),
				...builtinItems(
					FUNCTIONS,
					"functions",
					CompletionItemKind.Function,
					manifest?.functions ?? [],
				),
				...KEYWORDS.map((label) => ({
					label,
					kind: CompletionItemKind.Keyword,
				})),
			];
		}
	}
};

/** The `{% macro name(params) %}` definitions in a template, by name. */
const macrosIn = (text: string) =>
	new Map(
		[...text.matchAll(/\{%-?\s*macro\s+(\w+)\s*\(([^)]*)\)/g)].map((match) => [
			match[1] as string,
			{ params: (match[2] as string).trim(), start: match.index as number },
		]),
	);

const codeBlock = (code: string, language = "kiln") =>
	`\`\`\`${language}\n${code}\n\`\`\``;

/** A hover's parts, such as a signature and its docs, with a rule between each. Missing parts are left out. */
const sections = (...parts: (string | null | undefined)[]) =>
	parts.filter(Boolean).join("\n\n---\n\n");

/** A tag's syntax, from its completion snippet: named placeholders become their names, and the rest become `…`. */
const tagSyntax = (snippet: string) =>
	`{% ${snippet.replace(/\$\{\d+:([^}]*)\}/g, "$1").replace(/\$\{?\d+\}?/g, "…")}`;

/** A registered function, filter or test as the project's TypeScript describes it: its signature, then its docs. */
const describedCallable = async (
	open: OpenTemplate,
	kind: "function" | "filter" | "test",
	name: string,
) => {
	const typescript = await open.project.typescript();
	const described = typescript
		? describeCallable(typescript, kind, name)
		: null;
	return described
		? sections(
				codeBlock(described.signature, "ts"),
				memberDocs(described.member),
			)
		: null;
};

/** The variable a name refers to: the one it declares when the cursor is on a declaration, or the one in scope. */
const bindingFor = (
	scopes: TemplateScopes,
	symbol: { name: string; start: number },
) =>
	scopes.bindings.find(
		(binding) =>
			binding.name === symbol.name &&
			symbol.start >= binding.definition.start &&
			symbol.start < binding.definition.end,
	) ?? bindingAt(scopes, symbol.name, symbol.start);

/** The property under the cursor in `a.b`, and what TypeScript knows about it. */
const memberAt = async (open: OpenTemplate, text: string, offset: number) => {
	const types = templateTypes(open, text);
	const property = propertyAt(types.scopes, text, offset);
	if (!property) return null;
	const members = await membersOf(open, property.object, types.context);
	const member = members.find((item) => item.name === property.name);
	return member ? { member, span: property.span } : null;
};

export const hover = async (
	open: OpenTemplate,
	offset: number,
): Promise<Hover | null> => {
	const { document, project, name } = open;
	const text = document.getText();
	const symbol = symbolAt(text, offset);
	const rangeOf = (span: Span) => ({
		start: document.positionAt(span.start),
		end: document.positionAt(span.end),
	});
	if (!symbol) {
		if (!enclosingDelimiter(text, offset)) return htmlHover(document, offset);
		const found = await memberAt(open, text, offset);
		if (!found) return null;
		const { member } = found;
		return {
			contents: markdown(
				sections(
					codeBlock(
						`${member.name}${member.optional ? "?" : ""}: ${member.type}`,
						"ts",
					),
					memberDocs(member),
				),
			),
			range: rangeOf(found.span),
		};
	}
	const fromProject = (names: readonly string[] | undefined, what: string) =>
		names?.includes(symbol.name) ? `A ${what} your project registers.` : null;
	/** Whether the project registers a name, which replaces a built-in with the same name. */
	const registers = (names: readonly string[] | undefined) =>
		names?.includes(symbol.name) ?? false;
	let value: string | null = null;

	/** A built-in's signature, then its docs. */
	const builtin = (signature: string, kind: DocKind) =>
		sections(codeBlock(signature), docsFor(kind, symbol.name));

	switch (symbol.kind) {
		case "tag": {
			// An end tag, such as `endfor`, shows the docs of the tag it closes.
			const tag =
				symbol.name in TAGS ? symbol.name : symbol.name.replace(/^end/, "");
			const doc = TAGS[tag];
			value = sections(
				doc && codeBlock(tagSyntax(doc.snippet)),
				docsFor("tags", tag),
			);
			break;
		}
		case "filter": {
			const doc = FILTERS[symbol.name];
			value =
				doc && !registers(project.manifest?.filters)
					? builtin(`|${doc.signature}`, "filters")
					: ((await describedCallable(open, "filter", symbol.name)) ??
						fromProject(project.manifest?.filters, "filter"));
			break;
		}
		case "test": {
			const doc = TESTS[symbol.name];
			value =
				doc && !registers(project.manifest?.tests)
					? builtin(`is ${doc.signature}`, "tests")
					: ((await describedCallable(open, "test", symbol.name)) ??
						fromProject(project.manifest?.tests, "test"));
			break;
		}
		case "loop": {
			const description = LOOP_PROPERTIES[symbol.name];
			value = description
				? sections(codeBlock(`loop.${symbol.name}`), description)
				: null;
			break;
		}
		case "function": {
			const macro = macrosIn(text).get(symbol.name);
			const doc = FUNCTIONS[symbol.name];
			if (macro) value = codeBlock(`macro ${symbol.name}(${macro.params})`);
			else if (doc && !registers(project.manifest?.functions))
				value = builtin(doc.signature, "functions");
			else
				value =
					(await describedCallable(open, "function", symbol.name)) ??
					fromProject(project.manifest?.functions, "function");
			break;
		}
		case "variable": {
			const types = templateTypes(open, text);
			const binding = bindingFor(types.scopes, symbol);
			if (binding?.source.kind === "prop" || binding?.source.kind === "rest") {
				const analysis = name ? await analyse(project, name, text) : null;
				const prop = analysis?.props.find((item) => item.name === symbol.name);
				value = sections(
					codeBlock(prop ? describeProp(prop) : `...${symbol.name}`),
					BINDING_NOTES[binding.source.kind],
				);
			} else if (binding) {
				const typescript = await project.typescript();
				const type = typescript
					? withTypes(
							typescript,
							{ Value: bindingType(binding.source, types.context) },
							(read) => read.describe("Value"),
						)
					: null;
				value = sections(
					codeBlock(
						type && type !== "unknown"
							? `${symbol.name}: ${type}`
							: symbol.name,
						"ts",
					),
					BINDING_NOTES[binding.source.kind],
				);
			} else {
				const global = await registered(open, "global", symbol.name);
				value = global
					? sections(
							codeBlock(`${symbol.name}: ${global.type}`, "ts"),
							memberDocs(global),
						)
					: project.manifest?.globals.includes(symbol.name)
						? "A global your project provides."
						: null;
			}
			break;
		}
		case "template": {
			const target = resolveName(symbol.name, name ?? undefined);
			const analysis = target ? await analyse(project, target) : null;
			if (!target || !analysis) {
				value = project.manifest
					? `Template \`${symbol.name}\` was not found.`
					: null;
				break;
			}
			const lines = [`**${target}**`];
			if (analysis.props.length > 0 || analysis.rest) {
				const props = analysis.props.map(describeProp);
				if (analysis.rest) props.push(`...${analysis.rest}`);
				lines.push(codeBlock(`props ${props.join(", ")}`));
			}
			if (analysis.blocks.length > 0) {
				lines.push(
					`Blocks: ${analysis.blocks.map((block) => `\`${block}\``).join(", ")}`,
				);
			}
			value = lines.join("\n\n");
		}
	}
	return value ? { contents: markdown(value), range: rangeOf(symbol) } : null;
};

const point = (line: number, character: number) => {
	const position = { line, character };
	return { start: position, end: position };
};

/** The line and column of an offset in another template's text. */
const positionIn = (text: string, offset: number) => {
	const lines = text.slice(0, offset).split("\n");
	return { line: lines.length - 1, character: (lines.at(-1) as string).length };
};

/**
 * Where the name under the cursor is defined. The link's origin is the whole name, so editors underline all of
 * `"layouts/base"` rather than one word of it.
 *
 * Variables go to where the template declares them. Without `kiln.json`, template names have no root, so nothing in
 * other templates is found. With the project's TypeScript, its functions, filters, tests, globals and the properties of
 * typed values go to their TypeScript source.
 */
export const definition = async (
	open: OpenTemplate,
	offset: number,
): Promise<LocationLink | null> => {
	const { document, project, name } = open;
	const text = document.getText();
	const link = (
		origin: Span,
		uri: string,
		range: LocationLink["targetRange"],
	): LocationLink => ({
		originSelectionRange: {
			start: document.positionAt(origin.start),
			end: document.positionAt(origin.end),
		},
		targetUri: uri,
		targetRange: range,
		targetSelectionRange: range,
	});
	const inSource = (origin: Span, location: SourceLocation) =>
		link(
			origin,
			pathToFileURL(location.path).href,
			point(location.line, location.character),
		);
	const symbol = symbolAt(text, offset);
	if (!symbol) {
		if (!enclosingDelimiter(text, offset)) return null;
		const found = await memberAt(open, text, offset);
		return found?.member.location
			? inSource(found.span, found.member.location)
			: null;
	}
	const inTemplate = (template: string, line = 0, character = 0) =>
		link(
			symbol,
			pathToFileURL(pathOf(project, template)).href,
			point(line, character),
		);
	const load = (template: string) =>
		project.overlay.get(template) ?? readTemplate(project, template);
	/** Goes to a function, filter, test or global in the project's TypeScript. */
	const inTypeScript = async (kind: keyof typeof REGISTRIES) => {
		const member = await registered(open, kind, symbol.name);
		return member?.location ? inSource(symbol, member.location) : null;
	};

	// A block name goes to the same block in the layout this template extends.
	const blockName =
		symbol.kind === "variable" &&
		/\{%-?\s*block\s+$/.test(
			text.slice(Math.max(0, symbol.start - 40), symbol.start),
		);

	if (symbol.kind === "variable" && !blockName) {
		const binding = bindingFor(templateTypes(open, text).scopes, symbol);
		if (binding) {
			return link(symbol, document.uri, {
				start: document.positionAt(binding.definition.start),
				end: document.positionAt(binding.definition.end),
			});
		}
		return inTypeScript("global");
	}
	if (symbol.kind === "function") {
		const local = macrosIn(text).get(symbol.name);
		if (local) {
			const position = document.positionAt(local.start);
			return link(
				symbol,
				document.uri,
				point(position.line, position.character),
			);
		}
	}
	if (!project.manifest) return null;

	if (symbol.kind === "template") {
		const target = resolveName(symbol.name, name ?? undefined);
		return target ? inTemplate(target) : null;
	}
	if (symbol.kind === "filter" || symbol.kind === "test") {
		return inTypeScript(symbol.kind);
	}

	if (symbol.kind === "function") {
		// A macro brought in with `from "x" import name`.
		for (const match of text.matchAll(
			/\{%-?\s*from\s+(["'])([^"']*)\1\s+import\s+([^%]*)%\}/g,
		)) {
			for (const part of (match[3] as string).split(",")) {
				const [original, alias = original] = part.trim().split(/\s+as\s+/);
				if (alias !== symbol.name || !original) continue;
				const target = resolveName(match[2] as string, name ?? undefined);
				const source = target ? await load(target) : null;
				const macro = source ? macrosIn(source).get(original) : null;
				if (target && source && macro) {
					const position = positionIn(source, macro.start);
					return inTemplate(target, position.line, position.character);
				}
			}
		}
		return inTypeScript("function");
	}

	if (blockName && name) {
		let current = name;
		for (let depth = 0; depth < 20; depth++) {
			const analysis = await analyse(
				project,
				current,
				current === name ? text : undefined,
			);
			const parent = analysis?.templates.find(
				(ref) => ref.kind === "extends",
			)?.name;
			if (!parent) return null;
			const source = await load(parent);
			const block = source
				? new RegExp(`\\{%-?\\s*block\\s+${symbol.name}\\b`).exec(source)
				: null;
			if (source && block) {
				const position = positionIn(source, block.index);
				return inTemplate(parent, position.line, position.character);
			}
			current = parent;
		}
	}
	return null;
};

const readTemplate = async (project: Project, name: string) => {
	try {
		return await readFile(pathOf(project, name), "utf8");
	} catch {
		return null;
	}
};

export const links = (open: OpenTemplate): DocumentLink[] => {
	const { document, project, name } = open;
	if (!project.manifest) return [];
	return templateStrings(document.getText()).flatMap((found) => {
		const target = resolveName(found.name, name ?? undefined);
		if (!target) return [];
		return [
			{
				range: {
					start: document.positionAt(found.start),
					end: document.positionAt(found.end),
				},
				target: pathToFileURL(pathOf(project, target)).href,
			},
		];
	});
};

const SYMBOL_KINDS: Record<string, SymbolKind> = {
	block: SymbolKind.Module,
	macro: SymbolKind.Function,
	slot: SymbolKind.Field,
	fill: SymbolKind.Field,
};

export const symbols = (document: TextDocument): DocumentSymbol[] => {
	const text = document.getText();
	const found: DocumentSymbol[] = [];
	for (const match of text.matchAll(
		/\{%-?\s*(block|macro|slot|fill)\b\s*(["']?)([\w-]*)\2[^%]*%\}/g,
	)) {
		const kind = match[1] as string;
		const range = {
			start: document.positionAt(match.index as number),
			end: document.positionAt((match.index as number) + match[0].length),
		};
		found.push({
			name: match[3] || (kind === "slot" ? "default" : kind),
			detail: kind,
			kind: SYMBOL_KINDS[kind] ?? SymbolKind.Field,
			range,
			selectionRange: range,
		});
	}
	return found;
};
