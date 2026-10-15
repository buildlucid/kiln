import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vite-plus/test";
import { createKiln, memoryLoader } from "../../src/index.js";
import { fileLoader } from "../../src/node.js";

describe("memoryLoader", () => {
	test("adds the .kiln extension to keys", async () => {
		const kiln = createKiln({ loader: memoryLoader({ "pages/home": "home" }) });
		expect(await kiln.render("pages/home")).toBe("home");
		expect(await kiln.render("pages/home.kiln")).toBe("home");
	});

	test("accepts a map", async () => {
		const kiln = createKiln({ loader: memoryLoader(new Map([["a", "x"]])) });
		expect(await kiln.render("a")).toBe("x");
	});

	test("lists every template by resolved name", () => {
		expect(memoryLoader({ "pages/home": "", "a.html": "" }).list()).toEqual([
			"pages/home.kiln",
			"a.html",
		]);
	});

	test("a missing top-level template is an error without a position", async () => {
		const kiln = createKiln({ loader: memoryLoader({}) });
		await expect(kiln.render("nope")).rejects.toMatchObject({
			code: "missing-template",
			template: "nope.kiln",
			line: 0,
		});
	});
});

describe("caching", () => {
	test("the loader is called once per name until invalidate", async () => {
		const sources: Record<string, string> = { "a.kiln": "v1" };
		const load = vi.fn((name: string) => sources[name] ?? null);
		const kiln = createKiln({ loader: { load } });
		expect(await kiln.render("a")).toBe("v1");
		sources["a.kiln"] = "v2";
		expect(await kiln.render("a")).toBe("v1");
		expect(load).toHaveBeenCalledTimes(1);

		kiln.invalidate("a");
		expect(await kiln.render("a")).toBe("v2");

		sources["a.kiln"] = "v3";
		kiln.invalidate();
		expect(await kiln.render("a")).toBe("v3");
	});

	test("async loaders work, and concurrent renders share one load", async () => {
		const load = vi.fn(async (name: string) =>
			name === "a.kiln" ? "{{ x }}" : null,
		);
		const kiln = createKiln({ loader: { load } });
		expect(
			await Promise.all([
				kiln.render("a", { x: 1 }),
				kiln.render("a", { x: 2 }),
			]),
		).toEqual(["1", "2"]);
		expect(load).toHaveBeenCalledTimes(1);
	});

	test("a loader error is reported and not cached", async () => {
		let fail = true;
		const kiln = createKiln({
			loader: {
				load: async () => {
					if (fail) throw new Error("offline");
					return "ok";
				},
			},
		});
		await expect(kiln.render("a")).rejects.toThrow("offline");
		fail = false;
		expect(await kiln.render("a")).toBe("ok");
	});
});

describe("fileLoader", () => {
	test("reads templates from disk", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiln-"));
		mkdirSync(join(root, "pages"));
		writeFileSync(join(root, "pages/home.kiln"), '{% include "../part" %}');
		writeFileSync(join(root, "part.kiln"), "part");
		const kiln = createKiln({ loader: fileLoader({ root }) });
		expect(await kiln.render("pages/home")).toBe("part");
		await expect(kiln.render("missing")).rejects.toMatchObject({
			code: "missing-template",
		});
	});

	test("lists every file under the root, skipping dot files and folders", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiln-"));
		mkdirSync(join(root, "pages/blog"), { recursive: true });
		mkdirSync(join(root, ".cache"));
		writeFileSync(join(root, "pages/blog/post.kiln"), "");
		writeFileSync(join(root, "base.kiln"), "");
		writeFileSync(join(root, ".DS_Store"), "");
		writeFileSync(join(root, ".cache/old.kiln"), "");
		expect((await fileLoader({ root }).list()).sort()).toEqual([
			"base.kiln",
			"pages/blog/post.kiln",
		]);
	});
});
