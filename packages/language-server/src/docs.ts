import docs from "./docs.json" with { type: "json" };

/** The kinds of built-in that have docs. */
export type DocKind = "tags" | "filters" | "functions" | "tests";

/**
 * What each built-in does, from its section of the docs site, up to the end of its first example. The docs build writes
 * `docs.json`; see `apps/documentation/src/editor-docs.ts`.
 */
const DOCS: Record<
	DocKind,
	Record<string, { markdown: string; url: string }>
> = docs;

/** A built-in's docs as Markdown, ending with a link to its section on the docs site. Null for names without docs. */
export const docsFor = (kind: DocKind, name: string): string | null => {
	const doc = DOCS[kind][name];
	return doc ? `${doc.markdown}\n\n---\n\n[Kiln docs](${doc.url})` : null;
};
