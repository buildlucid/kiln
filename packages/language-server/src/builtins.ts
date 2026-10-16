/** A built-in filter, function or test: how to call it and what it does, for completions and hover. */
export type BuiltinDoc = { signature: string; description: string };

/** A tag: the snippet that completes it after `{%`, and what it does. `$0` marks where the cursor ends. */
export type TagDoc = { snippet: string; description: string };

const block = (name: string, header: string) =>
	`${name}${header} %}\n\t$0\n{% end${name} %}`;

export const TAGS: Record<string, TagDoc> = {
	if: {
		snippet: block("if", " ${1:condition}"),
		description: "Renders its body only when a condition holds.",
	},
	elseif: {
		snippet: "elseif ${1:condition} %}",
		description: "Another condition to try in an `if`.",
	},
	else: {
		snippet: "else %}",
		description:
			"Renders when no condition in an `if` held, or a `for` loop had no items.",
	},
	for: {
		snippet: block("for", " ${1:item} in ${2:items}"),
		description: "Loops over an array, hash or other collection.",
	},
	set: {
		snippet: "set ${1:name} = ${2:value} %}",
		description: "Assigns a value, or captured markup, to a variable.",
	},
	props: {
		snippet: "props ${1:name} %}",
		description:
			"Declares the variables a template expects, with optional types and defaults.",
	},
	extends: {
		snippet: 'extends "${1:layouts/base}" %}',
		description:
			"Renders this template inside a layout, filling the layout's blocks.",
	},
	block: {
		snippet: block("block", " ${1:name}"),
		description:
			"Defines a block that a layout renders and a page can replace.",
	},
	include: {
		snippet: 'include "${1}" %}',
		description: "Renders another template in place.",
	},
	component: {
		snippet: 'component "${1}" with { $2 } %}\n\t$0\n{% endcomponent %}',
		description: "Renders a component, passing it props and filling its slots.",
	},
	fill: {
		snippet: block("fill", ' "${1:name}"'),
		description: "Fills a named slot of a component.",
	},
	slot: {
		snippet: "slot %}$0{% endslot %}",
		description: "Marks where a component renders the content it is given.",
	},
	macro: {
		snippet: block("macro", " ${1:name}(${2})"),
		description: "Defines a reusable snippet you call like a function.",
	},
	import: {
		snippet: 'import "${1}" as ${2:name} %}',
		description: "Imports another template's macros under one name.",
	},
	from: {
		snippet: 'from "${1}" import ${2:name} %}',
		description: "Imports chosen macros from another template.",
	},
	with: {
		snippet: block("with", " { ${1} }"),
		description: "Adds variables for a section of a template.",
	},
	apply: {
		snippet: block("apply", " ${1:filter}"),
		description: "Runs a section of output through filters.",
	},
	autoescape: {
		snippet: block("autoescape", ' "${1:html}"'),
		description: "Changes how output is escaped for a section.",
	},
	verbatim: {
		snippet: "verbatim %}\n$0\n{% endverbatim %}",
		description: "Outputs Kiln syntax as text, without running it.",
	},
};

/** Tags that have a body and an end tag. */
export const BLOCK_TAGS = new Set([
	"if",
	"for",
	"set",
	"block",
	"component",
	"fill",
	"slot",
	"macro",
	"with",
	"apply",
	"autoescape",
	"verbatim",
]);

