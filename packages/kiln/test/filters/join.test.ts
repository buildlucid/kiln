import { describe, expect, test } from "vite-plus/test";
import { errorCode, render } from "../helpers.js";

describe("join", () => {
	test("joins items with a glue", async () => {
		expect(
			await render('{{ ["a", "b", "c"]|join(", ") }}|{{ [1, 2]|join }}'),
		).toBe("a, b, c|12");
	});

	test("can use another glue between the last two items", async () => {
		expect(
			await render(
				'{{ ["a", "b", "c"]|join(", ", " and ") }}|{{ ["a"]|join(", ", " and ") }}',
			),
		).toBe("a, b and c|a");
	});

	test("joins hash values", async () => {
		expect(await render('{{ { a: 1, b: 2 }|join(",") }}')).toBe("1,2");
	});

	test("prints null items as empty strings", async () => {
		expect(await render('{{ [1, null, 3]|join(",") }}')).toBe("1,,3");
	});
});

describe("edge cases", () => {
	test("nested arrays cannot be joined", async () => {
		expect(await errorCode("{{ [[1]]|join }}")).toBe("not-printable");
	});

	test("the last glue is used for exactly two items", async () => {
		expect(await render('{{ ["a", "b"]|join(", ", " and ") }}')).toBe(
			"a and b",
		);
	});
});

describe("limits", () => {
	test("stops before building text longer than maxOutputLength", async () => {
		expect(
			await errorCode("{{ [text, text, text]|join }}", {
				context: { text: "x".repeat(4) },
				limits: { maxOutputLength: 10 },
			}),
		).toBe("limit-output");
		expect(
			await errorCode('{{ [text, text, text]|join(",", " and ") }}', {
				context: { text: "x".repeat(4) },
				limits: { maxOutputLength: 10 },
			}),
		).toBe("limit-output");
	});
});
