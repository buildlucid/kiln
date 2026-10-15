import type { EscapeStrategy } from "../parser/ast.js";

/**
 * A string that is already safe to output with one escaping strategy.
 *
 * Output skips escaping for markup whose strategy matches, and escapes it otherwise.
 */
export class Markup {
	constructor(
		readonly value: string,
		readonly strategy: EscapeStrategy,
	) {}

	toString(): string {
		return this.value;
	}
}

/**
 * Marks a string as safe to output with one escaping strategy, `"html"` by default.
 *
 * Return this from a function or filter that produces trusted HTML, such as rendered rich text.
 */
export const safe = (
	value: string,
	strategy: EscapeStrategy = "html",
): Markup => new Markup(String(value), strategy);

/** Checks whether a value was marked safe with `safe()` or by a template. */
export const isSafe = (value: unknown): value is Markup =>
	value instanceof Markup;
