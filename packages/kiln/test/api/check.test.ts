import { describe, expect, test } from "vite-plus/test";
import { createKiln, memoryLoader } from "../../src/index.js";

describe("check", () => {
	const kiln = createKiln({ loader: memoryLoader({ saved: "{{ fine }}" }) });

	test("reports every problem in unsaved source, in source order", async () => {
		const diagnostics = await kiln.check("draft", "{{ a|nope }}\n{% if %}");
		expect(diagnostics.map((d) => d.code)).toEqual([
			"unknown-filter",
			"unclosed-block",
			"unexpected-token",
		]);
		expect(diagnostics[2]).toMatchObject({
			template: "draft.kiln",
			severity: "error",
			start: { line: 2, column: 7 },
		});
	});

	test("returns nothing for a valid template", async () => {
		expect(await kiln.check("saved")).toEqual([]);
		expect(await kiln.check("draft", "{{ fine }}")).toEqual([]);
	});

	test("reports a missing template", async () => {
		expect((await kiln.check("missing")).map((d) => d.code)).toEqual([
			"missing-template",
		]);
	});

	test("does not render, so unknown variables are not reported", async () => {
		expect(await kiln.check("draft", "{{ anything.at.all }}")).toEqual([]);
	});

	test("reports deep nesting instead of crashing", async () => {
		const deep = `{{ ${"(".repeat(1000)}1${")".repeat(1000)} }}`;
		expect((await kiln.check("a", deep)).map((d) => d.code)).toContain(
			"too-deep",
		);
		const nestedIfs = "{% if true %}".repeat(3000) + "{% endif %}".repeat(3000);
		expect((await kiln.check("b", nestedIfs)).map((d) => d.code)).toContain(
			"too-deep",
		);
	});
});
