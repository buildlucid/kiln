import { dirname } from "node:path";
import type * as TS from "typescript-6";
import {
	type Member,
	samePath,
	type TypeScriptProject,
	virtualPath,
} from "./typescript.js";

/** A project checked by TypeScript 6's classic API, in this process. */
export const openTypeScript6 = (
	ts: typeof TS,
	configPath: string,
): TypeScriptProject => {
	const parseConfig = () => {
		const parsed = ts.getParsedCommandLineOfConfigFile(
			configPath,
			{},
			{ ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
		);
		if (!parsed) throw new Error(`can't read ${configPath}`);
		return parsed;
	};
	let config = parseConfig();
	const virtual = virtualPath(configPath, config.fileNames);
	let text = "";
	/** Bumped when a file changes, so the language service reads it again. */
	const versions = new Map<string, number>();
	const version = (path: string) => versions.get(path) ?? 0;
	let fileNames = [...config.fileNames, virtual];

	const read = (path: string) =>
		samePath(path, virtual) ? text : ts.sys.readFile(path);
	const service = ts.createLanguageService(
		{
			getCompilationSettings: () => config.options,
			getScriptFileNames: () => fileNames,
			getScriptVersion: (path) => String(version(path)),
			getScriptSnapshot: (path) => {
				const content = read(path);
				return content === undefined
					? undefined
					: ts.ScriptSnapshot.fromString(content);
			},
			getCurrentDirectory: () => dirname(configPath),
			getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
			fileExists: (path) => samePath(path, virtual) || ts.sys.fileExists(path),
			readFile: read,
			readDirectory: (...args) => ts.sys.readDirectory(...args),
			directoryExists: (path) => ts.sys.directoryExists(path),
			getDirectories: (path) => ts.sys.getDirectories(path),
		},
		ts.createDocumentRegistry(),
	);

	return {
		query(source, use) {
			if (source !== text) {
				text = source;
				versions.set(virtual, version(virtual) + 1);
			}
			const program = service.getProgram();
			const file = program?.getSourceFile(virtual);
			if (!program || !file) return null;
			const checker = program.getTypeChecker();
			const typeOf = (alias: string) => {
				const declaration = file.statements.find(
					(statement): statement is TS.TypeAliasDeclaration =>
						ts.isTypeAliasDeclaration(statement) &&
						statement.name.text === alias,
				);
				return declaration
					? checker.getTypeAtLocation(declaration.name)
					: undefined;
			};
			return use({
				describe: (alias) => {
					const type = typeOf(alias);
					return type
						? checker.typeToString(
								type,
								undefined,
								ts.TypeFormatFlags.NoTruncation,
							)
						: null;
				},
				members: (alias) => {
					const type = typeOf(alias);
					if (!type) return [];
					return checker.getPropertiesOfType(type).map((symbol): Member => {
						const node = symbol.declarations?.[0];
						const declaredIn = node?.getSourceFile();
						return {
							name: symbol.name,
							optional: (symbol.flags & ts.SymbolFlags.Optional) !== 0,
							type: checker.typeToString(
								checker.getTypeOfSymbolAtLocation(symbol, file),
								undefined,
								ts.TypeFormatFlags.NoTruncation,
							),
							docs: ts.displayPartsToString(
								symbol.getDocumentationComment(checker),
							),
							tags: symbol.getJsDocTags(checker).map((tag) => ({
								name: tag.name,
								text: ts.displayPartsToString(tag.text),
							})),
							location:
								node && declaredIn
									? {
											path: declaredIn.fileName,
											...declaredIn.getLineAndCharacterOfPosition(
												node.getStart(declaredIn),
											),
										}
									: null,
						};
					});
				},
			});
		},
		changed(changes) {
			for (const change of changes) {
				versions.set(change.path, version(change.path) + 1);
			}
			// A new or deleted file can change which files the config includes.
			if (changes.some((change) => change.kind !== "changed")) {
				config = parseConfig();
				fileNames = [...config.fileNames, virtual];
			}
		},
		close() {
			service.dispose();
		},
	};
};
