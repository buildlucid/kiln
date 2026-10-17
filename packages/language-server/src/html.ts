import { templateText } from "@lucidkiln/core";
import { getLanguageService } from "vscode-html-languageservice";
import type { CompletionItem, Hover } from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";

const service = getLanguageService();

/** The template as an HTML document, with Kiln syntax blanked out so the HTML service only sees the markup. */
const htmlOf = (document: TextDocument) => {
	const html = TextDocument.create(
		document.uri,
		"html",
		document.version,
		templateText(document.getText()),
	);
	return { html, parsed: service.parseHTMLDocument(html) };
};

/** HTML elements, attributes and attribute values at `offset`, outside Kiln syntax. */
export const htmlCompletions = (
	document: TextDocument,
	offset: number,
): CompletionItem[] => {
	const { html, parsed } = htmlOf(document);
	return service.doComplete(html, document.positionAt(offset), parsed).items;
};

/** MDN's description of the HTML element or attribute at `offset`, outside Kiln syntax. */
export const htmlHover = (
	document: TextDocument,
	offset: number,
): Hover | null => {
	const { html, parsed } = htmlOf(document);
	return service.doHover(html, document.positionAt(offset), parsed);
};
