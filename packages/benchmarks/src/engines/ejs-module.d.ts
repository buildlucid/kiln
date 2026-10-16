// EJS ships no types. This covers only what the EJS adapter uses.
declare module "ejs" {
	type Options = {
		async?: boolean;
		cache?: boolean;
		compileDebug?: boolean;
		filename?: string;
		/** Supplies an included template's source. Gets the path as written and as EJS resolved it. */
		includer?: (
			originalPath: string,
			parsedPath: string,
		) => { filename?: string; template?: string };
	};

	const ejs: {
		compile(
			template: string,
			options: Options,
		): (data: Record<string, unknown>) => string | Promise<string>;
		clearCache(): void;
	};

	export default ejs;
}
