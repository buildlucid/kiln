import {
	createKiln,
	KilnSyntaxError,
	memoryLoader,
	safe,
	withRender,
} from "@lucidkiln/core";
import { format } from "@lucidkiln/core/format";
import {
	createHighlighter,
	type LanguageRegistration,
	type ThemeRegistration,
} from "shiki";
import grammar from "../../../editors/vscode/syntaxes/kiln.tmLanguage.json" with { type: "json" };

/** Renders one of the site's own templates, such as `components/code`. */
type RenderTemplate = (
	name: string,
	context: Record<string, unknown>,
) => Promise<string>;

/** Kiln's grammar from the VS Code extension. It embeds `html-derivative`, VS Code's HTML grammar for templates. */
const kiln = {
	...(grammar as unknown as LanguageRegistration),
	name: "kiln",
	embeddedLangs: ["html-derivative"],
};

/** Languages code blocks can use. */
const languages = [
	"html-derivative",
	kiln,
	"html",
	"typescript",
	"shellscript",
	"json",
];
const aliases = { ts: "typescript", sh: "shellscript" };

/** Token colours are `--code-*` custom properties, set in `styles.css`. */
const color = (name: string, fontStyle?: string) => ({
	foreground: `var(--code-${name})`,
	...(fontStyle && { fontStyle }),
});

const theme: ThemeRegistration = {
	name: "kiln",
	type: "dark",
	colors: {
		"editor.background": "var(--code-background)",
		"editor.foreground": "var(--code-foreground)",
	},
	tokenColors: [
		{
			scope: ["comment", "punctuation.definition.comment"],
			settings: color("comment", "italic"),
		},
		{
			scope: [
				"punctuation.section.embedded.begin.kiln",
				"punctuation.section.embedded.end.kiln",
				"punctuation.section.interpolation.begin.kiln",
				"punctuation.section.interpolation.end.kiln",
			],
			settings: color("delimiter"),
		},
		{
			scope: ["keyword", "storage", "keyword.control"],
			settings: color("keyword"),
		},
		{
			scope: ["keyword.operator", "punctuation", "meta.brace"],
			settings: color("punctuation"),
		},
		{ scope: ["entity.name.tag"], settings: color("tag") },
		{ scope: ["entity.other.attribute-name"], settings: color("attribute") },
		{ scope: ["string"], settings: color("string") },
		{
			scope: [
				"constant",
				"support.constant",
				"entity.name.type",
				"support.type",
				"entity.name.class",
			],
			settings: color("constant"),
		},
		{
			scope: [
				"entity.name.function",
				"entity.name.section",
				"support.function",
				"meta.function-call",
			],
			settings: color("function"),
		},
		{
			// Kiln inside an HTML attribute value isn't part of the string.
			scope: [
				"variable",
				"variable.other.property",
				"support.type.property-name.kiln",
				"meta.embedded.output.kiln",
				"meta.embedded.tag.kiln",
			],
			settings: color("foreground"),
		},
	],
};

/** Removes blank lines around the code and the indentation every line shares. */
export const dedent = (source: string): string => {
	const lines = source.replace(/^\s*\n|\s+$/g, "").split("\n");
	const indents = lines
		.filter((line) => line.trim())
		.map((line) => /^[\t ]*/.exec(line)?.[0].length ?? 0);
	const shared = Math.min(...indents);
	return lines.map((line) => line.slice(shared)).join("\n");
};

/**
 * Indents rendered HTML to match its elements, so example output reads well. Kiln doesn't indent the content it inserts,
 * so output from includes, components and blocks would otherwise sit at the margin. Output the formatter can't read,
 * such as Kiln code printed as text, is shown as it is.
 */
const tidyOutput = (html: string): string => {
	try {
		return format(`${html}\n`).replace(/\n$/, "");
	} catch {
		return html;
	}
};

/**
 * Fails the build when a Kiln snippet isn't laid out as `kiln format` would, so the docs teach the house style.
 * Snippets that aren't whole templates, such as a lone `{% if %}` tag, can't be formatted and are skipped.
 */
const assertFormatted = (code: string, where: string) => {
	let formatted: string;
	try {
		formatted = format(`${code}\n`).replace(/\n$/, "");
	} catch (error) {
		if (error instanceof KilnSyntaxError) return;
		throw error;
	}
	if (formatted !== code)
		throw new Error(
			`${where} isn't formatted. Format it as below, or pass format: false if that is deliberate:\n\n${formatted}`,
		);
};

