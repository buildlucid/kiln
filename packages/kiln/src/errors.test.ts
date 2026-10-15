import { describe, expect, test } from "vite-plus/test";
import {
	createDiagnostic,
	KilnRenderError,
	KilnSyntaxError,
} from "./errors.js";
import { Source } from "./source.js";

describe("KilnRenderError", () => {
	test("without a position names only the template", () => {
		const error = new KilnRenderError(
			"missing-template",
			'Template "a.kiln" was not found',
			"a.kiln",
		);
		expect(error.message).toBe('Template "a.kiln" was not found.');
		expect(error).toMatchObject({
			template: "a.kiln",
			line: 0,
			column: 0,
			frame: "",
		});
		expect(error.detail).toBe('Template "a.kiln" was not found');
	});

	test("keeps the cause", () => {
		const cause = new Error("x");
		const error = new KilnRenderError(
			"host-error",
			"Failed",
			new Source("a.kiln", "x"),
			{ start: 0, end: 1 },
			{ cause },
		);
		expect(error.cause).toBe(cause);
	});
});

describe("KilnSyntaxError", () => {
	test("describes the first error and counts the rest", () => {
		const source = new Source("a.kiln", "{{ x }}");
		const diagnostics = [
			createDiagnostic(source, "a", "First", { start: 3, end: 4 }),
			createDiagnostic(source, "b", "Second", { start: 0, end: 1 }),
		];
		const error = new KilnSyntaxError(diagnostics, source);
		expect(error.message.split("\n")[0]).toBe(
			"First in a.kiln at line 1, column 4.",
		);
		expect(error.message).toContain("1 more problem found.");
		expect(error.diagnostics).toBe(diagnostics);
	});
});
