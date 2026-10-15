import { createKiln, memoryLoader, safe, withRender } from "@lucidcms/kiln";
import { createHighlighter, type ThemeRegistration } from "shiki";

/** Renders one of the site's own templates, such as `components/code`. */
type RenderTemplate = (
	name: string,
	context: Record<string, unknown>,
) => Promise<string>;

/** Languages code blocks can use. `kiln` borrows Shiki's Twig grammar until Kiln has its own. */
const languages = ["twig", "html", "typescript", "shellscript", "json"];
const aliases = { kiln: "twig", ts: "typescript", sh: "shellscript" };

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
		{ scope: ["punctuation.section.tag.twig"], settings: color("delimiter") },
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
			scope: ["entity.name.function", "support.function", "meta.function-call"],
			settings: color("function"),
		},
		{
			scope: ["variable", "variable.other.property", "meta.tag.template"],
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

	const toHtml = (code: string, lang: string) =>
		highlighter.codeToHtml(code, { lang, theme: "kiln" });

	/** Shows code without running it. */
	const highlight = async (
		source: unknown,
		lang: string,
		options: { title?: string } = {},
	) =>
		safe(
			await render("components/code", {
				title: options.title ?? null,
				code: safe(toHtml(dedent(String(source)), lang)),
			}),
		);

	/** Renders a Kiln snippet at build time and shows it with its output. A failing example fails the build. */
	const example = withRender(
		async (info, source: unknown, options: ExampleOptions = {}) => {
			const name = options.name ?? "page.kiln";
			const templates = Object.entries({
				[name]: source,
				...options.templates,
			}).map(([file, code]) => ({ name: file, code: dedent(String(code)) }));

			const kiln = createKiln({
				loader: memoryLoader(
					// Templates end with a line break, as files on disk do.
					Object.fromEntries(
						templates.map((file) => [file.name, `${file.code}\n`]),
					),
				),
				strict: options.strict ?? true,
				globals: { site: { name: "Example" } },
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
