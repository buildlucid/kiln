import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

describe("date", () => {
	test("parses ISO 8601 strings and milliseconds", async () => {
		expect(
			await render('{{ date("2026-10-15T10:00:00Z") }}|{{ date(0) }}'),
		).toBe("2026-10-15T10:00:00.000Z|1970-01-01T00:00:00.000Z");
	});

	test("reads a date-time without an offset as UTC", async () => {
		expect(await render('{{ date("2026-10-15 10:00:00") }}')).toBe(
			"2026-10-15T10:00:00.000Z",
		);
	});

	test("returns the current time without an argument", async () => {
		const before = Date.now();
		const output = await render("{{ date() }}");
		expect(Date.parse(output)).toBeGreaterThanOrEqual(before - 1000);
	});

	test("returns null for null, not the current time", async () => {
		expect(
			await render("{{ date(post.publishedAt) is null }}", {
				context: { post: { publishedAt: null } },
			}),
		).toBe("true");
	});

	test("refuses other strings", async () => {
		expect(await errorCode('{{ date("tomorrow") }}')).toBe("invalid-argument");
	});
});

describe("comparison", () => {
	test("the current time is later than a past date", async () => {
		expect(await render('{{ date() > date("2000-01-01") }}')).toBe("true");
	});
});
