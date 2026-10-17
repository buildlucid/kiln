import { suggest } from "../suggest.js";
import {
	ABSTRACT_ROLES,
	ARIA_ATTRIBUTES,
	ATTRIBUTE_VALUES,
	BOOLEAN_ATTRIBUTES,
	IMPLICIT_ROLES,
	INPUT_ROLES,
	OBSOLETE,
	OBSOLETE_ATTRIBUTES,
	ROLES,
} from "./data.js";
import { type Report, withHint } from "./options.js";
import type { Attribute, StartTag } from "./scanner.js";

const TABINDEX = /^[\t\n\f\r ]*([+-]?)(\d+)/;
const TOKENS = /[^\t\n\f\r ]+/g;
/** Values that suggest the author meant a boolean attribute to be off. */
const OFF = new Set(["false", "0", "no", "off"]);

/** A written-out `tabindex` as a number, or null when there is none or it isn't a number. */
export const tabindexOf = (tag: StartTag): number | null => {
	const value = tag.attributes.find((a) => a.name === "tabindex")?.value;
	const match =
		value === undefined || value === null ? null : TABINDEX.exec(value);
	return match ? Number(`${match[1]}${match[2]}`) : null;
};

/** The written-out value of an attribute, in lower case. Undefined when it's missing, null when built at render time. */
export const valueOf = (tag: StartTag, name: string) => {
	const attribute = tag.attributes.find((a) => a.name === name);
	if (!attribute) return undefined;
	return attribute.value === null ? null : attribute.value.toLowerCase();
};

const appliesTo = (on: readonly string[] | "*", tag: string) =>
	on === "*" || on.includes(tag);

/** Whether people can tab to an element, judging by what Kiln can see. Null when it can't tell. */
const focusable = (tag: StartTag): boolean | null => {
	const tabindex = tabindexOf(tag);
	if (tag.attributes.some((a) => a.name === "tabindex")) {
		return tabindex === null ? null : tabindex >= 0;
	}
	const has = (name: string) => tag.attributes.some((a) => a.name === name);
	switch (tag.name) {
		case "a":
		case "area":
			return has("href");
		case "button":
		case "select":
		case "textarea":
			return !has("disabled");
		case "input":
			return !has("disabled") && valueOf(tag, "type") !== "hidden";
		default:
			return false;
	}
};

/** The role an element always has, or null when it has none or it depends on what Kiln can't see. */
const implicitRole = (tag: StartTag): string | null => {
	if (tag.name === "a" || tag.name === "area") {
		return tag.attributes.some((a) => a.name === "href") ? "link" : null;
	}
	if (tag.name === "input") {
		const type = valueOf(tag, "type");
		return type ? (INPUT_ROLES[type] ?? null) : null;
	}
	return IMPLICIT_ROLES[tag.name] ?? null;
};

const checkValue = (tag: StartTag, attribute: Attribute, report: Report) => {
	const value = attribute.value;
	if (value === null) return;
	const custom = tag.name.includes("-");

	for (const rule of ATTRIBUTE_VALUES[attribute.name] ?? []) {
		if (!appliesTo(rule.on, tag.name) || (custom && rule.on !== "*")) continue;
		const words = rule.tokens
			? Array.from(value.matchAll(TOKENS), (m) => ({
					word: m[0],
					start: attribute.valueStart + m.index,
				}))
			: [{ word: value, start: attribute.valueStart }];
		for (const { word, start } of words) {
			const known = rule.caseSensitive
				? rule.values.includes(word)
				: rule.values.some((v) => v.toLowerCase() === word.toLowerCase());
			if (known || rule.other?.(word)) continue;
			report(
				"html-attribute-value",
				withHint(
					`${attribute.name}="${word}" isn't valid on <${tag.name}>`,
					suggest(
						word,
						rule.values.filter((v) => v !== ""),
					),
				),
				word === "" ? attribute.span : { start, end: start + word.length },
			);
		}
		break;
	}

	const boolean = BOOLEAN_ATTRIBUTES[attribute.name];
	if (
		boolean &&
		!custom &&
		appliesTo(boolean, tag.name) &&
		OFF.has(value.toLowerCase())
	) {
		report(
			"html-attribute-value",
			`${attribute.name}="${value}" still turns ${attribute.name} on, since any value does. Leave the attribute out to turn it off`,
			attribute.span,
		);
	}

	if (attribute.name === "lang" && value !== "") {
		try {
			Intl.getCanonicalLocales(value);
		} catch {
			let fix: string | undefined;
			try {
				fix = Intl.getCanonicalLocales(value.trim().replaceAll("_", "-"))[0];
			} catch {
				// No close tag to suggest.
			}
			report(
				"html-lang",
				fix
					? `"${value}" is not a valid language tag. Use "${fix}"`
					: `"${value}" is not a valid language tag, such as "en" or "en-GB"`,
				attribute.span,
			);
		}
	}
};