export const FILTERS: Record<string, BuiltinDoc> = {
	upper: { signature: "upper", description: "Changes text to upper case." },
	lower: { signature: "lower", description: "Changes text to lower case." },
	capitalize: {
		signature: "capitalize",
		description:
			"Makes the first character upper case and the rest lower case.",
	},
	title: {
		signature: "title",
		description:
			"Starts each word with an upper-case letter and makes the rest lower case.",
	},
	trim: {
		signature: "trim(characters?, side?)",
		description:
			'Removes whitespace, or the given characters, from both ends. Pass "start" or "end" to trim one side.',
	},
	replace: {
		signature: "replace(search, replacement)",
		description:
			"Replaces every match of a piece of text. Pass a hash to replace several at once.",
	},
	split: {
		signature: "split(separator, limit?)",
		description:
			"Splits text into an array. An empty separator splits into characters.",
	},
	truncate: {
		signature: "truncate(length, ellipsis?)",
		description:
			"Shortens text to a length and adds an ellipsis if it cut anything.",
	},
	stripTags: {
		signature: "stripTags",
		description: "Removes HTML tags and comments.",
	},
	nl2br: {
		signature: "nl2br",
		description: "Escapes the text, then adds a `<br>` before each line break.",
	},
	urlEncode: {
		signature: "urlEncode",
		description:
			"Encodes a string for a URL, or turns a hash into a query string.",
	},
	json: {
		signature: "json(indent?)",
		description:
			"Turns a value into JSON that is safe inside a `<script>` tag.",
	},
	escape: {
		signature: "escape(strategy?)",
		description:
			'Escapes a value with a strategy: "html" (the default), "attr", "js", "css" or "url".',
	},
	raw: {
		signature: "raw",
		description:
			"Marks a value as safe, so it is output without escaping. Only use it for HTML you trust.",
	},
	default: {
		signature: "default(fallback)",
		description:
			"Returns a fallback when the value is empty or missing. Stops a missing value being an error in strict mode.",
	},
	length: {
		signature: "length",
		description:
			"Counts the items in an array, the keys in a hash, or the characters in a string.",
	},
	first: {
		signature: "first",
		description:
			"Returns the first item or character, or null when there is none.",
	},
	last: {
		signature: "last",
		description:
			"Returns the last item or character, or null when there is none.",
	},
	slice: {
		signature: "slice(start, end?)",
		description:
			"Returns part of an array or string. Negative numbers count from the end.",
	},
	join: {
		signature: "join(glue?, lastGlue?)",
		description:
			"Joins items into a string. A second glue goes between the last two items.",
	},
	keys: {
		signature: "keys",
		description:
			"Returns the keys of a hash or map, or the indexes of an array.",
	},
	merge: {
		signature: "merge(...values)",
		description:
			"Joins arrays together, or combines hashes, with later keys winning.",
	},
	reverse: {
		signature: "reverse",
		description: "Reverses an array or string.",
	},
	sort: {
		signature: "sort(by?)",
		description:
			"Returns a sorted copy, in natural order or by an arrow function.",
	},
	map: {
		signature: "map((value, key) => ...)",
		description:
			"Calls an arrow function for each item and returns the results.",
	},
	filter: {
		signature: "filter((value, key) => ...)",
		description: "Keeps the items for which the arrow function returns true.",
	},
	reduce: {
		signature: "reduce((total, value, key) => ..., initial)",
		description: "Combines the items into one value, starting from `initial`.",
	},
	find: {
		signature: "find((value, key) => ...)",
		description:
			"Returns the first item for which the arrow function returns true, or null.",
	},
	column: {
		signature: "column(name)",
		description: "Reads one property from each item.",
	},
	batch: {
		signature: "batch(size, fill?)",
		description: "Splits an array into groups of a given size.",
	},
	abs: {
		signature: "abs",
		description: "Returns the absolute value of a number.",
	},
	round: {
		signature: "round(precision?, method?)",
		description:
			'Rounds to a number of decimal places. The method is "common", "ceil" or "floor".',
	},
	formatNumber: {
		signature: "formatNumber(...options)",
		description:
			"Formats a number with `Intl.NumberFormat`. Pass its options, and `locale`, as named arguments.",
	},
	formatDate: {
		signature: "formatDate(...options)",
		description:
			"Formats a date with `Intl.DateTimeFormat`. Pass its options, `locale` and `timeZone`, as named arguments.",
	},
};

export const FUNCTIONS: Record<string, BuiltinDoc> = {
	range: {
		signature: "range(start, end, step?)",
		description:
			"Returns an array of numbers from start to end, including both.",
	},
	max: {
		signature: "max(...values)",
		description:
			"Returns the largest argument, or the largest item of one array.",
	},
	min: {
		signature: "min(...values)",
		description:
			"Returns the smallest argument, or the smallest item of one array.",
	},
	cycle: {
		signature: "cycle(values, position)",
		description:
			"Returns the item at a position, starting again from the beginning when it runs out.",
	},
	date: {
		signature: "date(value?)",
		description:
			"Returns a Date from a date, an ISO 8601 string or milliseconds, or the current time.",
	},
	attrs: {
		signature: "attrs(attributes)",
		description: "Builds HTML attributes from a hash.",
	},
	dump: {
		signature: "dump(...values)",
		description:
			"Outputs a readable view of its arguments, when the environment has `debug: true`.",
	},
	parent: {
		signature: "parent()",
		description: "Outputs the layout's version of the current block.",
	},
	block: {
		signature: "block(name)",
		description: "Outputs another block of the current template.",
	},
};

export const TESTS: Record<string, BuiltinDoc> = {
	defined: {
		signature: "defined",
		description:
			"True when a variable or property exists. Never a strict mode error.",
	},
	null: {
		signature: "null",
		description: "True when the value is null or undefined.",
	},
	empty: {
		signature: "empty",
		description:
			"True for null, false, and an empty string, array, hash, set or map.",
	},
	even: { signature: "even", description: "True for an even whole number." },
	odd: { signature: "odd", description: "True for an odd whole number." },
	iterable: {
		signature: "iterable",
		description:
			"True for arrays, hashes, sets, maps and other values you can loop over.",
	},
	"divisible by": {
		signature: "divisible by(divisor)",
		description: "True when the value is a multiple of the divisor.",
	},
};

export const LOOP_PROPERTIES: Record<string, string> = {
	index: "Position, starting at 1.",
	index0: "Position, starting at 0.",
	revIndex: "Items left, ending at 1.",
	revIndex0: "Items left, ending at 0.",
	first: "`true` on the first item.",
	last: "`true` on the last item.",
	length: "Total number of items.",
};

export const KEYWORDS = [
	"true",
	"false",
	"null",
	"and",
	"or",
	"not",
	"in",
	"is",
];
