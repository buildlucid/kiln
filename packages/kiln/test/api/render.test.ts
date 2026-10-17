import { describe, expect, test, vi } from "vite-plus/test";
import { createKiln } from "../../src/index.js";

describe("render caching", () => {
	test("remembers a limited number of missing templates", async () => {
		const load = vi.fn(() => null);
		const kiln = createKiln({ loader: { load } });
		await expect(kiln.render("nope")).rejects.toMatchObject({
			code: "missing-template",
		});
		await expect(kiln.render("nope")).rejects.toThrow();
		expect(load).toHaveBeenCalledTimes(1);

		// Names may come from requests, so older missing names are forgotten.
		for (let i = 0; i < 1000; i++)
			await kiln.render(`page${i}`).catch(() => {});
		await expect(kiln.render("nope")).rejects.toThrow();
		expect(load).toHaveBeenCalledTimes(1002);
	});

	test("finds a missing template once it is added and invalidated", async () => {
		const templates: Record<string, string> = {};
		const kiln = createKiln({
			loader: { load: (name) => templates[name] ?? null },
		});
		await expect(kiln.render("new")).rejects.toThrow();
		templates["new.kiln"] = "here";
		kiln.invalidate("new");
		expect(await kiln.render("new")).toBe("here");
	});

	test("loads a template again after the loader returned something unusable", async () => {
		const values: unknown[] = [42, "ok"];
		const kiln = createKiln({
			// A value from untyped code, which the types would otherwise reject.
			loader: { load: async () => values.shift() as string },
		});
		await expect(kiln.render("a")).rejects.toThrow(/number/);
		expect(await kiln.render("a")).toBe("ok");
	});

	test("accepts a thenable from the loader", async () => {
		const kiln = createKiln({
			loader: {
				load: (name) => {
					const source = name === "a.kiln" ? "{{ x }}" : null;
					// Not a promise, as a library or another realm may return.
					const thenable: PromiseLike<string | null> = {
						// oxlint-disable-next-line unicorn/no-thenable -- the thenable is what this test checks
						then: (fulfilled, rejected) =>
							Promise.resolve(source).then(fulfilled, rejected),
					};
					return thenable;
				},
			},
		});
		expect(await kiln.render("a", { x: 1 })).toBe("1");
	});
});
