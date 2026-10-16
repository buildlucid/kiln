import { close, createIndex, type PagefindIndex } from "pagefind";

const open = async (): Promise<PagefindIndex> => {
	const { index, errors } = await createIndex();
	if (!index)
		throw new Error(`Pagefind failed to start:\n${errors.join("\n")}`);
	return index;
};

const check = ({ errors }: { errors: string[] }) => {
	if (errors.length) throw new Error(`Pagefind failed:\n${errors.join("\n")}`);
};

/** Indexes the built site in `dir` and writes the search bundle to `dir/pagefind`. */
export const writeSearchIndex = async (dir: string) => {
	const index = await open();
	check(await index.addDirectory({ path: dir }));
	check(await index.writeFiles({ outputPath: `${dir}/pagefind` }));
	await close();
};

/** Indexes rendered pages in memory, for the dev server. Returns each bundle file by its path inside `/pagefind/`. */
export const searchFiles = async (
	pages: { url: string; html: string }[],
): Promise<Map<string, Uint8Array>> => {
	const index = await open();
	for (const page of pages)
		check(await index.addHTMLFile({ url: page.url, content: page.html }));
	const { files, errors } = await index.getFiles();
	check({ errors });
	await index.deleteIndex();
	return new Map(files.map((file) => [file.path, file.content]));
};
