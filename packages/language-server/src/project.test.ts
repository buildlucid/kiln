import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
	diagnose,
	findManifest,
	openProject,
	readManifest,
	resolveName,
} from "./project.js";

describe("resolveName", () => {
	test("resolves names as Kiln does", () => {
		expect(resolveName("layouts/base")).toBe("layouts/base.kiln");
		expect(resolveName("./card", "components/list.kiln")).toBe(
			"components/card.kiln",
		);
		expect(resolveName("../icon.svg", "components/list.kiln")).toBe("icon.svg");
		expect(resolveName("../../x", "a.kiln")).toBeNull();
		expect(resolveName("/x")).toBeNull();
	});
});

describe("projects", () => {
	let dir: string;
	const warnings: string[] = [];
	const warn = (message: string) => void warnings.push(message);

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "kiln-project-"));
		warnings.length = 0;
		await mkdir(join(dir, "templates/pages"), { recursive: true });
	});
	afterEach(() => rm(dir, { recursive: true }));

	test("finds the nearest kiln.json, stopping at the workspace folder", async () => {
		await writeFile(join(dir, "kiln.json"), "{}");
		const pages = join(dir, "templates/pages");
		expect(await findManifest(pages, dir)).toBe(join(dir, "kiln.json"));
		expect(await findManifest(pages, pages)).toBeNull();
	});

	test("fills in defaults and rejects bad fields", async () => {
		await writeFile(join(dir, "kiln.json"), '{ "filters": ["markdown"] }');
		expect(await readManifest(join(dir, "kiln.json"))).toEqual({
			root: ".",
			strict: true,
			functions: [],
			filters: ["markdown"],
			tests: [],
			globals: [],
			types: [],
			htmlChecks: true,
		});
		await writeFile(join(dir, "kiln.json"), '{ "filters": "markdown" }');
		await expect(readManifest(join(dir, "kiln.json"))).rejects.toThrow(
			'"filters" in kiln.json must be a list of names',
		);
	});

	test("checks templates against the names kiln.json lists", async () => {
		await writeFile(
			join(dir, "kiln.json"),
			'{ "root": "templates", "filters": ["markdown"] }',
		);
		const project = await openProject(join(dir, "kiln.json"), dir, warn);
		const codes = async (text: string) =>
			(await diagnose(project, "pages/home.kiln", text)).map((d) => d.code);
		expect(await codes("{{ a|markdown }}")).toEqual([]);
		expect(await codes("{{ a|nope }}")).toEqual(["unknown-filter"]);
		expect(await codes('{% include "missing" %}')).toEqual([
			"missing-template",
		]);
	});

	test("without kiln.json, reports syntax errors and HTML checks only", async () => {
		const project = await openProject(null, dir, warn);
		const codes = async (text: string) =>
			(await diagnose(project, "home.kiln", text)).map((d) => d.code);
		expect(await codes('{{ a|nope }}{% include "missing" %}')).toEqual([]);
		expect(await codes("{% if %}")).toContain("unclosed-block");
		expect(await codes("<center></center>")).toEqual(["html-obsolete-element"]);
	});

	test("uses the HTML check levels kiln.json gives", async () => {
		await writeFile(
			join(dir, "kiln.json"),
			'{ "htmlChecks": { "html-img-alt": "error", "html-button-type": "off" } }',
		);
		const project = await openProject(join(dir, "kiln.json"), dir, warn);
		const diagnostics = await diagnose(
			project,
			"home.kiln",
			"<img src=x><button>Go</button>",
		);
		expect(diagnostics.map((d) => [d.code, d.severity])).toEqual([
			["html-img-alt", "error"],
		]);
	});

	test("warns about a broken kiln.json and carries on without it", async () => {
		await writeFile(join(dir, "kiln.json"), '{ "strict": "yes" }');
		const project = await openProject(join(dir, "kiln.json"), dir, warn);
		expect(project.manifest).toBeNull();
		expect(warnings[0]).toContain(
			'"strict" in kiln.json must be true or false',
		);
	});
});
