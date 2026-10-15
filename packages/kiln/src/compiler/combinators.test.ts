import { describe, expect, test } from "vite-plus/test";
import type { Compiled, Run, Scope } from "../runtime/types.js";
import { constant, evalAll, map1, map2 } from "./combinators.js";

// The core package compiles without Node or DOM types, so declare the one timer this test needs.
declare const setTimeout: (
	callback: (value?: unknown) => void,
	ms: number,
) => unknown;

const run = {} as Run;
const scope = {} as Scope;
const asyncValue = (value: unknown): Compiled => ({
	ev: () => Promise.resolve(value),
	async: true,
});
const failing = (error: Error): Compiled => ({
	ev: () => {
		throw error;
	},
	async: false,
});

describe("map1 and map2", () => {
	test("stay synchronous when their inputs are", () => {
		expect(map1(constant(2), (v) => (v as number) * 2).ev(run, scope)).toBe(4);
		expect(
			map2(constant(1), constant(2), (a, b) => [a, b]).ev(run, scope),
		).toEqual([1, 2]);
	});

	test("wait only when an input is async", async () => {
		const doubled = map1(asyncValue(2), (v) => (v as number) * 2);
		expect(doubled.async).toBe(true);
		expect(await doubled.ev(run, scope)).toBe(4);
		expect(
			await map2(asyncValue(1), constant(2), (a, b) => [a, b]).ev(run, scope),
		).toEqual([1, 2]);
	});
});

describe("evalAll", () => {
	test("returns an array, or a promise of one only when needed", async () => {
		expect(evalAll([constant(1), constant(2)])(run, scope)).toEqual([1, 2]);
		const values = evalAll([constant(1), asyncValue(2)])(run, scope);
		expect(values).toBeInstanceOf(Promise);
		expect(await values).toEqual([1, 2]);
	});

	test("a synchronous failure silences promises already started", async () => {
		const rejected: Compiled = {
			ev: () => Promise.reject(new Error("later")),
			async: true,
		};
		expect(() =>
			evalAll([rejected, failing(new Error("now"))])(run, scope),
		).toThrow("now");
		// An unhandled rejection here would fail the test run.
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
});
