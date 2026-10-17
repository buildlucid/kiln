import { createDiagnostic, type Diagnostic } from "../errors.js";
import type { CompiledTemplate } from "../runtime/types.js";
import type { Span } from "../source.js";
import { checkNesting } from "./nesting.js";
import {
	HTML_CHECKS,
	type HtmlCheck,
	type HtmlCheckLevels,
} from "./options.js";
import { scanTags } from "./scanner.js";
import { checkTag } from "./tags.js";

export {
	type HtmlCheck,
	type HtmlCheckLevel,
	type HtmlCheckLevels,
	type HtmlChecks,
	htmlChecksOption,
	resolveHtmlChecks,
} from "./options.js";
export { templateText } from "./scanner.js";

/** Checks the HTML written in a template against the rules `levels` turns on. Never renders. */
export const checkHtml = (
	template: CompiledTemplate,
	levels: HtmlCheckLevels,
): Diagnostic[] => {
	const diagnostics: Diagnostic[] = [];
	if (HTML_CHECKS.every((code) => levels[code] === "off")) return diagnostics;
	const report = (code: HtmlCheck, message: string, span: Span) => {
		const level = levels[code];
		if (level === "off") return;
		diagnostics.push(
			createDiagnostic(template.source, code, message, span, level),
		);
	};

	const tags = scanTags(template.source.text);
	for (const tag of tags) if (tag.type === "start") checkTag(tag, report);
	checkNesting(template, tags, report);
	return diagnostics;
};
