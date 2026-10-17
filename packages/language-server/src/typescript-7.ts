import { basename, dirname } from "node:path";
import type * as Sync from "typescript/unstable/sync";
import {
	entriesWith,
	lineAndCharacter,
	type Member,
	samePath,
	type TypeScriptProject,
	virtualPath,
} from "./typescript.js";

/** `TypeFormatFlags.NoTruncation`, so long types are written in full. */
const NO_TRUNCATION = 1;

/** A project checked by TypeScript 7's API, which runs the native compiler in its own process. */
export const openTypeScript7 = (
	sync: Pick<typeof Sync, "API" | "SymbolFlags">,
	configPath: string,
): TypeScriptProject => {
	let virtual = "";
	let text = "";
	const api = new sync.API({
		cwd: dirname(configPath),
		fs: {
			readFile: (path) => (samePath(path, virtual) ? text : undefined),
			fileExists: (path) => (samePath(path, virtual) ? true : undefined),
			getAccessibleEntries: (folder) =>
				virtual && samePath(folder, dirname(virtual))
					? entriesWith(folder, basename(virtual))
					: undefined,
		},
	});
	virtual = virtualPath(configPath, api.parseConfigFile(configPath).fileNames);
	let snapshot = api.updateSnapshot({ openProjects: [configPath] });
	const update = (changes: Parameters<typeof api.updateSnapshot>[0]) => {
		snapshot.dispose();
		snapshot = api.updateSnapshot(changes);
	};

	return {
		query(source, use) {
			if (source !== text) {
				text = source;
				update({ fileChanges: { changed: [virtual] } });
			}
			const project = snapshot.getProject(configPath);
			if (!project?.program.getSourceFile(virtual)) return null;
			const { checker } = project;
			const typeOf = (alias: string) => {
				const at = text.indexOf(`type ${alias} =`);
				return at === -1
					? undefined
					: checker.getTypeAtPosition(virtual, at + "type ".length);
			};
			return use({
				describe: (alias) => {
					const type = typeOf(alias);
					return type
						? checker.typeToString(type, undefined, NO_TRUNCATION)
						: null;
				},
				members: (alias) => {
					const type = typeOf(alias);
					if (!type) return [];
					return checker.getPropertiesOfType(type).map((symbol): Member => {
						const node = symbol.declarations[0]?.resolve(project);
						const file = node?.getSourceFile();
						const memberType = checker.getTypeOfSymbol(symbol);
						return {
							name: symbol.name,
							optional: (symbol.flags & sync.SymbolFlags.Optional) !== 0,
							type: memberType
								? checker.typeToString(memberType, undefined, NO_TRUNCATION)
								: "unknown",
							docs: checker.getDocumentationCommentOfSymbol(symbol),
							tags: checker
								.getJsDocTagsOfSymbol(symbol)
								.map((tag) => ({ name: tag.name, text: tag.text ?? "" })),
							location:
								node && file
									? {
											path: file.fileName,
											...lineAndCharacter(file.text, node.getStart(file)),
										}
									: null,
						};
					});
				},
			});
		},
		changed(changes) {
			const paths = (kind: string) =>
				changes
					.filter((change) => change.kind === kind)
					.map((change) => change.path);
			update({
				fileChanges: {
					created: paths("created"),
					changed: paths("changed"),
					deleted: paths("deleted"),
				},
			});
		},
		close() {
			snapshot.dispose();
			api.close();
		},
	};
};
