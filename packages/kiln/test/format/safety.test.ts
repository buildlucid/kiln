import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { format } from "../../src/format.js";
import { KilnSyntaxError } from "../../src/index.js";

describe("format: safety", () => {
	test("throws KilnSyntaxError for a template with syntax errors", () => {
		expect(() => format("{% if %}")).toThrow(KilnSyntaxError);
		expect(() => format("{{ a|nope( }}")).toThrow(KilnSyntaxError);
	});

	// The documentation site's own templates make a good corpus of real Kiln.
	const root = join(import.meta.dirname, "../../../../apps/documentation/src");
	const templates = readdirSync(root, { recursive: true })
		.map(String)
		.filter((file) => file.endsWith(".kiln"));

	test.each(templates)(
		"formats %s, and formatting again changes nothing",
		(file) => {
			const once = format(readFileSync(join(root, file), "utf8"));
			expect(format(once)).toBe(once);
		},
	);
});
