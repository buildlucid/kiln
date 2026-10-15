import { describe, expect, test } from "vite-plus/test";
import { render } from "../helpers.js";

const users = [
	{ name: "a", admin: false },
	{ name: "b", admin: true },
];

describe("find", () => {
	test("returns the first matching item", async () => {
		expect(
			await render("{{ users|find(u => u.admin).name }}", {
				context: { users },
			}),
		).toBe("b");
	});

	test("returns null when nothing matches", async () => {
		expect(
			await render('{{ users|find(u => u.name == "x") ?? "none" }}', {
				context: { users },
			}),
		).toBe("none");
	});
});

describe("hashes", () => {
	test("finds a value in a hash", async () => {
		expect(await render("{{ {a: 1, b: 5}|find(v => v > 3) }}")).toBe("5");
	});
});
