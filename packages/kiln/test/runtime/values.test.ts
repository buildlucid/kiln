import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

describe("printing", () => {
	test("numbers, booleans and null print plainly", async () => {
		expect(
			await render("{{ 1.5 }}|{{ true }}|{{ false }}|{{ null }}|{{ -0 }}"),
		).toBe("1.5|true|false||0");
	});

	test("dates print as ISO 8601", async () => {
		expect(
			await render("{{ when }}", {
				context: { when: new Date("2026-10-15T00:00:00Z") },
			}),
		).toBe("2026-10-15T00:00:00.000Z");
	});

	test("arrays cannot be printed", async () => {
		expect(await errorCode("{{ [1, 2] }}")).toBe("not-printable");
	});

	test("hashes cannot be printed", async () => {
		expect(await errorCode("{{ { a: 1 } }}")).toBe("not-printable");
	});

	test("promises in the context are not awaited, so they cannot be printed", async () => {
		expect(
			await errorCode("{{ p }}", { context: { p: Promise.resolve(1) } }),
		).toBe("not-printable");
	});
});

describe("host values", () => {
	test("maps, sets and dates work with filters and loops", async () => {
		const context = {
			map: new Map<string, unknown>([["a", 1]]),
			set: new Set([1, 2]),
		};
		expect(
			await render("{{ map|length }}|{{ 2 in set }}|{{ set|join(',') }}", {
				context,
			}),
		).toBe("1|true|1,2");
	});

	test("undefined values from data read as null", async () => {
		expect(
			await render("[{{ obj.value }}]", {
				context: { obj: { value: undefined } },
			}),
		).toBe("[]");
		expect(
			await render("[{{ value }}|{{ value is defined }}]", {
				context: { value: undefined },
			}),
		).toBe("[|true]");
	});
});
