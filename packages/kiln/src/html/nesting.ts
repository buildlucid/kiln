import type { Statement } from "../parser/ast.js";
import type { CompiledTemplate } from "../runtime/types.js";
import {
	BUTTON_SCOPE,
	FIRST_CHILD,
	FLOW,
	FOREIGN,
	HEADINGS,
	MAIN_PARENTS,
	METADATA,
	ONLY_CHILDREN,
	PHRASING_ONLY,
	RAW_TEXT,
	REQUIRED_PARENTS,
	SPECIAL,
	TRANSPARENT,
	VOID,
} from "./data.js";
import type { Report } from "./options.js";
import type { StartTag, Tag } from "./scanner.js";
import { valueOf } from "./tags.js";

/**
 * An open element. An empty name marks where Kiln doesn't know what is open: the bottom of the list, since a
 * template's content could end up anywhere, and wherever `if` branches left different elements open.
 */
type Entry = { name: string; children: number };

/**
 * What is known at one point in a template: the open elements, innermost last, and the last heading's level.
 * `endedParagraph` is the block that last ended an open `<p>`, such as the `<div>` in `<p>Text<div>`. That is valid
 * HTML, unless a `</p>` follows, which shows the paragraph was meant to hold the block.
 */
type State = {
	open: Entry[];
	heading: number | null;
	endedParagraph: StartTag | null;
};

const UNKNOWN = "";

/** Elements that stop the parser looking for an open `<a>` to end. */
const FORMATTING_MARKERS = new Set([
	"applet",
	"caption",
	"marquee",
	"object",
	"td",
	"template",
	"th",
]);

const fresh = (): State => ({
	open: [{ name: UNKNOWN, children: 0 }],
	heading: null,
	endedParagraph: null,
});

const copy = (state: State): State => ({
	open: state.open.map((entry) => ({ ...entry })),
	heading: state.heading,
	endedParagraph: state.endedParagraph,
});

const levelOf = (name: string) =>
	HEADINGS.has(name) ? Number(name.slice(1)) : null;

/** Lists names as `<a>`, `<a> and <b>`, or `<a>, <b> and <c>`. */
const listOf = (names: readonly string[], joiner: "and" | "or") => {
	const tags = names.map((name) => `<${name}>`);
	return tags.length < 2
		? tags.join("")
		: `${tags.slice(0, -1).join(", ")} ${joiner} ${tags.at(-1)}`;
};

/** Whether an element is interactive content, which `<a>` and `<button>` can't hold. Null when Kiln can't tell. */
const interactive = (tag: StartTag): boolean | null => {
	const has = (name: string) => tag.attributes.some((a) => a.name === name);
	if (has("tabindex")) return true;
	switch (tag.name) {
		case "a":
			return has("href") || (tag.complete ? false : null);
		case "button":
		case "details":
		case "embed":
		case "iframe":
		case "label":
		case "select":
		case "textarea":
			return true;
		case "input": {
			const type = valueOf(tag, "type");
			if (type === undefined) return tag.complete ? true : null;
			return type === null ? null : type !== "hidden";
		}
		case "audio":
		case "video":
			return has("controls") || (tag.complete ? false : null);
		case "img":
			return has("usemap") || (tag.complete ? false : null);
		default:
			return false;
	}
};

/**
 * Checks how a template's elements nest, and the order of its headings. It follows the template's tags, branches and
 * loops, and the HTML parser's rules for end tags that can be left out, but never what other templates render.
 */
