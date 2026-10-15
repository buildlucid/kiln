/** One page in the docs sidebar. `description` is the page's meta description and the lead under its title. */
export type NavItem = { title: string; url: string; description: string };
export type NavSection = { title: string; items: NavItem[] };

/** The docs sidebar, in reading order. Every docs page must appear here exactly once. */
export const navigation = [
	{
		title: "Getting started",
		items: [
			{
				title: "Introduction",
				url: "/docs/",
				description: "What Kiln is, and what it is good at.",
			},
			{
				title: "Installation",
				url: "/docs/installation/",
				description: "Add Kiln to a Node or Cloudflare Workers project.",
			},
			{
				title: "Quick start",
				url: "/docs/quick-start/",
				description: "Render a page with a layout in a few minutes.",
			},
		],
	},
	{
		title: "Language",
		items: [
			{
				title: "Syntax",
				url: "/docs/language/syntax/",
				description: "Delimiters, comments, strings and whitespace.",
			},
			{
				title: "Values",
				url: "/docs/language/values/",
				description: "The types templates work with, and how they print.",
			},
			{
				title: "Expressions",
				url: "/docs/language/expressions/",
				description: "Operators, property access, calls, filters and tests.",
			},
			{
				title: "Variables and scope",
				url: "/docs/language/variables/",
				description: "Where variables come from and how long they live.",
			},
			{
				title: "Strict mode",
				url: "/docs/language/strict-mode/",
				description: "How Kiln catches typos and missing data.",
			},
			{
				title: "Escaping",
				url: "/docs/language/escaping/",
				description: "Output is escaped by default. Here is how to control it.",
			},
			{
				title: "Async data",
				url: "/docs/language/async-data/",
				description: "Load data from templates with async functions.",
			},
		],
	},
	{
		title: "Tags",
		items: [
			{
				title: "if",
				url: "/docs/tags/if/",
				description: "Render content only when a condition holds.",
			},
			{
				title: "for",
				url: "/docs/tags/for/",
				description: "Loop over arrays, hashes and other collections.",
			},
			{
				title: "set",
				url: "/docs/tags/set/",
				description: "Assign a value or captured markup to a variable.",
			},
			{
				title: "props",
				url: "/docs/tags/props/",
				description: "Declare the variables a template expects.",
			},
			{
				title: "extends and block",
				url: "/docs/tags/extends/",
				description: "Share a layout between pages.",
			},
			{
				title: "include",
				url: "/docs/tags/include/",
				description: "Render another template in place.",
			},
			{
				title: "component",
				url: "/docs/tags/component/",
				description: "Build reusable pieces of markup with props and slots.",
			},
			{
				title: "macro and import",
				url: "/docs/tags/macro/",
				description: "Define small reusable snippets you call like functions.",
			},
			{
				title: "with",
				url: "/docs/tags/with/",
				description: "Add variables for a section of a template.",
			},
			{
				title: "apply",
				url: "/docs/tags/apply/",
				description: "Run a section of output through filters.",
			},
			{
				title: "autoescape",
				url: "/docs/tags/autoescape/",
				description: "Change how output is escaped for a section.",
			},
			{
				title: "verbatim",
				url: "/docs/tags/verbatim/",
				description: "Output Kiln syntax without running it.",
			},
		],
	},
	{
		title: "Reference",
		items: [
			{
				title: "String filters",
				url: "/docs/filters/strings/",
				description: "Filters for changing and encoding text.",
			},
			{
				title: "List filters",
				url: "/docs/filters/lists/",
				description: "Filters for arrays, hashes and other collections.",
			},
			{
				title: "Number and date filters",
				url: "/docs/filters/numbers-and-dates/",
				description: "Round numbers and format numbers and dates with Intl.",
			},
			{
				title: "Functions",
				url: "/docs/functions/",
				description: "Built-in functions, from range to attrs.",
			},
			{
				title: "Tests",
				url: "/docs/tests/",
				description: "Built-in tests for use with is.",
			},
		],
	},
	{
		title: "JavaScript API",
		items: [
			{
				title: "Creating an environment",
				url: "/docs/api/create-kiln/",
				description: "Set up Kiln with createKiln and its options.",
			},
			{
				title: "Rendering",
				url: "/docs/api/rendering/",
				description: "Render pages, single blocks and request data.",
			},
			{
				title: "Loaders",
				url: "/docs/api/loaders/",
				description: "Tell Kiln where templates come from.",
			},
			{
				title: "Functions, filters and tests",
				url: "/docs/api/extending/",
				description: "Add your own functions, filters, tests and globals.",
			},
			{
				title: "Safe markup and classes",
				url: "/docs/api/safe-markup/",
				description: "Return trusted HTML and expose class instances.",
			},
			{
				title: "Errors and checks",
				url: "/docs/api/errors/",
				description: "Handle errors and check templates before rendering.",
			},
			{
				title: "Safety and limits",
				url: "/docs/api/safety/",
				description: "Run templates you didn't write.",
			},
		],
	},
	{
		title: "Guides",
		items: [
			{
				title: "Coming from Twig",
				url: "/docs/coming-from-twig/",
				description: "What is the same, what changed and why.",
			},
		],
	},
] satisfies NavSection[];

/** Pages outside the docs sidebar. */
const standalone: Record<string, NavItem> = {
	"/": {
		title: "Kiln",
		url: "/",
		description:
			"A fast, safe template language for building websites. Familiar syntax, async data, and it runs on Node and Cloudflare Workers.",
	},
	"/404.html": {
		title: "Page not found",
		url: "/404.html",
		description: "This page doesn't exist.",
	},
};

const items = navigation.flatMap((section) =>
	section.items.map((item) => ({ ...item, section: section.title })),
);

/** The variables each page renders with: its own details and the pages before and after it. */
export const pageContext = (url: string) => {
	const index = items.findIndex((item) => item.url === url);
	const page = items[index] ?? standalone[url];
	if (!page) throw new Error(`${url} needs an entry in src/navigation.ts`);
	return {
		page,
		previous: index > 0 ? items[index - 1] : null,
		next: index >= 0 ? (items[index + 1] ?? null) : null,
	};
};
