import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { memoryCache } from "../../src/index.js";

describe("memoryCache", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("returns what was saved, and null otherwise", () => {
		const cache = memoryCache();
		cache.set({ key: "a", value: "<p>A</p>", seconds: null });
		expect(cache.get({ key: "a" })).toBe("<p>A</p>");
		expect(cache.get({ key: "b" })).toBeNull();
	});

	test("forgets a copy once its seconds have passed", () => {
		vi.useFakeTimers();
		const cache = memoryCache();
		cache.set({ key: "a", value: "A", seconds: 60 });
		vi.advanceTimersByTime(59_000);
		expect(cache.get({ key: "a" })).toBe("A");
		vi.advanceTimersByTime(1_000);
		expect(cache.get({ key: "a" })).toBeNull();
	});

	test("drops the oldest copy when full", () => {
		const cache = memoryCache({ max: 2 });
		cache.set({ key: "a", value: "A", seconds: null });
		cache.set({ key: "b", value: "B", seconds: null });
		cache.set({ key: "a", value: "A2", seconds: null });
		cache.set({ key: "c", value: "C", seconds: null });
		expect([
			cache.get({ key: "a" }),
			cache.get({ key: "b" }),
			cache.get({ key: "c" }),
		]).toEqual(["A2", null, "C"]);
	});
});
