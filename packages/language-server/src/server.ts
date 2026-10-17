import { dirname, isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
	type Connection,
	DiagnosticSeverity,
	DidChangeWatchedFilesNotification,
	FileChangeType,
	type TextEdit,
	TextDocuments,
	TextDocumentSyncKind,
} from "vscode-languageserver/node";
import {
	argumentWarnings,
	complete,
	definition,
	hover,
	links,
	type OpenTemplate,
	signatureHelp,
	symbols,
} from "./features.js";
import {
	diagnose,
	findManifest,
	nameOf,
	openProject,
	type Project,
} from "./project.js";

/** Serves Kiln templates over a language server connection. */
export const startServer = (connection: Connection): void => {
	const documents = new TextDocuments(TextDocument);

	let workspaceFolders: string[] = [];
	let canWatchFiles = false;
	/** Whether the client takes `LocationLink`s from go to definition. Plain locations lose the clicked range. */
	let definitionLinks = false;
	/** Open projects, by the path of their `kiln.json`, or their folder when they have none. */
	const projects = new Map<string, Promise<Project>>();

	connection.onInitialize((params) => {
		workspaceFolders = (params.workspaceFolders ?? [])
			.map((folder) => folder.uri)
			.concat(
				params.rootUri && !params.workspaceFolders ? [params.rootUri] : [],
			)
			.filter((uri) => uri.startsWith("file:"))
			.map((uri) => fileURLToPath(uri));
		canWatchFiles =
			params.capabilities.workspace?.didChangeWatchedFiles
				?.dynamicRegistration === true;
		definitionLinks =
			params.capabilities.textDocument?.definition?.linkSupport === true;
		return {
			capabilities: {
				textDocumentSync: TextDocumentSyncKind.Incremental,
				completionProvider: {
					// `<` and `=` start HTML element and attribute value completions.
					triggerCharacters: [
						"|",
						".",
						"%",
						'"',
						"'",
						"/",
						" ",
						"{",
						",",
						"<",
						"=",
					],
				},
				hoverProvider: true,
				signatureHelpProvider: {
					triggerCharacters: ["(", ","],
					retriggerCharacters: [":", " "],
				},
				definitionProvider: true,
				documentLinkProvider: { resolveProvider: false },
				documentSymbolProvider: true,
				documentFormattingProvider: true,
				documentRangeFormattingProvider: true,
			},
			serverInfo: { name: "kiln-language-server" },
		};
	});

	connection.onInitialized(() => {
		if (!canWatchFiles) return;
		void connection.client.register(DidChangeWatchedFilesNotification.type, {
			watchers: [
				{ globPattern: "**/*.kiln" },
				{ globPattern: "**/kiln.json" },
				{ globPattern: "**/*.{ts,tsx,mts,cts}" },
				{ globPattern: "**/tsconfig*.json" },
			],
		});
	});

	/** The project a file belongs to: the nearest `kiln.json` inside its workspace folder, or the folder itself. */
	const projectFor = async (path: string): Promise<Project> => {
		const folder =
			workspaceFolders
				.filter((candidate) => {
					const name = relative(candidate, path);
					return (
						name !== ".." && !name.startsWith(".." + sep) && !isAbsolute(name)
					);
				})
				.sort((a, b) => b.length - a.length)[0] ?? null;
		const manifestPath = await findManifest(dirname(path), folder);
		const fallbackRoot = folder ?? dirname(path);
		const key = manifestPath ?? fallbackRoot;
		let project = projects.get(key);
		if (!project) {
			project = openProject(manifestPath, fallbackRoot, (message) =>
				connection.window.showWarningMessage(message),
			);
			projects.set(key, project);
		}
		return project;
	};

	const openTemplate = async (
		document: TextDocument,
	): Promise<OpenTemplate | null> => {
		if (!document.uri.startsWith("file:")) return null;
		const path = fileURLToPath(document.uri);
		const project = await projectFor(path);
		return { document, project, name: nameOf(project, path) };
	};

	const pending = new Map<string, ReturnType<typeof setTimeout>>();

	/** Checks a template shortly after its last change, and publishes its diagnostics. */
	const scheduleCheck = (document: TextDocument) => {
		clearTimeout(pending.get(document.uri));
		pending.set(
			document.uri,
			setTimeout(() => {
				pending.delete(document.uri);
				void check(document);
			}, 150),
		);
	};

	const check = async (document: TextDocument) => {
		const open = await openTemplate(document);
		if (!open?.name) return;
		const { project, name } = open;
		const version = document.version;
		const diagnostics = await diagnose(project, name, document.getText()).catch(
			() => [],
		);
		const warnings = await argumentWarnings(open).catch(() => []);
		if (documents.get(document.uri)?.version !== version) return;
		void connection.sendDiagnostics({
			uri: document.uri,
			version,
			diagnostics: diagnostics
				.map((diagnostic) => ({
					range: {
						start: document.positionAt(diagnostic.start.offset),
						end: document.positionAt(diagnostic.end.offset),
					},
					severity:
						diagnostic.severity === "error"
							? DiagnosticSeverity.Error
							: DiagnosticSeverity.Warning,
					code: diagnostic.code,
					source: "kiln",
					message: diagnostic.message,
				}))
				.concat(
					warnings.map((warning) => ({
						range: {
							start: document.positionAt(warning.start),
							end: document.positionAt(warning.end),
						},
						severity: DiagnosticSeverity.Warning,
						code: warning.code,
						source: "kiln",
						message: warning.message,
					})),
				),
		});
	};

	/** Every open template in a project sees an edit to any of them, since one template's props can break another. */
	const checkProject = async (project: Project) => {
		for (const document of documents.all()) {
			const open = await openTemplate(document);
			if (open?.project === project) scheduleCheck(document);
		}
	};

	documents.onDidChangeContent(async ({ document }) => {
		const open = await openTemplate(document);
		if (!open?.name) return;
		open.project.overlay.set(open.name, document.getText());
		open.project.kiln.invalidate(open.name);
		await checkProject(open.project);
	});

	documents.onDidClose(async ({ document }) => {
		clearTimeout(pending.get(document.uri));
		void connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
		const open = await openTemplate(document);
		if (!open?.name) return;
		open.project.overlay.delete(open.name);
		open.project.kiln.invalidate(open.name);
		await checkProject(open.project);
	});

	/** Closes every open project, so the next request opens them again from their settings. */
	const closeProjects = async () => {
		const open = [...projects.values()];
		projects.clear();
		for (const project of open) (await project).close();
	};

	connection.onShutdown(closeProjects);

	connection.onDidChangeWatchedFiles(async ({ changes }) => {
		const isSettings = (uri: string) =>
			uri.endsWith("/kiln.json") || /\/tsconfig[^/]*\.json$/.test(uri);
		const typescriptChanges = changes.flatMap((change) =>
			change.uri.startsWith("file:") && /\.[cm]?tsx?$/.test(change.uri)
				? [
						{
							path: fileURLToPath(change.uri),
							kind:
								change.type === FileChangeType.Created
									? ("created" as const)
									: change.type === FileChangeType.Deleted
										? ("deleted" as const)
										: ("changed" as const),
						},
					]
				: [],
		);
		if (typescriptChanges.length > 0) {
			for (const project of projects.values()) {
				(await project).typescriptChanged(typescriptChanges);
			}
		}
		if (changes.some((change) => isSettings(change.uri))) {
			await closeProjects();
			// Populate every new project before checking callers, so cross-template checks see all unsaved text.
			for (const document of documents.all()) {
				const open = await openTemplate(document);
				if (open?.name) {
					open.project.overlay.set(open.name, document.getText());
					open.project.kiln.invalidate(open.name);
				}
			}
		} else {
			for (const change of changes) {
				if (!change.uri.startsWith("file:") || !change.uri.endsWith(".kiln"))
					continue;
				const path = fileURLToPath(change.uri);
				const project = await projectFor(path);
				const name = nameOf(project, path);
				if (name) project.kiln.invalidate(name);
			}
		}
		for (const document of documents.all()) scheduleCheck(document);
	});

	/** Runs a handler with the open template for a request, or returns `fallback` when there is none. */
	const withTemplate =
		<P extends { textDocument: { uri: string } }, R>(
			fallback: R,
			handler: (open: OpenTemplate, params: P) => R | Promise<R>,
		) =>
		async (params: P): Promise<R> => {
			const document = documents.get(params.textDocument.uri);
			const open = document ? await openTemplate(document) : null;
			return open ? handler(open, params) : fallback;
		};

	connection.onCompletion(
		withTemplate([], (open, params) =>
			complete(open, open.document.offsetAt(params.position)),
		),
	);
	connection.onHover(
		withTemplate(null, (open, params) =>
			hover(open, open.document.offsetAt(params.position)),
		),
	);
	connection.onSignatureHelp(
		withTemplate(null, (open, params) =>
			signatureHelp(open, open.document.offsetAt(params.position)),
		),
	);
	connection.onDefinition(
		withTemplate(null, async (open, params) => {
			const link = await definition(
				open,
				open.document.offsetAt(params.position),
			);
			if (!link || definitionLinks) return link && [link];
			return { uri: link.targetUri, range: link.targetSelectionRange };
		}),
	);
	connection.onDocumentLinks(withTemplate([], (open) => links(open)));
	connection.onDocumentSymbol(
		withTemplate([], (open) => symbols(open.document)),
	);

	/** Formats a template, or part of one, as edits. Templates with syntax errors are left alone. */
	const formatTemplate = (
		open: OpenTemplate,
		options: { tabSize: number; insertSpaces: boolean },
		range?: { start: number; end: number },
	): TextEdit[] => {
		const { document, project } = open;
		try {
			return project.format
				.formatEdits(document.getText(), {
					useTabs: !options.insertSpaces,
					tabWidth: options.tabSize,
					range,
				})
				.map((edit) => ({
					range: {
						start: document.positionAt(edit.start),
						end: document.positionAt(edit.end),
					},
					newText: edit.text,
				}));
		} catch (error) {
			if (error instanceof project.format.KilnFormatError) {
				connection.window.showErrorMessage(error.message);
			}
			return [];
		}
	};

	connection.onDocumentFormatting(
		withTemplate([], (open, params) => formatTemplate(open, params.options)),
	);
	connection.onDocumentRangeFormatting(
		withTemplate([], (open, params) =>
			formatTemplate(open, params.options, {
				start: open.document.offsetAt(params.range.start),
				end: open.document.offsetAt(params.range.end),
			}),
		),
	);

	documents.listen(connection);
	connection.listen();
};
