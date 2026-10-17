import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
	createConnection,
	createMessageConnection,
	type MessageConnection,
	type PublishDiagnosticsParams,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-languageserver/node";
import { startServer } from "./server.js";

describe("language server", () => {
	let dir: string;
	let client: MessageConnection;
	const diagnostics = new Map<string, PublishDiagnosticsParams>();
	const uri = (path: string) => pathToFileURL(join(dir, path)).href;

	/** Opens a template and waits for its first diagnostics. */
	const open = async (path: string, text: string) => {
		const published = new Promise<void>((resolve) => {
			const check = setInterval(() => {
				if (diagnostics.has(uri(path))) {
					clearInterval(check);
					resolve();
				}
			}, 5);
		});
		await client.sendNotification("textDocument/didOpen", {
			textDocument: { uri: uri(path), languageId: "kiln", version: 1, text },
		});
		await published;
	};
	const request = <T>(
		method: string,
		path: string,
		line: number,
		character: number,
	) =>
		client.sendRequest<T>(method, {
			textDocument: { uri: uri(path) },
			position: { line, character },
		});

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "kiln-server-"));
		await mkdir(join(dir, "templates/components"), { recursive: true });
		await mkdir(join(dir, "templates/layouts"));
		await mkdir(join(dir, "templates/pages"));
		await writeFile(
			join(dir, "kiln.json"),
			'{ "root": "templates", "functions": ["documents"], "globals": ["site"] }',
		);
		await writeFile(
			join(dir, "templates/components/card.kiln"),
			'{% props title: string, url = null %}<a href="{{ url }}">{{ title }}</a>',
		);
		await writeFile(
			join(dir, "templates/layouts/base.kiln"),
			"<html>\n{% block content %}{% endblock %}\n</html>\n",
		);

		const up = new PassThrough();
		const down = new PassThrough();
		startServer(
			createConnection(
				new StreamMessageReader(up),
				new StreamMessageWriter(down),
			),
		);
		client = createMessageConnection(
			new StreamMessageReader(down),
			new StreamMessageWriter(up),
		);
		client.onNotification(
			"textDocument/publishDiagnostics",
			(params: PublishDiagnosticsParams) => {
				diagnostics.set(params.uri, params);
			},
		);
		client.listen();
		await client.sendRequest("initialize", {
			processId: null,
			rootUri: null,
			capabilities: {},
			workspaceFolders: [{ uri: pathToFileURL(dir).href, name: "site" }],
		});
		await client.sendNotification("initialized", {});
	});
	afterAll(async () => {
		client.dispose();
		await rm(dir, { recursive: true });
	});

	test("publishes problems from check, including props a component doesn't declare", async () => {
		await open(
			"templates/pages/broken.kiln",
			'{{ a|nope }}\n{% component "components/card" with { titel: "x" } %}{% endcomponent %}',
		);
		const published = diagnostics.get(uri("templates/pages/broken.kiln"));
		expect(
			published?.diagnostics.map((d) => [d.code, d.range.start.line]),
		).toEqual([
			["unknown-filter", 0],
			["missing-prop", 1],
			["unknown-prop", 1],
		]);
	});

	test("formats a template as edits", async () => {
		await open("templates/pages/messy.kiln", "<div>\n<p>{{x}}</p>\n</div>\n");
		const edits = await client.sendRequest("textDocument/formatting", {
			textDocument: { uri: uri("templates/pages/messy.kiln") },
			options: { tabSize: 2, insertSpaces: true },
		});
		expect(edits).toEqual([
			{
				range: {
					start: { line: 1, character: 0 },
					end: { line: 1, character: 0 },
				},
				newText: "  ",
			},
			{
				range: {
					start: { line: 1, character: 3 },
					end: { line: 1, character: 8 },
				},
				newText: "{{ x }}",
			},
		]);
	});

	test("completes template names, props, variables and functions", async () => {
		const page =
			'Sample\n{% extends "layouts/b" %}\n{% component "components/card" with { t } %}{% endcomponent %}\n{{ s }}';
		await open("templates/pages/complete.kiln", page);
		type Items = { label: string; detail?: string }[];
		const labels = (items: Items) => items.map((item) => item.label);
		expect(
			labels(
				await request<Items>(
					"textDocument/completion",
					"templates/pages/complete.kiln",
					1,
					20,
				),
			),
		).toEqual(["components/card", "layouts/base"]);
		const props = await request<Items>(
			"textDocument/completion",
			"templates/pages/complete.kiln",
			2,
			39,
		);
		expect(props).toEqual([
			expect.objectContaining({ label: "title", detail: "title: string" }),
			expect.objectContaining({ label: "url", detail: "url?: any" }),
		]);
		const names = labels(
			await request<Items>(
				"textDocument/completion",
				"templates/pages/complete.kiln",
				3,
				4,
			),
		);
		expect(names).toEqual(
			expect.arrayContaining(["site", "documents", "range", "true"]),
		);
	});

	test("hovers filters and templates", async () => {
		await open(
			"templates/pages/hover.kiln",
			'{{ a|upper }}{% include "components/card" %}',
		);
		const filter = await request<{ contents: { value: string } }>(
			"textDocument/hover",
			"templates/pages/hover.kiln",
			0,
			7,
		);
		expect(filter.contents.value).toContain("Changes text to upper case.");
		const template = await request<{ contents: { value: string } }>(
			"textDocument/hover",
			"templates/pages/hover.kiln",
			0,
			30,
		);
		expect(template.contents.value).toContain("props title: string, url?: any");
	});

	test("completes and hovers HTML outside Kiln syntax", async () => {
		await open(
			"templates/pages/html.kiln",
			'<a href="{{ url }}" ></a>\n<button type="">\n{{ "<b" }}',
		);
		type Items = { label: string }[];
		const labels = async (line: number, character: number) =>
			(
				await request<Items>(
					"textDocument/completion",
					"templates/pages/html.kiln",
					line,
					character,
				)
			).map((item) => item.label);
		// An attribute after an output, then an attribute's values.
		expect(await labels(0, 20)).toEqual(
			expect.arrayContaining(["target", "rel", "download"]),
		);
		expect(await labels(1, 14)).toEqual(["button", "submit", "reset"]);
		// Inside an output, Kiln's own completions win.
		expect(await labels(2, 6)).not.toContain("button");
		const hover = await request<{ contents: { value: string } }>(
			"textDocument/hover",
			"templates/pages/html.kiln",
			1,
			3,
		);
		expect(hover.contents.value).toContain("button");
		expect(hover.contents.value).toContain("MDN Reference");
	});

	test("goes to templates and to the layout's block", async () => {
		await open(
			"templates/pages/nav.kiln",
			'{% extends "layouts/base" %}\n{% block content %}{% endblock %}',
		);
		const template = await request<{ uri: string }>(
			"textDocument/definition",
			"templates/pages/nav.kiln",
			0,
			14,
		);
		expect(template.uri).toBe(uri("templates/layouts/base.kiln"));
		const block = await request<{
			uri: string;
			range: { start: { line: number } };
		}>("textDocument/definition", "templates/pages/nav.kiln", 1, 12);
		expect(block).toMatchObject({
			uri: uri("templates/layouts/base.kiln"),
			range: { start: { line: 1 } },
		});
	});

	test("links template names and lists blocks as symbols", async () => {
		const links = await client.sendRequest<{ target: string }[]>(
			"textDocument/documentLink",
			{
				textDocument: { uri: uri("templates/pages/nav.kiln") },
			},
		);
		expect(links.map((link) => link.target)).toEqual([
			uri("templates/layouts/base.kiln"),
		]);
		const symbols = await client.sendRequest<{ name: string }[]>(
			"textDocument/documentSymbol",
			{
				textDocument: { uri: uri("templates/pages/nav.kiln") },
			},
		);
		expect(symbols.map((symbol) => symbol.name)).toEqual(["content"]);
	});
});
