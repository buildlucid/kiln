import * as data from "./data.ts";

export type Scenario = {
	id: string;
	name: string;
	description: string;
	/** Template features the scenario exercises. */
	features: string[];
	/** Directory under `templates` holding one directory of templates per engine. */
	templates: string;
	data: Record<string, unknown>;
	/** Templates call async functions. Engines without async support sit this one out. */
	async: boolean;
	/** Measure setting up a new environment, compiling and rendering once, instead of rendering compiled templates. */
	cold: boolean;
};

/**
 * What the benchmark measures. Each scenario is a page a real site renders, written the way each engine's own
 * documentation suggests. They are not picked to favour any engine.
 */
export const scenarios: Scenario[] = [
	{
		id: "blog-post",
		name: "Blog post",
		description:
			"A full article page: a layout with blocks, header and footer partials, trusted body HTML, related posts and twenty escaped comments.",
		features: [
			"Layouts",
			"Partials",
			"Loops",
			"Conditionals",
			"Escaping",
			"Dates",
		],
		templates: "blog-post",
		data: data.blogPost,
		async: false,
		cold: false,
	},
	{
		id: "landing-page",
		name: "CMS landing page",
		description:
			"A page built from ten content sections, where each section's type picks the partial that renders it.",
		features: ["Dynamic partials", "Nested loops", "Conditionals", "Prices"],
		templates: "landing-page",
		data: data.landingPage,
		async: false,
		cold: false,
	},
	{
		id: "product-grid",
		name: "Product grid",
		description:
			"A shop category page that renders a product card component 48 times, with sale prices, badges and star ratings.",
		features: ["Components", "Slots", "Loops", "Prices"],
		templates: "product-grid",
		data: data.productGrid,
		async: false,
		cold: false,
	},
	{
		id: "data-table",
		name: "Data table",
		description:
			"An admin table with 500 rows and 6 columns. Mostly loop and output speed.",
		features: ["Large loops", "Loop variables", "Escaping"],
		templates: "data-table",
		data: data.dataTable,
		async: false,
		cold: false,
	},
	{
		id: "search-results",
		name: "Search results",
		description:
			"25 search results that run text through filters: truncate, join, sort, case changes, defaults, URL encoding and number formatting.",
		features: ["Filters", "Defaults", "URL encoding"],
		templates: "search-results",
		data: data.searchResults,
		async: false,
		cold: false,
	},
	{
		id: "async-data",
		name: "Async data",
		description:
			"A blog index that loads its own posts, categories and each post's author by calling async functions from the template.",
		features: ["Async functions", "Loops"],
		templates: "async-data",
		data: data.asyncData,
		async: true,
		cold: false,
	},
	{
		id: "first-render",
		name: "First render",
		description:
			"The blog post page from a cold start: create the environment, compile every template and render once. This is what a serverless cold start or a template edit in a CMS costs.",
		features: ["Parsing", "Compiling"],
		templates: "blog-post",
		data: data.blogPost,
		async: false,
		cold: true,
	},
];
