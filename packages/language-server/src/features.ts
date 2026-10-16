import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { AnalysedProp, Analysis, PropType } from "@lucidcms/kiln";
import {
	type CompletionItem,
	CompletionItemKind,
	type DocumentLink,
	type DocumentSymbol,
	type Hover,
	InsertTextFormat,
	InsertTextMode,
	type Location,
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
import { cursorContext, symbolAt, templateStrings } from "./context.js";
import { listTemplates, pathOf, type Project, resolveName } from "./project.js";

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

const builtinItems = (
	docs: Record<string, BuiltinDoc>,
	kind: CompletionItemKind,
	extra: readonly string[],
): CompletionItem[] => [
	...Object.entries(docs).map(([label, doc]) => ({
		label,
		kind,
		detail: doc.signature,
		documentation: markdown(doc.description),
	})),
	...extra
		.filter((name) => !(name in docs))
		.map((label) => ({ label, kind, detail: "From your project" })),
];

/** Names a template sets or brings into scope before `offset`: loop variables, sets, macros and imports. */
const localNames = (text: string, offset: number): string[] => {
	const before = text.slice(0, offset);
	const names = new Set<string>();
	for (const match of before.matchAll(
		/\{%-?\s*for\s+(\w+)(?:\s*,\s*(\w+))?\s+in\b/g,
	)) {
		names.add(match[1] as string);
		if (match[2]) names.add(match[2]);
	}
	for (const match of before.matchAll(/\{%-?\s*(?:set|macro)\s+(\w+)/g)) {
		names.add(match[1] as string);
	}
	for (const match of before.matchAll(
		/\{%-?\s*import\s+["'][^"']*["']\s+as\s+(\w+)/g,
	)) {
		names.add(match[1] as string);
	}
	for (const match of before.matchAll(
		/\{%-?\s*from\s+["'][^"']*["']\s+import\s+([^%]*)%\}/g,
	)) {
		for (const part of (match[1] as string).split(",")) {
			const alias = /(\w+)\s*$/.exec(part.trim())?.[1];
			if (alias) names.add(alias);
		}
	}
	return [...names];
};

export const complete = async (
	open: OpenTemplate,
	offset: number,
): Promise<CompletionItem[]> => {
	const { document, project, name } = open;
	const text = document.getText();
	const context = cursorContext(text, offset);
	if (!context) return [];
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
					documentation: markdown(tag.description),
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
				CompletionItemKind.Function,
				manifest?.filters ?? [],
			);
		case "test":
			return builtinItems(
				TESTS,
				CompletionItemKind.Function,
				manifest?.tests ?? [],
			);
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
			const variables = new Set([
				...(analysis?.props.map((prop) => prop.name) ?? []),
				...localNames(text, offset),
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

const codeBlock = (code: string) => `\`\`\`kiln\n${code}\n\`\`\``;

export const hover = async (
	open: OpenTemplate,
	offset: number,
): Promise<Hover | null> => {
	const { document, project, name } = open;
	const text = document.getText();
	const symbol = symbolAt(text, offset);
	if (!symbol) return null;
	const range = {
		start: document.positionAt(symbol.start),
		end: document.positionAt(symbol.end),
	};
	const fromProject = (names: readonly string[] | undefined, what: string) =>
		names?.includes(symbol.name) ? `A ${what} your project registers.` : null;
	let value: string | null = null;

	switch (symbol.kind) {
		case "filter": {
			const doc = FILTERS[symbol.name];
			value = doc
				? `${codeBlock(`|${doc.signature}`)}\n${doc.description}`
				: fromProject(project.manifest?.filters, "filter");
			break;
		}
		case "test": {
			const doc = TESTS[symbol.name];
			value = doc
				? `${codeBlock(`is ${doc.signature}`)}\n${doc.description}`
				: fromProject(project.manifest?.tests, "test");
			break;
		}
		case "loop": {
			const description = LOOP_PROPERTIES[symbol.name];
			value = description
				? `${codeBlock(`loop.${symbol.name}`)}\n${description}`
				: null;
			break;
		}
		case "function": {
			const macro = macrosIn(text).get(symbol.name);
			const doc = FUNCTIONS[symbol.name];
			if (macro) value = codeBlock(`macro ${symbol.name}(${macro.params})`);
			else if (doc) value = `${codeBlock(doc.signature)}\n${doc.description}`;
			else value = fromProject(project.manifest?.functions, "function");
			break;
		}
		case "variable": {
			const analysis = name ? await analyse(project, name, text) : null;
			const prop = analysis?.props.find((item) => item.name === symbol.name);
			if (prop)
				value = `${codeBlock(describeProp(prop))}\nA prop of this template.`;
			else if (project.manifest?.globals.includes(symbol.name)) {
				value = "A global your project provides.";
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
			if (analysis.props.length > 0) {
				lines.push(
					codeBlock(`props ${analysis.props.map(describeProp).join(", ")}`),
				);
			}
			if (analysis.blocks.length > 0) {
				lines.push(
					`Blocks: ${analysis.blocks.map((block) => `\`${block}\``).join(", ")}`,
				);
			}
			value = lines.join("\n\n");
		}
	}
	return value ? { contents: markdown(value), range } : null;
};

const fileLocation = (
	project: Project,
	name: string,
	line = 0,
	character = 0,
): Location => ({
	uri: pathToFileURL(pathOf(project, name)).href,
	range: { start: { line, character }, end: { line, character } },
});

/** The line and column of an offset in another template's text. */
const positionIn = (text: string, offset: number) => {
	const lines = text.slice(0, offset).split("\n");
	return { line: lines.length - 1, character: (lines.at(-1) as string).length };
};

export const definition = async (
	open: OpenTemplate,
	offset: number,
): Promise<Location | null> => {
	const { document, project, name } = open;
	const text = document.getText();
	const symbol = symbolAt(text, offset);
	if (!symbol) return null;
	const load = (template: string) =>
		project.overlay.get(template) ?? readTemplate(project, template);

	if (symbol.kind === "template") {
		const target = resolveName(symbol.name, name ?? undefined);
		return target ? fileLocation(project, target) : null;
	}

	if (symbol.kind === "function") {
		const local = macrosIn(text).get(symbol.name);
		if (local) {
			const position = document.positionAt(local.start);
			return { uri: document.uri, range: { start: position, end: position } };
		}
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
					return fileLocation(
						project,
						target,
						position.line,
						position.character,
					);
				}
			}
		}
		return null;
	}

	// A block name goes to the same block in the layout this template extends.
	const tag = /\{%-?\s*block\s+$/.exec(
		text.slice(Math.max(0, symbol.start - 40), symbol.start),
	);
	if (symbol.kind === "variable" && tag && name) {
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
				return fileLocation(project, parent, position.line, position.character);
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
