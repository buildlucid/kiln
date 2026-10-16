/**
 * Reduces HTML to what a browser would show, so engines that format whitespace or escape quotes differently still
 * compare equal. `<`, `>` and `&` must be escaped the same way, so escaping is still checked.
 */
export const normalise = (html: string) =>
	html
		.replace(/<!doctype/i, "<!doctype")
		.replace(/&(?:#39|#x27|#039|apos);/g, "'")
		.replace(/&(?:quot|#34|#x22);/g, '"')
		.replace(/&#x3D;/g, "=")
		.replace(/&#x60;/g, "`")
		.replace(/\s+/g, " ")
		.replace(/ ?(<[^>]+>) ?/g, "$1")
		.trim();

/** Describes where two normalised outputs first differ, or returns `null` if they match. */
export const difference = (expected: string, actual: string) => {
	if (expected === actual) return null;
	let index = 0;
	while (expected[index] === actual[index]) index++;
	const start = Math.max(0, index - 60);
	return `expected …${expected.slice(start, index + 60)}…\n     got …${actual.slice(start, index + 60)}…`;
};
