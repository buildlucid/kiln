import type { ExtensionContext } from "vscode";
import { LanguageClient, TransportKind } from "vscode-languageclient/node";

/**
 * Starts Kiln's language server when VS Code opens a Kiln file. The server is bundled with the extension and runs on
 * VS Code's own Node. It loads the project's installed version of Kiln itself, when there is one.
 */
export const activate = async (context: ExtensionContext): Promise<void> => {
	const client = new LanguageClient(
		"kiln",
		"Kiln",
		{
			module: context.asAbsolutePath("dist/server.cjs"),
			transport: TransportKind.ipc,
		},
		{ documentSelector: [{ scheme: "file", language: "kiln" }] },
	);
	context.subscriptions.push(client);
	await client.start();
};
