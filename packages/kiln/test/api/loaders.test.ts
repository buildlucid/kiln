import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, relative, sep } from "node:path";
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

	test("templates a template uses are loaded again after invalidate", async () => {
		const sources: Record<string, string> = {
			"page.kiln":
				'{% extends "layout" %}{% block main %}{% include "part" %}{% include "parts/" ~ key %}{% endblock %}',
			"layout.kiln": "<{% block main %}{% endblock %}>",
			"part.kiln": "a1",
			"parts/b.kiln": "b1",
		};
		const kiln = createKiln({
			loader: { load: (name) => sources[name] ?? null },
		});
		expect(await kiln.render("page", { key: "b" })).toBe("<a1b1>");
		sources["part.kiln"] = "a2";
		sources["parts/b.kiln"] = "b2";
		sources["layout.kiln"] = "[{% block main %}{% endblock %}]";
		kiln.invalidate("part");
		kiln.invalidate("parts/b");
		kiln.invalidate("layout");
		expect(await kiln.render("page", { key: "b" })).toBe("[a2b2]");
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

	test("a load still pending at invalidate does not refill the cache", async () => {
		let source = "old";
		const load = vi.fn(async () => {
			const captured = source;
			await new Promise((resolve) => setTimeout(resolve, 5));
			return captured;
		});
		const kiln = createKiln({ loader: { load } });
		const first = kiln.render("t");
		source = "new";
		kiln.invalidate("t");
		expect(await first).toBe("old");
		expect(await kiln.render("t")).toBe("new");

		const second = kiln.render("t");
		source = "newer";
		kiln.invalidate();
		expect(await second).toBe("new");
		expect(await kiln.render("t")).toBe("newer");
	});

	test("a load that fails after invalidate leaves the newer load cached", async () => {
		const loads: Array<{
			resolve: (s: string) => void;
			reject: (e: Error) => void;
		}> = [];
		const load = vi.fn(
			() =>
				new Promise<string>((resolve, reject) =>
					loads.push({ resolve, reject }),
				),
		);
		const kiln = createKiln({ loader: { load } });
		const first = kiln.render("t");
		kiln.invalidate("t");
		const second = kiln.render("t");
		loads[0]?.reject(new Error("offline"));
		await expect(first).rejects.toThrow("offline");
		const third = kiln.render("t");
		for (const pending of loads.slice(1)) pending.resolve("ok");
		expect(await Promise.all([second, third])).toEqual(["ok", "ok"]);
		expect(load).toHaveBeenCalledTimes(2);
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

	test("folders, dot files and null characters are missing templates", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiln-"));
		mkdirSync(join(root, "pages.kiln"));
		mkdirSync(join(root, ".private"));
		writeFileSync(join(root, ".env"), "SECRET");
		writeFileSync(join(root, ".private/page.kiln"), "SECRET");
		writeFileSync(join(root, "file.kiln"), "");
		const loader = fileLoader({ root });
		for (const name of [
			"pages.kiln",
			".env",
			".private/page.kiln",
			"file.kiln/inner.kiln",
			"file.kiln\0",
		]) {
			expect(await loader.load(name)).toBeNull();
		}
		const kiln = createKiln({ loader });
		await expect(kiln.render(".env")).rejects.toMatchObject({
			code: "missing-template",
		});
	});

	test("a root that ends with a separator works", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiln-"));
		writeFileSync(join(root, "a.kiln"), "a");
		expect(await fileLoader({ root: root + sep }).load("a.kiln")).toBe("a");
		expect(
			await fileLoader({ root: parse(root).root }).load(
				relative(parse(root).root, join(root, "a.kiln")),
			),
		).toBe("a");
	});

	test("other read errors name the template, not the path on disk", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiln-"));
		// A link to itself fails with ELOOP, whoever runs the test.
		symlinkSync("loop.kiln", join(root, "loop.kiln"));
		await expect(fileLoader({ root }).load("loop.kiln")).rejects.toThrow(
			/^Could not read template "loop\.kiln" \(ELOOP\)$/,
		);
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
