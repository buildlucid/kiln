import { isPlainObject } from "../runtime/values.js";
import type { Span } from "../source.js";
import { suggest } from "../suggest.js";

export const HTML_CHECKS = [
	"html-obsolete-element",
	"html-obsolete-attribute",
	"html-attribute-value",
	"html-img-alt",
	"html-button-type",
	"html-lang",
	"html-iframe-title",
	"html-viewport-zoom",
	"html-tabindex",
	"html-aria-attribute",
	"html-role",
	"html-redundant-role",
	"html-aria-hidden-focusable",
	"html-heading-order",
	"html-nested-interactive",
	"html-permitted-content",
] as const;

export type HtmlCheck = (typeof HTML_CHECKS)[number];
export type HtmlCheckLevel = "off" | "warning" | "error";
/** The `htmlChecks` option: every rule on or off, or a level for some rules. Rules left out are warnings. */
export type HtmlChecks = boolean | Partial<Record<HtmlCheck, HtmlCheckLevel>>;
export type HtmlCheckLevels = Readonly<Record<HtmlCheck, HtmlCheckLevel>>;

const LEVELS: readonly unknown[] = ["off", "warning", "error"];

const isHtmlCheck = (code: string): code is HtmlCheck =>
	(HTML_CHECKS as readonly string[]).includes(code);

const isLevel = (level: unknown): level is HtmlCheckLevel =>
	LEVELS.includes(level);

const allAt = (level: HtmlCheckLevel): Record<HtmlCheck, HtmlCheckLevel> => {
	const levels = {} as Record<HtmlCheck, HtmlCheckLevel>;
	for (const code of HTML_CHECKS) levels[code] = level;
	return levels;
};

/** Validates the `htmlChecks` option and gives every rule its level. Throws a `TypeError` for an invalid option. */
export const resolveHtmlChecks = (
	option: HtmlChecks | undefined,
): HtmlCheckLevels => {
	if (option === undefined || option === true) return allAt("warning");
	if (option === false) return allAt("off");
	if (!isPlainObject(option)) {
		throw new TypeError(
			"htmlChecks must be true, false or an object of rule levels",
		);
	}
	const levels = allAt("warning");
	for (const [code, level] of Object.entries(option)) {
		if (!isHtmlCheck(code)) {
			throw new TypeError(
				withHint(`Unknown HTML check "${code}"`, suggest(code, HTML_CHECKS)),
			);
		}
		if (!isLevel(level)) {
			throw new TypeError(
				`HTML check "${code}" must be "off", "warning" or "error"`,
			);
		}
		levels[code] = level;
	}
	return levels;
};

/** The shortest `htmlChecks` option that gives these levels, for `kiln.json`. */
export const htmlChecksOption = (levels: HtmlCheckLevels): HtmlChecks => {
	const changed: Partial<Record<HtmlCheck, HtmlCheckLevel>> = {};
	for (const code of HTML_CHECKS) {
		if (levels[code] !== "warning") changed[code] = levels[code];
	}
	const codes = Object.keys(changed);
	if (codes.length === 0) return true;
	if (
		codes.length === HTML_CHECKS.length &&
		HTML_CHECKS.every((code) => levels[code] === "off")
	) {
		return false;
	}
	return changed;
};

/** Reports a problem a rule found. Rules turned off report nothing. */
export type Report = (code: HtmlCheck, message: string, span: Span) => void;

/** Adds a "Did you mean" hint to a message, when there is one. */
export const withHint = (message: string, hint: string | undefined) =>
	hint ? `${message}. ${hint}` : message;
