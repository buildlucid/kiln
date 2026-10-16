import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

describe("formatDate", () => {
	test("defaults to a medium date in UTC", async () => {
		expect(await render('{{ "2026-10-15T23:30:00Z"|formatDate }}')).toBe(
			"Oct 15, 2026",
		);
	});

	test("takes Intl.DateTimeFormat options", async () => {
		expect(
			await render('{{ "2026-10-15"|formatDate(dateStyle: "long") }}'),
		).toBe("October 15, 2026");
	});

	test("can take a time zone and locale", async () => {
		const template =
			'{{ "2026-10-15T23:30:00Z"|formatDate(dateStyle: "short", timeZone: "Asia/Tokyo", locale: "en-GB") }}';
		expect(await render(template)).toBe("16/10/2026");
	});

	test("accepts milliseconds and dates", async () => {
		expect(
			await render(
				'{{ 0|formatDate(year: "numeric") }}|{{ date("2000-02-03")|formatDate(month: "long") }}',
			),
		).toBe("1970|February");
	});

	test("reads a date-time without an offset as UTC", async () => {
		expect(
			await render('{{ "2026-10-15T10:00"|formatDate(timeStyle: "short") }}'),
		).toBe("10:00 AM");
	});

	test("reads milliseconds, and days past the end of a month as JavaScript does", async () => {
		const options = 'timeStyle: "medium", dateStyle: "short", locale: "en-GB"';
		expect(
			await render(
				`{{ "2026-10-15T09:30:05.250Z"|formatDate(${options}) }}|{{ "2026-02-29"|formatDate(${options}) }}`,
			),
		).toBe("15/10/2026, 09:30:05|01/03/2026, 00:00:00");
	});

	test("refuses strings that are not ISO 8601", async () => {
		expect(await errorCode('{{ "next tuesday"|formatDate }}')).toBe(
			"invalid-argument",
		);
	});
});

describe("time zones", () => {
	test("a date-only string is midnight UTC, shown in the given zone", async () => {
		expect(
			await render(
				'{{ "2026-10-15"|formatDate(timeZone: "America/New_York") }}',
			),
		).toBe("Oct 14, 2026");
	});

	test("a string with an offset is converted to the render's time zone", async () => {
		expect(
			await render(
				'{{ "2026-10-15T23:30:00+02:00"|formatDate(timeStyle: "short") }}',
			),
		).toBe("9:30 PM");
	});

	test("numbers are milliseconds, not seconds", async () => {
		expect(await render("{{ 1700000000|formatDate }}")).toBe("Jan 20, 1970");
	});

	test("invalid options and time zones are errors", async () => {
		expect(
			await errorCode(
				'{{ "2026-10-15"|formatDate(dateStyle: "long", year: "numeric") }}',
			),
		).toBe("invalid-argument");
		expect(
			await errorCode('{{ "2026-10-15"|formatDate(timeZone: "Mars/Base") }}'),
		).toBe("invalid-argument");
	});
});

describe("null", () => {
	test("prints nothing, never the current date", async () => {
		expect(
			await render("[{{ post.publishedAt|formatDate }}]", {
				context: { post: { publishedAt: null } },
			}),
		).toBe("[]");
	});
});
