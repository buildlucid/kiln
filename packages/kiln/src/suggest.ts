/** Edit distance where swapping two neighbouring characters counts as one edit, so "titel" is close to "title". */
const distance = (a: string, b: string): number => {
	const rows = Array.from({ length: a.length + 1 }, (_, i) =>
		Array.from({ length: b.length + 1 }, (_, j) =>
			i === 0 ? j : j === 0 ? i : 0,
		),
	);
	const at = (i: number, j: number) => rows[i]?.[j] as number;
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			let best = Math.min(
				at(i - 1, j) + 1,
				at(i, j - 1) + 1,
				at(i - 1, j - 1) + cost,
			);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				best = Math.min(best, at(i - 2, j - 2) + 1);
			}
			(rows[i] as number[])[j] = best;
		}
	}
	return at(a.length, b.length);
};

/** Returns a `Did you mean "x"?` hint for the closest candidate, or undefined if none is close. */
export const suggest = (
	name: string,
	candidates: Iterable<string>,
): string | undefined => {
	let best: string | undefined;
	// One more than the largest distance allowed, so the first of several equally close candidates wins.
	let bestDistance = Math.max(1, Math.floor(name.length / 3)) + 1;
	for (const candidate of candidates) {
		if (candidate === name) continue;
		const score = distance(name.toLowerCase(), candidate.toLowerCase());
		if (score < bestDistance) {
			best = candidate;
			bestDistance = score;
		}
	}
	return best === undefined ? undefined : `Did you mean "${best}"?`;
};
