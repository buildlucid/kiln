import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { formatCommand } from "../../src/formatter/command.js";

describe("kiln format", () => {
	let dir: string;
	let out: string;
	let err: string;
	const io = {
		stdout: (text: string) => void (out += text),
		stderr: (text: string) => void (err += text),
	};

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "kiln-format-"));
		out = "";
		err = "";
		await mkdir(join(dir, "pages"));
		await mkdir(join(dir, ".hidden"));
		await writeFile(
			join(dir, "pages/messy.kiln"),
			"<div>\n<p>{{x}}</p>\n</div>\n",
		);
		await writeFile(join(dir, "pages/tidy.kiln"), "<p>a</p>\n");
		await writeFile(join(dir, ".hidden/messy.kiln"), "{{x}}");
		await writeFile(join(dir, "notes.txt"), "{{x}}");
	});
	afterEach(() => rm(dir, { recursive: true }));

	test("rewrites files that need formatting and lists them", async () => {
		expect(await formatCommand([dir], io)).toBe(0);
		expect(out).toBe(`${join(dir, "pages/messy.kiln")}\n`);
		expect(await readFile(join(dir, "pages/messy.kiln"), "utf8")).toBe(
			"<div>\n\t<p>{{ x }}</p>\n</div>\n",
		);
		expect(await readFile(join(dir, ".hidden/messy.kiln"), "utf8")).toBe(
			"{{x}}",
		);
	});

	test("--check changes nothing and exits with 1", async () => {
		expect(await formatCommand(["--check", dir], io)).toBe(1);
		expect(out).toBe(`${join(dir, "pages/messy.kiln")}\n`);
		expect(err).toContain("1 file needs formatting");
		expect(await readFile(join(dir, "pages/messy.kiln"), "utf8")).toContain(
			"{{x}}",
		);
	});

	test("--spaces indents with spaces", async () => {
		const file = join(dir, "pages/messy.kiln");
		expect(await formatCommand(["--spaces", "2", file], io)).toBe(0);
		expect(await readFile(file, "utf8")).toBe(
			"<div>\n  <p>{{ x }}</p>\n</div>\n",
		);
	});

	test("reports syntax errors with their position", async () => {
		const file = join(dir, "pages/broken.kiln");
		await writeFile(file, "<p>\n{% if %}");
		expect(await formatCommand([file], io)).toBe(1);
		expect(err).toMatch(`${file}:2:7:`);
	});

	test("exits with 2 for bad arguments", async () => {
		expect(await formatCommand([], io)).toBe(2);
		expect(await formatCommand(["--nope", dir], io)).toBe(2);
		expect(err).toContain("Usage: kiln format");
	});
});
