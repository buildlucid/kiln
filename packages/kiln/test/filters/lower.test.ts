import { describe, expect, test } from "vite-plus/test";
import { render } from "../helpers.js";

describe("lower", () => {
	test("lower-cases a string", async () => {
		expect(await render('{{ "HeLLo"|lower }}')).toBe("hello");
	});
});
