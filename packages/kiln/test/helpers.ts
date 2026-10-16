import {
	createKiln,
	type IslandMode,
	type KilnOptions,
	KilnRenderError,
	KilnSyntaxError,
	memoryLoader,
	type PrecompiledTemplate,
} from "../src/index.js";

export type TestOptions = Omit<KilnOptions, "loader"> & {
	/** Variables passed to `render`. */
	context?: Record<string, unknown>;
	/** Other templates the test template uses, by name, such as `{ "layouts/base": "..." }`. */
	templates?: Record<string, string>;
	/** The `islands` render option, to defer or stream `island` tags. */
	islands?: IslandMode;
	/** The `signal` render option, to abort the render. */
	signal?: AbortSignal;
};

export type KilnError = KilnRenderError | KilnSyntaxError;

/** Whether `render` precompiles templates first. The test suite runs once each way; see `vite.config.ts`. */
export const precompiling = process.env.KILN_PRECOMPILE === "1";

/** Loads a module `precompile` wrote, as a bundler would. */
export const loadModule = async (
	code: string,
): Promise<PrecompiledTemplate> => {
	const url = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
	const module = (await import(/* @vite-ignore */ url)) as {
		default: PrecompiledTemplate;
	};
	return module.default;
};

/**
 * Precompiles every template. Templates with syntax errors stay as source, so their errors come from `render` as
 * they would without precompiling.
 */
const precompileAll = async (
	sources: Record<string, string>,
	options: Omit<KilnOptions, "loader">,
): Promise<Record<string, string | PrecompiledTemplate>> => {
	const builder = createKiln({ ...options, loader: memoryLoader(sources) });
	const templates: Record<string, string | PrecompiledTemplate> = {};
	for (const [name, source] of Object.entries(sources)) {
		try {
			templates[name] = await loadModule(await builder.precompile(name));
		} catch (error) {
			if (!(error instanceof KilnSyntaxError)) throw error;
			templates[name] = source;
		}
	}
	return templates;
};

/** An environment holding `template` as `index.kiln`, with any other templates alongside it. */
const environment = async (template: string, options: TestOptions) => {
	const {
		templates = {},
		context: _context,
		islands: _islands,
		signal: _signal,
		...kilnOptions
	} = options;
	const sources = { ...templates, index: template };
	return createKiln({
		...kilnOptions,
		loader: memoryLoader(
			precompiling ? await precompileAll(sources, kilnOptions) : sources,
		),
	});
};

/** Renders `template` as `index.kiln`, with any other templates alongside it. */
export const render = async (
	template: string,
	options: TestOptions = {},
): Promise<string> =>
	(await environment(template, options)).render("index", options.context, {
		islands: options.islands,
		signal: options.signal,
	});

/** Streams `template` as `index.kiln`, as `render` renders it. */
export const renderStream = async (
	template: string,
	options: TestOptions = {},
): Promise<ReadableStream<Uint8Array>> =>
	(await environment(template, options)).renderStream(
		"index",
		options.context,
		{ islands: options.islands, signal: options.signal },
	);

/** Reads a stream to its end, and returns each part it sent as text. */
export const readParts = async (
	stream: ReadableStream<Uint8Array>,
): Promise<string[]> => {
	const decoder = new TextDecoder();
	const parts: string[] = [];
	for await (const chunk of stream) parts.push(decoder.decode(chunk));
	return parts;
};

/** Renders a template that should fail, and returns its error. Fails the test if the render succeeds. */
export const renderError = async (
	template: string,
	options: TestOptions = {},
): Promise<KilnError> => {
	try {
		const output = await render(template, options);
		throw new Error(
			`Expected the render to fail, but it returned ${JSON.stringify(output)}`,
		);
	} catch (error) {
		if (error instanceof KilnRenderError || error instanceof KilnSyntaxError)
			return error;
		throw error;
	}
};

/** The code of the error a template fails with. For syntax errors, the first problem's code. */
export const errorCode = async (
	template: string,
	options: TestOptions = {},
): Promise<string> => {
	const error = await renderError(template, options);
	if (error instanceof KilnRenderError) return error.code;
	return (
		error.diagnostics.find((diagnostic) => diagnostic.severity === "error")
			?.code ?? ""
	);
};

/** Every error code a template fails with, in source order. A render error has one. */
export const errorCodes = async (
	template: string,
	options: TestOptions = {},
): Promise<string[]> => {
	const error = await renderError(template, options);
	if (error instanceof KilnRenderError) return [error.code];
	return error.diagnostics.map((diagnostic) => diagnostic.code);
};

/** Joins lines with newlines, for templates and output where line breaks matter. */
export const lines = (...parts: string[]): string => parts.join("\n");

/** A host function that resolves to `value` after `ms` milliseconds, for async tests. */
export const later = <T>(value: T, ms = 0): Promise<T> =>
	new Promise((resolve) => setTimeout(() => resolve(value), ms));

/** Lets a stray unhandled rejection surface before the test ends. Vitest fails the run if one does. */
export const settle = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 10));
