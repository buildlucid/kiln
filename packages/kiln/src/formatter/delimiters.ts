import type { DelimitedPart, Token } from "../lexer/lexer.js";

/** A token as the formatter prints it: its source text, unchanged. An interpolated string is one piece. */
type Piece = {
	type: Token["type"];
	text: string;
	start: number;
	end: number;
};

/**
 * What a piece does, where that changes its spacing.
 *
 * - `word`: a name, number or string.
 * - `keyword`: a tag's name, or a name such as `and` or `in`. A bracket after it groups rather than calls.
 * - `unary`: a sign that makes a number negative or positive, written against its operand.
 * - `tight`: `.`, `?.`, `..` and a filter's `|`, with no space either side.
 * - `key`: the colon after a key or named argument, or `?` and `?:` marking an optional key in `props`.
 * - `call`: a bracket that calls or indexes the piece before it.
 * - `open`, `close`: other brackets.
 * - `spaced`: operators with a space either side.
 */
type Role =
	| "word"
	| "keyword"
	| "unary"
	| "tight"
	| "key"
	| "call"
	| "open"
	| "close"
	| "comma"
	| "spread"
	| "spaced";

const KEYWORDS = new Set([
	"and",
	"or",
	"not",
	"in",
	"is",
	"starts",
	"ends",
	"with",
	"as",
	"import",
	"ignore",
	"missing",
]);

/** Joins each interpolated string's tokens, from `stringStart` to its matching `stringEnd`, into one piece. */
const toPieces = (source: string, tokens: readonly Token[]): Piece[] => {
	const pieces: Piece[] = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] as Token;
		let end = token.end;
		if (token.type === "stringStart") {
			let depth = 0;
			for (; index < tokens.length; index++) {
				const inner = tokens[index] as Token;
				if (inner.type === "stringStart") depth++;
				else if (inner.type === "stringEnd" && --depth === 0) break;
			}
			end = (tokens[Math.min(index, tokens.length - 1)] as Token).end;
		}
		pieces.push({
			type: token.type === "stringStart" ? "string" : token.type,
			text: source.slice(token.start, end),
			start: token.start,
			end,
		});
	}
	return pieces;
};

/** Works out each piece's role. `isTag` means the first piece is a tag's name. */
const rolesOf = (pieces: readonly Piece[], isTag: boolean): Role[] => {
	const roles: Role[] = [];
	// In `props`, `|` joins types and `?:` marks an optional key, until `=` starts a default value.
	const props = isTag && pieces[0]?.text === "props";
	let inDefault = false;
	// Open `?`s at each bracket depth, so a conditional's `:` can be told from a key's.
	const conditionals: number[] = [0];

	for (const [index, piece] of pieces.entries()) {
		const previous = roles[index - 1];
		const depth = conditionals.length - 1;
		const types = props && !inDefault;
		let role: Role;

		if (piece.type !== "punct") {
			role =
				(isTag && index === 0) ||
				(piece.type === "name" && KEYWORDS.has(piece.text))
					? "keyword"
					: "word";
		} else {
			switch (piece.text) {
				case "(":
				case "[":
					role = previous === "word" || previous === "close" ? "call" : "open";
					conditionals.push(0);
					break;
				case "{":
					role = "open";
					conditionals.push(0);
					break;
				case ")":
				case "]":
				case "}":
					role = "close";
					if (conditionals.length > 1) conditionals.pop();
					break;
				case ",":
					role = "comma";
					if (props && depth === 0) inDefault = false;
					break;
				case "...":
					role = "spread";
					break;
				case ".":
				case "?.":
				case "..":
					role = "tight";
					break;
				case "|":
					role = types ? "spaced" : "tight";
					break;
				case "-":
				case "+":
					role =
						previous === undefined ||
						(previous !== "word" && previous !== "close")
							? "unary"
							: "spaced";
					break;
				case "?":
				case "?:":
					role = types ? "key" : "spaced";
					if (piece.text === "?" && !types) {
						conditionals[depth] = (conditionals[depth] ?? 0) + 1;
					}
					break;
				case ":":
					if ((conditionals[depth] ?? 0) > 0) {
						conditionals[depth] = (conditionals[depth] ?? 0) - 1;
						role = "spaced";
					} else role = "key";
					break;
				default:
					role = "spaced";
					if (props && depth === 0 && piece.text === "=") inDefault = true;
			}
		}
		roles.push(role);
	}
	return roles;
};

/** The gap between two pieces: a space or nothing. */
const gapBetween = (
	previous: Piece,
	previousRole: Role,
	piece: Piece,
	role: Role,
): string => {
	if (role === "comma" || role === "tight" || role === "key" || role === "call")
		return "";
	if (role === "close") {
		return piece.text === "}" && previous.text !== "{" ? " " : "";
	}
	if (previousRole === "tight" || previousRole === "unary") return "";
	if (previousRole === "spread") return "";
	if (previousRole === "open" || previousRole === "call") {
		return previous.text === "{" ? " " : "";
	}
	return " ";
};

/**
 * Prints one output or tag with normalised spacing. Line breaks between tokens stay; each line after one is indented from `indent`, one step further or to match the brackets it sits inside, using `unit` per step.
 *
 * Returns null for a delimiter that never closed, which the formatter leaves as it is.
 */
export const printDelimiter = (
	source: string,
	part: DelimitedPart,
	indent: string,
	unit: string,
): string | null => {
	const tokens = part.tokens;
	const open = tokens[0];
	const close = tokens[tokens.length - 1];
	if (!open || !close || close.value === "" || tokens.length < 3) return null;

	const pieces = toPieces(source, tokens.slice(1, -1));
	const roles = rolesOf(pieces, part.kind === "tag");
	let out = open.value;
	let previousEnd = part.start + open.value.length;
	// The line each open bracket started on. Brackets opened on the same line add one step between them.
	const openedOn: number[] = [];
	let line = 0;
	/** Steps of indentation for a new line, once `closers` brackets at its start have closed. */
	const steps = (closers: number) =>
		new Set(openedOn.slice(0, openedOn.length - closers)).size;

	for (const [index, piece] of pieces.entries()) {
		const role = roles[index] as Role;
		const gap = source.slice(previousEnd, piece.start);
		if (gap.includes("\n")) {
			line++;
			// Closing brackets at the start of a line line up with the line that opened them. Only those on this line count.
			let closers = 0;
			while (
				roles[index + closers] === "close" &&
				(closers === 0 ||
					!source
						.slice(
							(pieces[index + closers - 1] as Piece).end,
							(pieces[index + closers] as Piece).start,
						)
						.includes("\n"))
			) {
				closers++;
			}
			out += `\n${indent}${unit.repeat(closers > 0 ? steps(closers) : Math.max(steps(0), 1))}`;
		} else if (index === 0) out += " ";
		else {
			out += gapBetween(
				pieces[index - 1] as Piece,
				roles[index - 1] as Role,
				piece,
				role,
			);
		}
		out += piece.text;
		if (role === "open" || role === "call") openedOn.push(line);
		else if (role === "close") openedOn.pop();
		previousEnd = piece.end;
	}

	const closeStart = part.end - close.value.length;
	out += source.slice(previousEnd, closeStart).includes("\n")
		? `\n${indent}`
		: " ";
	return out + close.value;
};
