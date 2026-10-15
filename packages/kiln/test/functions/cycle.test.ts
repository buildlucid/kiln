import { describe, expect, test } from "vite-plus/test";
import { render } from "../helpers.js";

describe("cycle", () => {
	test("picks items in turn", async () => {
		expect(
			await render(
				'{% for i in 0..3 %}{{ cycle(["odd", "even"], i) }};{% endfor %}',
			),
		).toBe("odd;even;odd;even;");
	});

	test("wraps negative positions", async () => {
		expect(await render('{{ cycle(["a", "b", "c"], -1) }}')).toBe("c");
	});

	test("is null for no items", async () => {
		expect(await render("[{{ cycle([], 1) }}]")).toBe("[]");
	});
});
