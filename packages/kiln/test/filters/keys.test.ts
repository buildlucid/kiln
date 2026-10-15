import { describe, expect, test } from "vite-plus/test";
import { render } from "../helpers.js";

describe("keys", () => {
	test("returns hash keys in order", async () => {
		expect(await render('{{ { b: 1, a: 2 }|keys|join(",") }}')).toBe("b,a");
	});

	test("returns array indexes", async () => {
		expect(await render('{{ ["x", "y"]|keys|join(",") }}')).toBe("0,1");
	});
});
