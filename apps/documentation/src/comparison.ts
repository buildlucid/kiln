/** The engines Kiln is compared with, in column order. */
const engines = ["Kiln", "Twig", "Nunjucks", "LiquidJS", "Handlebars"] as const;

/** `true` has it, `false` doesn't, and a short note means it partly has it. */
type Cell = boolean | string;

/** A cell for each item in a tuple. Generic, so the mapped type keeps the tuple's length. */
type CellsFor<Columns extends readonly unknown[]> = {
	-readonly [Index in keyof Columns]: Cell;
};

type Row = {
	feature: string;
	link: string;
	/** One cell per engine, in the order of `engines`. */
	cells: CellsFor<typeof engines>;
	/** Shown in the short comparison on the landing page. */
	featured?: true;
};

type Group = {
	title: string;
	rows: Row[];
};

const groups: Group[] = [
	{
		title: "Layouts and reuse",
		rows: [
			{
				feature: "Layouts with blocks",
				link: "/docs/tags/extends/",
				cells: [true, true, true, true, "Partial blocks"],
			},
			{
				feature: "Includes",
				link: "/docs/tags/include/",
				cells: [true, true, true, true, true],
			},
			{
				feature: "Macros",
				link: "/docs/tags/macro/",
				cells: [true, true, true, false, false],
			},
			{
				feature: "Components with named slots",
				link: "/docs/tags/component/",
				cells: [true, true, "One slot", false, "One slot"],
				featured: true,
			},
			{
				feature: "Props with types and defaults",
				link: "/docs/tags/props/",
				cells: [true, "Types aren't checked", false, false, false],
				featured: true,
			},
			{
				feature: "Includes isolated by default",
				link: "/docs/tags/include/#isolated-by-default",
				cells: [true, "With only", false, "With render", false],
			},
			{
				feature: "Render a single block",
				link: "/docs/api/rendering/#rendering-one-block",
				cells: [true, true, false, false, false],
			},
		],
	},
	{
		title: "Expressions",
		rows: [
			{
				feature: "Your own filters and functions",
				link: "/docs/api/extending/",
				cells: [true, true, true, "Filters only", "Helpers"],
			},
			{
				feature: "Arrow functions",
				link: "/docs/language/expressions/#arrow-functions",
				cells: [true, true, false, false, false],
			},
			{
				feature: "Null coalescing with ??",
				link: "/docs/language/expressions/#operators",
				cells: [true, true, false, false, false],
			},
			{
				feature: "Missing variables are errors by default",
				link: "/docs/language/strict-mode/",
				cells: [true, "Option", "Option", "Option", "Option"],
			},
		],
	},
	{
		title: "Escaping and safety",
		rows: [
			{
				feature: "Output escaped by default",
				link: "/docs/language/escaping/",
				cells: [true, true, true, "Option", true],
			},
			{
				feature: "Escaping for attributes, JavaScript, CSS and URLs",
				link: "/docs/language/escaping/#strategies",
				cells: [true, true, false, false, false],
			},
			{
				feature: "Safe for templates you didn't write",
				link: "/docs/api/safety/",
				cells: [true, "Opt-in sandbox", false, true, "Blocks prototypes"],
				featured: true,
			},
			{
				feature: "Limits on steps, output and depth",
				link: "/docs/api/safety/#limits",
				cells: [true, false, false, true, false],
			},
		],
	},
	{
		title: "Data and output",
		rows: [
			{
				feature: "Async data",
				link: "/docs/language/async-data/",
				cells: [true, false, "Callback API", true, false],
				featured: true,
			},
			{
				feature: "Streaming",
				link: "/docs/api/streaming/",
				cells: [true, true, false, "Node streams only", false],
				featured: true,
			},
			{
				feature: "Server islands",
				link: "/docs/tags/island/",
				cells: [true, false, false, false, false],
				featured: true,
			},
			{
				feature: "Fragment caching",
				link: "/docs/tags/cache/",
				cells: [true, "Extension", false, false, false],
			},
			{
				feature: "Number and date formatting with Intl",
				link: "/docs/filters/numbers-and-dates/",
				cells: [true, "Extension", false, "Dates only", false],
			},
			{
				feature: "Plurals for any locale",
				link: "/docs/filters/numbers-and-dates/#plural",
				cells: [true, false, false, false, false],
			},
			{
				feature: "Lines up indentation",
				link: "/docs/language/syntax/#indentation",
				cells: [true, false, false, false, false],
			},
		],
	},
	{
		title: "Running and tooling",
		rows: [
			{
				feature: "Runs on Cloudflare Workers",
				link: "/docs/installation/#cloudflare-workers",
				cells: [true, false, "Precompiled only", true, "Precompiled only"],
				featured: true,
			},
			{
				feature: "Precompile at build time",
				link: "/docs/api/precompiling/",
				cells: [true, true, true, false, true],
			},
			{
				feature: "Types generated from templates",
				link: "/docs/api/types/",
				cells: [true, false, false, false, false],
				featured: true,
			},
			{
				feature: "Formatter and language server",
				link: "/docs/tooling/formatting/",
				cells: [
					true,
					"Third party",
					"Third party",
					"Third party",
					"Third party",
				],
			},
		],
	},
];

/** The feature comparison with other template languages, for the comparison page and the landing page (the `comparison` global). */
export const comparison = {
	engines,
	groups,
	featured: groups.flatMap((group) => group.rows.filter((row) => row.featured)),
};
