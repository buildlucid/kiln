import { describe, expect, test } from "vite-plus/test";
import { render } from "../helpers.js";

describe("filter", () => {
	test("keeps array items the arrow accepts", async () => {
		expect(
			await render('{{ [1, 2, 3]|filter(n => n is odd)|join(",") }}'),
		).toBe("1,3");
	});

	test("receives keys and keeps them for hashes", async () => {
		expect(
			await render('{{ { a: 1, b: 2 }|filter((v, k) => k == "b")|keys|join }}'),
		).toBe("b");
	});

	test("uses Kiln truthiness", async () => {
		expect(
			await render('{{ [0, "", "0", [], [1]]|filter(v => v)|length }}'),
		).toBe("2");
	});
});
