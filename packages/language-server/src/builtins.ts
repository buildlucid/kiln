/** A built-in filter, function or test: how to call it, for completions and hover. What it does comes from `docs.json`. */
export type BuiltinDoc = { signature: string };

/** A tag: the snippet that completes it after `{%`. `$0` marks where the cursor ends. What it does comes from `docs.json`. */
export type TagDoc = { snippet: string };

const block = (name: string, header: string) =>
	`${name}${header} %}\n\t$0\n{% end${name} %}`;

export const TAGS: Record<string, TagDoc> = {
	if: {
		snippet: block("if", " ${1:condition}"),
	},
	elseif: {
		snippet: "elseif ${1:condition} %}",
	},
	else: {
		snippet: "else %}",
	},
	for: {
		snippet: block("for", " ${1:item} in ${2:items}"),
	},
	set: {
		snippet: "set ${1:name} = ${2:value} %}",
	},
	props: {
		snippet: "props ${1:name} %}",
	},
	extends: {
		snippet: 'extends "${1:layouts/base}" %}',
	},
	block: {
		snippet: block("block", " ${1:name}"),
	},
	include: {
		snippet: 'include "${1}" %}',
	},
	component: {
		snippet: 'component "${1}" with { $2 } %}\n\t$0\n{% endcomponent %}',
	},
	island: {
		snippet: 'island "${1}" with { $2 } %}\n\t$0\n{% endisland %}',
	},
	fill: {
		snippet: block("fill", ' "${1:name}"'),
	},
	slot: {
		snippet: "slot %}$0{% endslot %}",
	},
	macro: {
		snippet: block("macro", " ${1:name}(${2})"),
	},
	import: {
		snippet: 'import "${1}" as ${2:name} %}',
	},
	from: {
		snippet: 'from "${1}" import ${2:name} %}',
	},
	with: {
		snippet: block("with", " { ${1} }"),
	},
	cache: {
		snippet: block("cache", ' "${1:key}" for ${2:600}'),
	},
	outlet: {
		snippet: 'outlet "${1:head}" %}',
	},
	add: {
		snippet: block("add", ' to "${1:head}"'),
	},
	flush: {
		snippet: "flush %}",
	},
	apply: {
		snippet: block("apply", " ${1:filter}"),
	},
	autoescape: {
		snippet: block("autoescape", ' "${1:html}"'),
	},
	verbatim: {
		snippet: "verbatim %}\n$0\n{% endverbatim %}",
	},
};

/** Tags that have a body and an end tag. */
export const BLOCK_TAGS = new Set([
	"if",
	"for",
	"set",
	"block",
	"component",
	"island",
	"fill",
	"slot",
	"macro",
	"with",
	"cache",
	"add",
	"apply",
	"autoescape",
	"verbatim",
]);

export const FILTERS: Record<string, BuiltinDoc> = {
	upper: { signature: "upper" },
	lower: { signature: "lower" },
	capitalize: {
		signature: "capitalize",
	},
	title: {
		signature: "title",
	},
	trim: {
		signature: "trim(characters?, side?)",
	},
	replace: {
		signature: "replace(search, replacement)",
	},
	split: {
		signature: "split(separator, limit?)",
	},
	truncate: {
		signature: "truncate(length, ellipsis?)",
	},
	stripTags: {
		signature: "stripTags",
	},
	nl2br: {
		signature: "nl2br",
	},
	urlEncode: {
		signature: "urlEncode",
	},
	json: {
		signature: "json(indent?)",
	},
	escape: {
		signature: "escape(strategy?)",
	},
	raw: {
		signature: "raw",
	},
	default: {
		signature: "default(fallback)",
	},
	length: {
		signature: "length",
	},
	first: {
		signature: "first",
	},
	last: {
		signature: "last",
	},
	slice: {
		signature: "slice(start, end?)",
	},
	join: {
		signature: "join(glue?, lastGlue?)",
	},
	keys: {
		signature: "keys",
	},
	merge: {
		signature: "merge(...values)",
	},
	reverse: {
		signature: "reverse",
	},
	sort: {
		signature: "sort(by?)",
	},
	map: {
		signature: "map((value, key) => ...)",
	},
	filter: {
		signature: "filter((value, key) => ...)",
	},
	reduce: {
		signature: "reduce((total, value, key) => ..., initial)",
	},
	find: {
		signature: "find((value, key) => ...)",
	},
	column: {
		signature: "column(name)",
	},
	batch: {
		signature: "batch(size, fill?)",
	},
	abs: {
		signature: "abs",
	},
	round: {
		signature: "round(precision?, method?)",
	},
	formatNumber: {
		signature: "formatNumber(...options)",
	},
	plural: {
		signature: "plural(one, other, ...forms)",
	},
	formatDate: {
		signature: "formatDate(...options)",
	},
};

export const FUNCTIONS: Record<string, BuiltinDoc> = {
	range: {
		signature: "range(start, end, step?)",
	},
	max: {
		signature: "max(...values)",
	},
	min: {
		signature: "min(...values)",
	},
	cycle: {
		signature: "cycle(values, position)",
	},
	date: {
		signature: "date(value?)",
	},
	attrs: {
		signature: "attrs(attributes)",
	},
	dump: {
		signature: "dump(...values)",
	},
	parent: {
		signature: "parent()",
	},
	block: {
		signature: "block(name)",
	},
};

export const TESTS: Record<string, BuiltinDoc> = {
	defined: {
		signature: "defined",
	},
	null: {
		signature: "null",
	},
	empty: {
		signature: "empty",
	},
	even: { signature: "even" },
	odd: { signature: "odd" },
	iterable: {
		signature: "iterable",
	},
	"divisible by": {
		signature: "divisible by(divisor)",
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