export const checkNesting = (
	template: CompiledTemplate,
	tags: readonly Tag[],
	report: Report,
): void => {
	const layoutChild = template.ast.body.some((node) => node.type === "Extends");

	const startOf = (tag: Tag) =>
		tag.type === "start" ? tag.span.start : tag.start;
	/** The index of the first tag at or after `offset`. */
	const firstTag = (offset: number) => {
		let low = 0;
		let high = tags.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			if (startOf(tags[middle] as Tag) < offset) low = middle + 1;
			else high = middle;
		}
		return low;
	};
	/** Whether `offset` is inside a tag, such as an output in `class="{{ x }}"`, rather than between elements. */
	const insideTag = (offset: number) => {
		const before = tags[firstTag(offset) - 1];
		return before !== undefined && offset < before.end;
	};

	/** Combines the states that branches end in. What they disagree on becomes unknown. */
	const merge = (state: State, ends: State[]) => {
		const [first, ...rest] = ends as [State, ...State[]];
		let shared = first.open.length;
		for (const end of rest) {
			let same = 0;
			while (
				same < Math.min(shared, end.open.length) &&
				end.open[same]?.name === first.open[same]?.name
			) {
				same++;
			}
			shared = same;
		}
		const agree =
			ends.every((end) => end.open.length === shared) &&
			first.open.length === shared;
		state.open = first.open.slice(0, shared);
		if (!agree) state.open.push({ name: UNKNOWN, children: 0 });
		state.heading = ends.every((end) => end.heading === first.heading)
			? first.heading
			: null;
		state.endedParagraph = ends.every(
			(end) => end.endedParagraph === first.endedParagraph,
		)
			? first.endedParagraph
			: null;
	};

	/** Content Kiln can't see, such as an include or an output. It may hold headings unless its parent can't. */
	const hole = (state: State, mayHoldHeadings: boolean) => {
		const top = state.open.at(-1) as Entry;
		top.children++;
		if (mayHoldHeadings) state.heading = null;
	};

	/** The nearest open element that decides what may go here: transparent elements such as `<a>` pass it to their parent. */
	const container = (state: State) => {
		for (let i = state.open.length - 1; i >= 0; i--) {
			const entry = state.open[i] as Entry;
			if (!TRANSPARENT.has(entry.name)) return entry;
		}
		return state.open[0] as Entry;
	};

	const popThrough = (state: State, index: number) => {
		state.open.length = index;
	};

	/** The index of the innermost open element matching `names`, looking no further than an element in `stop`. */
	const findOpen = (
		state: State,
		names: ReadonlySet<string> | readonly string[],
		stop: (name: string) => boolean,
	) => {
		const has = (name: string) =>
			"has" in names ? names.has(name) : names.includes(name);
		for (let i = state.open.length - 1; i > 0; i--) {
			const name = (state.open[i] as Entry).name;
			if (has(name)) return i;
			if (name === UNKNOWN || stop(name)) return -1;
		}
		return -1;
	};

	/** Ends open elements the way the HTML parser does when `name` starts, for end tags that can be left out. */
	const impliedEnds = (state: State, name: string) => {
		const close = (names: readonly string[], stop: readonly string[]) => {
			const index = findOpen(state, names, (open) => stop.includes(open));
			if (index > 0) popThrough(state, index);
		};
		const tableStops = ["table", "template", "html"];
		if (state.open.at(-1)?.name === "head" && !METADATA.has(name)) {
			state.open.pop();
		}
		if (name === "li") {
			const index = findOpen(state, ["li"], (open) => SPECIAL.has(open));
			if (index > 0) popThrough(state, index);
		} else if (name === "dd" || name === "dt") {
			const index = findOpen(state, ["dd", "dt"], (open) => SPECIAL.has(open));
			if (index > 0) popThrough(state, index);
		} else if (name === "td" || name === "th") {
			close(["td", "th"], ["tr", ...tableStops]);
		} else if (name === "tr") {
			close(["td", "th"], ["tr", ...tableStops]);
			close(["tr"], ["thead", "tbody", "tfoot", ...tableStops]);
		} else if (
			["thead", "tbody", "tfoot", "caption", "colgroup"].includes(name)
		) {
			close(["td", "th"], ["tr", ...tableStops]);
			close(["tr"], ["thead", "tbody", "tfoot", ...tableStops]);
			close(["thead", "tbody", "tfoot"], tableStops);
		} else if (name === "option" || name === "optgroup") {
			if (state.open.at(-1)?.name === "option") state.open.pop();
			if (name === "optgroup" && state.open.at(-1)?.name === "optgroup") {
				state.open.pop();
			}
		} else if (name === "rt" || name === "rp") {
			const top = state.open.at(-1)?.name;
			if (top === "rt" || top === "rp") state.open.pop();
		}
	};

	/** Open ancestors that Kiln knows of, innermost first, up to the nearest `<template>`. */
	const ancestors = function* (state: State) {
		for (let i = state.open.length - 1; i > 0; i--) {
			const name = (state.open[i] as Entry).name;
			if (name === "template") return;
			if (name !== UNKNOWN) yield name;
		}
	};

	const start = (tag: StartTag, state: State) => {
		const { name, span } = tag;
		impliedEnds(state, name);

		// The parser ends an open link or button before another, and ignores a form inside a form.
		if (name === "a" || name === "button") {
			const index = findOpen(state, [name], (open) =>
				name === "a" ? FORMATTING_MARKERS.has(open) : BUTTON_SCOPE.has(open),
			);
			if (index > 0) {
				report(
					"html-nested-interactive",
					`<${name}> can't be inside another <${name}>, so the browser ends the first one here`,
					span,
				);
				popThrough(state, index);
			}
		}
		if (name === "form" && [...ancestors(state)].includes("form")) {
			report(
				"html-permitted-content",
				"<form> can't be inside another <form>, so the browser ignores it",
				span,
			);
			return;
		}
		if (FLOW.has(name)) {
			const index = findOpen(state, ["p"], (open) => BUTTON_SCOPE.has(open));
			if (index > 0) {
				popThrough(state, index);
				state.endedParagraph = name === "p" ? null : tag;
			}
		}
		if (name === "p") state.endedParagraph = null;

		const parent = state.open.at(-1) as Entry;
		const holder = container(state);
		const headingAllowed =
			HEADINGS.has(name) &&
			(holder.name === "summary" || holder.name === "legend");
		if (FLOW.has(name) && PHRASING_ONLY.has(holder.name) && !headingAllowed) {
			report(
				"html-permitted-content",
				`<${name}> can't be inside <${holder.name}>, which only holds text and inline elements`,
				span,
			);
		} else if (ONLY_CHILDREN[parent.name]?.includes(name) === false) {
			report(
				"html-permitted-content",
				`<${name}> can't be inside <${parent.name}>, which only holds ${listOf(ONLY_CHILDREN[parent.name] ?? [], "and")}`,
				span,
			);
		} else if (
			parent.name !== UNKNOWN &&
			parent.name !== "template" &&
			REQUIRED_PARENTS[name]?.includes(parent.name) === false
		) {
			report(
				"html-permitted-content",
				`<${name}> must be inside ${listOf(REQUIRED_PARENTS[name] ?? [], "or")}`,
				span,
			);
		} else if (FIRST_CHILD[name] === parent.name && parent.children > 0) {
			report(
				"html-permitted-content",
				`<${name}> must be the first child of <${parent.name}>`,
				span,
			);
		}
		// A heading inside a heading: the parser ends the outer one.
		if (HEADINGS.has(name) && HEADINGS.has(parent.name)) state.open.pop();

		const above = [...ancestors(state)];
		const isInteractive = interactive(tag);
		const holderOfInteractive = above.find(
			(open) => open === "a" || open === "button",
		);
		if (isInteractive && holderOfInteractive) {
			report(
				"html-nested-interactive",
				`<${name}> can't be inside <${holderOfInteractive}>, since interactive elements can't hold each other`,
				span,
			);
		} else if (name === "label" && above.includes("label")) {
			report(
				"html-nested-interactive",
				"<label> can't be inside another <label>",
				span,
			);
		}
		if (name === "header" || name === "footer") {
			const outer = above.find(
				(open) => open === "header" || open === "footer",
			);
			if (outer) {
				report(
					"html-permitted-content",
					`<${name}> can't be inside <${outer}>`,
					span,
				);
			}
		}
		if (name === "main") {
			const wrong = above.find(
				(open) => !MAIN_PARENTS.has(open) && !open.includes("-"),
			);
			if (wrong) {
				report(
					"html-permitted-content",
					`<main> can't be inside <${wrong}>. It belongs in <body>, a <div> or a <form>`,
					span,
				);
			}
		}

		const level = levelOf(name);
		if (level !== null) {
			if (state.heading !== null && level > state.heading + 1) {
				report(
					"html-heading-order",
					`<${name}> skips a level after <h${state.heading}>. Use <h${state.heading + 1}>`,
					span,
				);
			}
			state.heading = level;
		}

		(state.open.at(-1) as Entry).children++;
		const leaf = VOID.has(name) || RAW_TEXT.has(name) || FOREIGN.has(name);
		if (!leaf) state.open.push({ name, children: 0 });
	};

	const end = (name: string, state: State) => {
		if (name === "p") {
			const index = findOpen(state, ["p"], (open) => BUTTON_SCOPE.has(open));
			if (index > 0) popThrough(state, index);
			else if (state.endedParagraph) {
				report(
					"html-permitted-content",
					`<${state.endedParagraph.name}> can't be inside <p>, so the browser ends the paragraph before it`,
					state.endedParagraph.span,
				);
				state.endedParagraph = null;
			}
			return;
		}
		// Any heading's end tag ends the open heading, whatever its level.
		const names = HEADINGS.has(name) ? HEADINGS : [name];
		for (let i = state.open.length - 1; i > 0; i--) {
			const open = (state.open[i] as Entry).name;
			if ("has" in names ? names.has(open) : names.includes(open)) {
				popThrough(state, i);
				return;
			}
		}
	};

	/** Walks a body that renders somewhere else, such as a macro, so its parent is unknown. */
	const elsewhere = (body: Statement[]) => walk(body, fresh());

	/** Walks a body that renders in place, or may be replaced, such as a layout's block. */
	const replaceable = (body: Statement[], state: State) => {
		const before = copy(state);
		const after = copy(state);
		walk(body, after);
		merge(state, [before, after]);
		hole(state, true);
	};

	const walk = (list: Statement[], state: State): void => {
		for (const node of list) {
			if (node.type !== "Text" && insideTag(node.span.start)) continue;
			switch (node.type) {
				case "Text":
					for (
						let i = firstTag(node.span.start);
						i < tags.length && startOf(tags[i] as Tag) < node.span.end;
						i++
					) {
						const tag = tags[i] as Tag;
						if (tag.type === "start") start(tag, state);
						else end(tag.name, state);
					}
					break;
				case "Output": {
					// Phrasing elements and `<p>` can't hold headings, so an output inside one can't add any.
					const holder = container(state).name;
					hole(state, !PHRASING_ONLY.has(holder) && holder !== "p");
					break;
				}
				case "Include":
					hole(state, true);
					break;
				case "Component":
					elsewhere(node.body);
					for (const fill of node.fills) elsewhere(fill.body);
					hole(state, true);
					break;
				case "Island":
					elsewhere(node.body);
					hole(state, true);
					break;
				case "If":
				case "For": {
					const bodies =
						node.type === "If"
							? [
									...node.branches.map((branch) => branch.body),
									node.alternate ?? [],
								]
							: [node.body, node.alternate ?? []];
					const ends = bodies.map((body) => {
						const branch = copy(state);
						walk(body, branch);
						return branch;
					});
					merge(state, ends);
					break;
				}
				case "Block":
					if (layoutChild) elsewhere(node.body);
					else replaceable(node.body, state);
					break;
				case "Slot":
					replaceable(node.body, state);
					break;
				case "With":
				case "Cache":
				case "Autoescape":
					walk(node.body, state);
					break;
				case "Macro":
				case "SetBlock":
				case "Add":
				case "Apply":
					elsewhere(node.body);
					break;
				default:
					break;
			}
		}
	};

	walk(template.ast.body, fresh());
};
