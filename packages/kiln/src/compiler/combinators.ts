import {
	all,
	hold,
	holdData,
	isPromise,
	silence,
	unhold,
} from "../runtime/render.js";
import type { Compiled, Run, Scope } from "../runtime/types.js";

/*
 * Only a compiled expression marked `async` may return a promise to wait for. Any other promise is a value from your
 * data, which is never waited for, so it is held when it has to pass through a promise. See `holdData`.
 */

/** A compiled literal. */
export const constant = (value: unknown): Compiled => ({
	ev: () => value,
	async: false,
	constant: { value },
});

/**
 * Compiles `f(a)`. The sync version never checks for promises, so expressions without async calls stay fast.
 *
 * `async` says whether `f` itself may return a promise. If it does, a value from your data that `f` returns as it is
 * must go through `passData`.
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
	const keep = async ? hold : holdData;
	return {
		ev: (run, scope) => {
			const value = ev(run, scope);
			return isPromise(value)
				? value.then((resolved) => keep(f(unhold(resolved), run, scope)))
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
	const leftAsync = a.async;
	const rightAsync = b.async;
	const keep = async ? hold : holdData;
	return {
		ev: (run, scope) => {
			const l = left(run, scope);
			let r: unknown;
			try {
				r = right(run, scope);
			} catch (error) {
				if (leftAsync) silence(l);
				throw error;
			}
			if ((leftAsync && isPromise(l)) || (rightAsync && isPromise(r))) {
				return all([
					leftAsync ? l : holdData(l),
					rightAsync ? r : holdData(r),
				]).then(([lv, rv]) => keep(f(lv, rv, run, scope)));
			}
			return f(l, r, run, scope);
		},
		async: true,
	};
};

/** Evaluates a list of expressions in order. Returns a promise only if one that may wait returned one. */
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
	const asyncAt = list.map((item) => item.async);
	return (run, scope) => {
		// oxlint-disable-next-line unicorn/no-new-array -- preallocates a known length on the hot path
		const values = new Array<unknown>(count);
		let pending = false;
		try {
			for (let i = 0; i < count; i++) {
				const value = (evs[i] as Compiled["ev"])(run, scope);
				values[i] = value;
				if (asyncAt[i] && isPromise(value)) pending = true;
			}
		} catch (error) {
			for (let i = 0; i < count; i++) if (asyncAt[i]) silence(values[i]);
			throw error;
		}
		if (!pending) return values;
		for (let i = 0; i < count; i++) {
			if (!asyncAt[i]) values[i] = holdData(values[i]);
		}
		return all(values);
	};
};
