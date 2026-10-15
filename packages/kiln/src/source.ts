/** A range of a template's source, as zero-based offsets. `end` is exclusive. */
export type Span = { start: number; end: number };

export type Position = {
	/** Zero-based offset into the source. */
	offset: number;
	/** One-based. */
	line: number;
	/** One-based, counted in UTF-16 code units. */
	column: number;
};

/**
 * A template's text and resolved name.
 *
 * The line index is built on first use, because only errors and tooling need lines and columns.
 */
export class Source {
	#lineStarts: number[] | undefined;

	constructor(
		readonly name: string,
		readonly text: string,
	) {}

	/** Converts an offset into a line and column. */
	position(offset: number): Position {
		const starts = this.#getLineStarts();
		let low = 0;
		let high = starts.length - 1;
		while (low < high) {
			const middle = (low + high + 1) >> 1;
			if ((starts[middle] ?? 0) <= offset) low = middle;
			else high = middle - 1;
		}
		return {
			offset,
			line: low + 1,
			column: offset - (starts[low] ?? 0) + 1,
		};
	}

	/**
	 * Renders a few lines around a span, with a marker under it.
	 *
	 * ```text
	 *   3 | {% block content %}
	 * > 4 |   <h1>{{ titel }}</h1>
	 *     |          ^^^^^
	 * ```
	 */
	frame(span: Span, context = 1): string {
		const starts = this.#getLineStarts();
		const start = this.position(span.start);
		const firstLine = Math.max(1, start.line - context);
		const lastLine = Math.min(starts.length, start.line + context);
		const gutter = String(lastLine).length;
		const lines: string[] = [];

		for (let line = firstLine; line <= lastLine; line++) {
			const text = this.#lineText(line);
			const number = String(line).padStart(gutter);
			const marker = line === start.line ? ">" : " ";
			lines.push(`${marker} ${number} | ${text}`);

			if (line === start.line) {
				const lineEnd = (starts[line - 1] ?? 0) + text.length;
				const width = Math.max(1, Math.min(span.end, lineEnd) - span.start);
				// Keep tabs so the marker lines up with tab-indented source.
				const indent = text.slice(0, start.column - 1).replace(/[^\t]/g, " ");
				lines.push(`  ${" ".repeat(gutter)} | ${indent}${"^".repeat(width)}`);
			}
		}
		return lines.join("\n");
	}

	#lineText(line: number): string {
		const starts = this.#getLineStarts();
		const start = starts[line - 1] ?? 0;
		const next = starts[line];
		const end = next === undefined ? this.text.length : next - 1;
		return this.text.slice(start, end).replace(/\r$/, "");
	}

	#getLineStarts(): number[] {
		if (this.#lineStarts) return this.#lineStarts;
		const starts = [0];
		const text = this.text;
		for (let i = 0; i < text.length; i++) {
			if (text.charCodeAt(i) === 10) starts.push(i + 1);
		}
		this.#lineStarts = starts;
		return starts;
	}
}