/** The `user-scalable` and `maximum-scale` settings in a viewport's `content`. */
const viewportSettings = (content: string) =>
	new Map(
		Array.from(
			content.matchAll(/([a-z-]+)\s*=\s*([^\s,;]+)/gi),
			(m) => [(m[1] ?? "").toLowerCase(), (m[2] ?? "").toLowerCase()] as const,
		),
	);

/** Checks one start tag with the rules that need only that tag. */
export const checkTag = (tag: StartTag, report: Report): void => {
	const has = (name: string) =>
		tag.attributes.some((attribute) => attribute.name === name);

	const obsolete = OBSOLETE.get(tag.name);
	if (obsolete) {
		report(
			"html-obsolete-element",
			`<${tag.name}> is obsolete. ${obsolete}`,
			tag.span,
		);
	}
	if (tag.complete) {
		if (tag.name === "img" && !has("alt")) {
			report(
				"html-img-alt",
				'<img> has no alt attribute. Use alt="" if the image is decorative',
				tag.span,
			);
		}
		if (tag.name === "button" && !has("type")) {
			report(
				"html-button-type",
				'<button> has no type attribute, so it submits any form it is in. Add type="button" or type="submit"',
				tag.span,
			);
		}
		if (tag.name === "html" && !has("lang")) {
			report(
				"html-lang",
				'<html> has no lang attribute. Add one, such as lang="en"',
				tag.span,
			);
		}
		if (tag.name === "iframe" && !has("title")) {
			report(
				"html-iframe-title",
				'<iframe> has no title attribute. Add one that says what it holds, such as title="Map of our office"',
				tag.span,
			);
		}
		if (valueOf(tag, "aria-hidden") === "true" && focusable(tag)) {
			report(
				"html-aria-hidden-focusable",
				`<${tag.name}> has aria-hidden="true", but people can still tab to it. Remove aria-hidden, or take the element out of the tab order`,
				tag.span,
			);
		}
	}

	const obsoleteAttributes = OBSOLETE_ATTRIBUTES[tag.name];
	for (const attribute of tag.attributes) {
		const replacement = obsoleteAttributes?.[attribute.name];
		if (replacement) {
			report(
				"html-obsolete-attribute",
				`The ${attribute.name} attribute on <${tag.name}> is obsolete. ${replacement}`,
				attribute.nameSpan,
			);
		}
		if (
			attribute.name.startsWith("aria-") &&
			!ARIA_ATTRIBUTES.has(attribute.name)
		) {
			report(
				"html-aria-attribute",
				withHint(
					`"${attribute.name}" is not an ARIA attribute`,
					suggest(attribute.name, ARIA_ATTRIBUTES),
				),
				attribute.nameSpan,
			);
		}
		if (attribute.value === null) continue;
		checkValue(tag, attribute, report);
		if (attribute.name === "tabindex") {
			const tabindex = tabindexOf(tag);
			if (tabindex !== null && tabindex > 0) {
				report(
					"html-tabindex",
					`tabindex="${attribute.value}" puts this element ahead of the rest of the page when tabbing. Use 0, or -1 to focus it only from script`,
					attribute.span,
				);
			}
		}
		if (attribute.name === "role") {
			checkRole(tag, attribute, attribute.value, report);
		}
		if (
			attribute.name === "content" &&
			tag.name === "meta" &&
			valueOf(tag, "name") === "viewport"
		) {
			const settings = viewportSettings(attribute.value);
			const scalable = settings.get("user-scalable");
			const maximum = Number.parseFloat(settings.get("maximum-scale") ?? "");
			if (scalable === "no" || scalable === "0") {
				report(
					"html-viewport-zoom",
					`user-scalable=${scalable} stops people zooming in to read. Remove it`,
					attribute.span,
				);
			} else if (maximum < 2) {
				report(
					"html-viewport-zoom",
					`maximum-scale=${settings.get("maximum-scale")} stops people zooming in to read. Remove it, or use 2 or more`,
					attribute.span,
				);
			}
		}
	}
};

const checkRole = (
	tag: StartTag,
	attribute: Attribute,
	value: string,
	report: Report,
) => {
	const roles = Array.from(value.matchAll(TOKENS));
	const implicit = implicitRole(tag);
	if (
		implicit &&
		roles.length === 1 &&
		roles[0]?.[0].toLowerCase() === implicit
	) {
		report(
			"html-redundant-role",
			`<${tag.name}> already has the ${implicit} role. Remove role="${value}"`,
			attribute.span,
		);
	}
	for (const match of roles) {
		const role = match[0].toLowerCase();
		// DPUB-ARIA and Graphics-ARIA roles.
		if (
			ROLES.has(role) ||
			role.startsWith("doc-") ||
			role.startsWith("graphics-")
		) {
			continue;
		}
		const start = attribute.valueStart + match.index;
		const span = { start, end: start + role.length };
		if (ABSTRACT_ROLES.has(role)) {
			report(
				"html-role",
				`"${role}" is an abstract ARIA role, which pages must not use`,
				span,
			);
		} else {
			report(
				"html-role",
				withHint(`"${role}" is not an ARIA role`, suggest(role, ROLES)),
				span,
			);
		}
	}
};
