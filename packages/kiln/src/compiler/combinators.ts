import { all, hold, isPromise, silence, unhold } from "../runtime/render.js";
import type { Compiled, Run, Scope } from "../runtime/types.js";

/** A compiled literal. */
export const constant = (value: unknown): Compiled => ({
	ev: () => value,
	async: false,
	constant: { value },
});

/**
 * Compiles `f(a)`. The sync version never checks for promises, so expressions without async calls stay fast.
 *
 * `async` says whether `f` itself may return a promise.
 */
export const map1 = (
	a: Compiled,
	f: (value: unknown, run: Run, scope: Scope) => unknown,
	async = false,
): Compiled => {
	const ev = a.ev;
	if (!a.async) {
		return { ev: (run, scope) => f(ev(run, scope), run, scope), async };
	}
	return {
		ev: (run, scope) => {
			const value = ev(run, scope);
			return isPromise(value)
				? value.then((resolved) => hold(f(unhold(resolved), run, scope)))
				: f(value, run, scope);
		},
		async: true,
	};
};

/** Compiles `f(a, b)`. Both sides start before either is awaited. */
export const map2 = (
	a: Compiled,
	b: Compiled,
	f: (left: unknown, right: unknown, run: Run, scope: Scope) => unknown,
	async = false,
): Compiled => {
	const left = a.ev;
	const right = b.ev;
	if (!a.async && !b.async) {
		return {
			ev: (run, scope) => f(left(run, scope), right(run, scope), run, scope),
			async,
		};
	}
	return {
		ev: (run, scope) => {
			const l = left(run, scope);
			let r: unknown;
			try {
				r = right(run, scope);
			} catch (error) {
				silence(l);
				throw error;
			}
			if (isPromise(l) || isPromise(r)) {
				return all([l, r]).then(([lv, rv]) => hold(f(lv, rv, run, scope)));
			}
			return f(l, r, run, scope);
		},
		async: true,
	};
};

/** Evaluates a list of expressions in order. Returns a promise only if one of them did. */
export const evalAll = (
	list: readonly Compiled[],
): ((run: Run, scope: Scope) => unknown[] | Promise<unknown[]>) => {
	const evs = list.map((item) => item.ev);
	const count = evs.length;
	if (count === 0) return () => [];
	if (!list.some((item) => item.async)) {
		return (run, scope) => {
			// oxlint-disable-next-line unicorn/no-new-array -- preallocates a known length on the hot path
			const values = new Array<unknown>(count);
			for (let i = 0; i < count; i++) {
				values[i] = (evs[i] as Compiled["ev"])(run, scope);
			}
			return values;
		};
	}
	return (run, scope) => {
		// oxlint-disable-next-line unicorn/no-new-array -- preallocates a known length on the hot path
		const values = new Array<unknown>(count);
		let pending = false;
		try {
			for (let i = 0; i < count; i++) {
				const value = (evs[i] as Compiled["ev"])(run, scope);
				values[i] = value;
				if (isPromise(value)) pending = true;
			}
		} catch (error) {
			for (const value of values) silence(value);
			throw error;
		}
		return pending ? all(values) : values;
	};
};
