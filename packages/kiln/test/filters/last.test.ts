import { describe, expect, test } from "vite-plus/test";
import { render } from "../helpers.js";

describe("last", () => {
	test("returns the last item or character", async () => {
		expect(
			await render('{{ [1, 2, 3]|last }}|{{ "abc"|last }}|{{ "a😀"|last }}'),
		).toBe("3|c|😀");
	});

	test("is null for empty values", async () => {
		expect(await render("[{{ []|last }}]")).toBe("[]");
	});
});
