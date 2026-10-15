import { describe, expect, test } from "vite-plus/test";
import { render } from "../helpers.js";

describe("column", () => {
	test("reads one property from each item", async () => {
		const posts = [{ title: "A" }, { title: "B" }];
		expect(
			await render('{{ posts|column("title")|join(",") }}', {
				context: { posts },
			}),
		).toBe("A,B");
	});

	test("gives null for items without the property", async () => {
		const posts = [{ title: "A" }, {}];
		expect(
			await render('{{ posts|column("title")|join(",") }}', {
				context: { posts },
			}),
		).toBe("A,");
	});
});

describe("safety", () => {
	test("blocked names read as null", async () => {
		expect(
			await render('{{ [{}]|column("constructor")|first ?? "blocked" }}'),
		).toBe("blocked");
	});
});
