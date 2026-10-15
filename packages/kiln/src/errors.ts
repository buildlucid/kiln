import type { Position, Source, Span } from "./source.js";

export type Diagnostic = {
	/** A stable kebab-case code, such as `unknown-filter`. */
	code: string;
	message: string;
	severity: "error" | "warning";
	/** Resolved template name. */
	template: string;
	start: Position;
	end: Position;
};

export type TemplateLocation = {
	template: string;
	line: number;
	column: number;
};

/** Creates a diagnostic for a span of a source. */
export const createDiagnostic = (
	source: Source,
	code: string,
	message: string,
	span: Span,
	severity: Diagnostic["severity"] = "error",
): Diagnostic => ({
	code,
	message,
	severity,
	template: source.name,
	start: source.position(span.start),
	end: source.position(span.end),
});

const describe = (location: TemplateLocation) =>
	`in ${location.template} at line ${location.line}, column ${location.column}`;

/**
 * Thrown when a template cannot be parsed or compiled. `diagnostics` lists every problem found.
 */
export class KilnSyntaxError extends Error {
	override name = "KilnSyntaxError";
	readonly diagnostics: Diagnostic[];

	constructor(diagnostics: Diagnostic[], source: Source) {
		const errors = diagnostics.filter((d) => d.severity === "error");
		const first = errors[0] ?? diagnostics[0];
		let message = "Template could not be parsed.";
		if (first) {
			message = `${first.message} ${describe({ template: first.template, line: first.start.line, column: first.start.column })}.`;
			if (first.template === source.name) {
				message += `\n\n${source.frame({ start: first.start.offset, end: first.end.offset })}`;
			}
			if (errors.length > 1) {
				message += `\n\n${errors.length - 1} more ${errors.length === 2 ? "problem" : "problems"} found.`;
			}
		}
		super(message);
		this.diagnostics = diagnostics;
	}
}

/**
 * Thrown while rendering: type errors, missing variables, limits, missing templates and errors from host functions.
 */
export class KilnRenderError extends Error {
	override name = "KilnRenderError";
	readonly code: string;
	readonly template: string;
	readonly line: number;
	readonly column: number;
	/** A few lines of source around the error, with a marker. */
	readonly frame: string;
	/** Templates from the outermost to the one that failed. */
	readonly templateStack: TemplateLocation[];
	readonly #detail: string;

	/**
	 * `source` is a template name alone when the error has no position, such as a missing top-level template. `line` and `column` are then 0.
	 */
	constructor(
		code: string,
		detail: string,
		source: Source | string,
		span: Span = { start: 0, end: 0 },
		options: { hint?: string; cause?: unknown } = {},
	) {
		const hint = options.hint ? ` ${options.hint}` : "";
		let location: TemplateLocation;
		let frame = "";
		let message: string;
		if (typeof source === "string") {
			location = { template: source, line: 0, column: 0 };
			message = `${detail}.${hint}`;
		} else {
			const start = source.position(span.start);
			location = {
				template: source.name,
				line: start.line,
				column: start.column,
			};
			frame = source.frame(span);
			message = `${detail} ${describe(location)}.${hint}\n\n${frame}`;
		}
		super(message, { cause: options.cause });
		this.code = code;
		this.template = location.template;
		this.line = location.line;
		this.column = location.column;
		this.frame = frame;
		this.templateStack = [location];
		this.#detail = detail;
	}

	/** The message without its location and code frame. */
	get detail(): string {
		return this.#detail;
	}
}

/**
 * Raised inside built-ins and runtime helpers that do not know where they were called from.
 *
 * The compiled call site catches it and rethrows a `KilnRenderError` with a location.
 */
export class KilnIssue extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

/** Shorthand for throwing a `KilnIssue`. */
export const issue = (code: string, message: string): never => {
	throw new KilnIssue(code, message);
};
