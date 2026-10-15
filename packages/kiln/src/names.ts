import { issue } from "./errors.js";

export const TEMPLATE_EXTENSION = ".kiln";

/**
 * Resolves a template name to a normalised path with an extension.
 *
 * Names starting with `./` or `../` are relative to the directory of `from`. Other names are relative to the loader's root.
 */
export const resolveTemplateName = (name: string, from?: string): string => {
	if (name === "")
		return issue("invalid-template-name", "Template name is empty");
	if (name.startsWith("/")) {
		return issue(
			"invalid-template-name",
			`Template name "${name}" must not start with "/"`,
		);
	}
	if (name.includes("\\")) {
		return issue(
			"invalid-template-name",
			`Template name "${name}" must use "/" as its separator`,
		);
	}

	const relative = name.startsWith("./") || name.startsWith("../");
	const segments: string[] = [];
	if (relative && from) {
		segments.push(...from.split("/").slice(0, -1));
	}

	for (const segment of name.split("/")) {
		if (segment === "" || segment === ".") {
			if (segment === "" && !relative) {
				return issue(
					"invalid-template-name",
					`Template name "${name}" has an empty path segment`,
				);
			}
			continue;
		}
		if (segment === "..") {
			if (segments.length === 0) {
				return issue(
					"invalid-template-name",
					`Template name "${name}" points outside the template root`,
				);
			}
			segments.pop();
			continue;
		}
		segments.push(segment);
	}

	const last = segments[segments.length - 1];
	if (last === undefined) {
		return issue("invalid-template-name", `Template name "${name}" is empty`);
	}
	if (!last.includes(".")) {
		segments[segments.length - 1] = `${last}${TEMPLATE_EXTENSION}`;
	}
	return segments.join("/");
};