/** Data for the example environment's async functions, so examples can show `document()` and `documents()`. */
const posts = [
	{
		title: "Hello, world",
		url: "/blog/hello-world/",
		publishedAt: "2026-10-01",
	},
	{
		title: "Layouts in Kiln",
		url: "/blog/layouts/",
		publishedAt: "2026-10-08",
	},
	{
		title: "Shipping to Workers",
		url: "/blog/workers/",
		publishedAt: "2026-10-12",
	},
];

type ExampleOptions = {
	/** Variables for the render. */
	context?: Record<string, unknown>;
	/** Other templates the example uses, by name. Shown after the main template. */
	templates?: Record<string, unknown>;
	/** Name of the main template. Default `page.kiln`. */
	name?: string;
	/** Set to `false` to render in lenient mode. */
	strict?: boolean;
	/** The example must fail. Shows the error message instead of output. */
	error?: boolean;
	/** Set to `false` to show only the output, when the page already shows the templates. */
	source?: boolean;
	/**
	 * Set to `false` when the templates are deliberately not formatted, such as to show how whitespace works. The output
	 * is then shown exactly as rendered too.
	 */
	format?: boolean;
};

/**
 * Creates the `highlight` and `example` filters. Use them with `apply` and `verbatim`:
 *
 * ```kiln
 * {% apply example(context: { name: "Ada" }) %}
 * {% verbatim %}
 * <p>Hello, {{ name }}</p>
 * {% endverbatim %}
 * {% endapply %}
 * ```
 */
export const createCodeFilters = async (render: RenderTemplate) => {
	const highlighter = await createHighlighter({
		themes: [theme],
		langs: languages,
		langAlias: aliases,
	});

	/** Highlights code. `data-lang` on the `pre` tells the Markdown copy of the page which language to fence it as. */
	const toHtml = (code: string, lang: string) =>
		highlighter.codeToHtml(code, {
			lang,
			theme: "kiln",
			transformers: [
				{
					pre(node) {
						node.properties["data-lang"] = lang;
					},
				},
			],
		});

	/** Shows code without running it. Kiln code must be formatted, unless `format` is `false`. */
	const highlight = withRender(
		async (
			info,
			source: unknown,
			lang: string,
			options: { title?: string; format?: boolean } = {},
		) => {
			const code = dedent(String(source));
			if (lang === "kiln" && options.format !== false)
				assertFormatted(
					code,
					`A ${options.title ?? "code block"} in ${info.template}`,
				);
			return safe(
				await render("components/code", {
					title: options.title ?? null,
					code: safe(toHtml(code, lang)),
				}),
			);
		},
	);

	/** Renders a Kiln snippet at build time and shows it with its output. A failing example fails the build. */
	const example = withRender(
		async (info, source: unknown, options: ExampleOptions = {}) => {
			const name = options.name ?? "page.kiln";
			const templates = Object.entries({
				[name]: source,
				...options.templates,
			}).map(([file, code]) => ({ name: file, code: dedent(String(code)) }));
			if (options.format !== false)
				for (const file of templates)
					assertFormatted(
						file.code,
						`${file.name} in an example in ${info.template}`,
					);

			const kiln = createKiln({
				loader: memoryLoader(
					// Templates end with a line break, as files on disk do.
					Object.fromEntries(
						templates.map((file) => [file.name, `${file.code}\n`]),
					),
				),
				strict: options.strict ?? true,
				globals: { site: { name: "Example" } },
				types: {
					Post: (value) =>
						typeof value === "object" &&
						value !== null &&
						"title" in value &&
						"url" in value,
				},
				functions: {
					document: async (collection: string) => ({
						...posts[0],
						collection,
					}),
					documents: async (_collection: string, query?: { limit?: number }) =>
						posts.slice(0, query?.limit ?? posts.length),
				},
			});

			let output: string;
			let failed = false;
			try {
				output = dedent(await kiln.render(name, options.context));
				if (options.format !== false) output = tidyOutput(output);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!options.error)
					throw new Error(`An example in ${info.template} failed: ${message}`, {
						cause: error,
					});
				output = message.split("\n")[0] ?? "";
				failed = true;
			}
			if (options.error && !failed)
				throw new Error(
					`An example in ${info.template} should fail, but it rendered`,
				);

			return safe(
				await render("components/example", {
					files: (options.source === false ? [] : templates).map((file) => ({
						name: file.name,
						code: safe(toHtml(file.code, "kiln")),
					})),
					output: safe(toHtml(output || " ", failed ? "text" : "html")),
					failed,
				}),
			);
		},
	);

	return { highlight, example };
};
