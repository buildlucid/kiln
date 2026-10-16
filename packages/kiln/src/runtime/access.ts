import {
	BLOCKED_NAMES,
	exposedMembers,
	type LookupTarget,
	lookup,
} from "./exposure.js";
import { Markup } from "./markup.js";
import { hashKeys, isPlainObject, mapKeys, MISSING } from "./values.js";

const isClassInstance = (value: object): boolean =>
	!Array.isArray(value) &&
	!isPlainObject(value) &&
	!(value instanceof Map) &&
	!(value instanceof Set) &&
	!(value instanceof Date) &&
	!(value instanceof Markup);

const arrayIndex = (key: string | number): number => {
	if (typeof key === "number") return Number.isInteger(key) ? key : -1;
	return /^(0|[1-9]\d*)$/.test(key) ? Number(key) : -1;
};

/**
 * Reads a property the way templates may, following the safety model. Returns `MISSING` when the property cannot be read or does not exist.
 */
export const getAttr = (target: unknown, key: string | number): unknown => {
	if (typeof target !== "object" || target === null) return MISSING;

	if (Array.isArray(target)) {
		if (key === "length") return target.length;
		const index = arrayIndex(key);
		return index >= 0 && index < target.length ? target[index] : MISSING;
	}

	const name = typeof key === "number" ? String(key) : key;
	if (BLOCKED_NAMES.has(name)) return MISSING;

	const proto = Object.getPrototypeOf(target);
	if (proto === Object.prototype || proto === null) {
		return Object.hasOwn(target, name)
			? (target as Record<string, unknown>)[name]
			: MISSING;
	}
	if (target instanceof Map) {
		return target.has(name) ? target.get(name) : MISSING;
	}
	if (!isClassInstance(target)) return MISSING;

	if (exposedMembers(proto).has(name)) {
		return (target as Record<string, unknown>)[name];
	}
	const resolver = (target as LookupTarget)[lookup];
	if (typeof resolver === "function") {
		const value = resolver.call(target, name);
		return value === undefined ? MISSING : value;
	}
	return MISSING;
};

/** Returns an exposed method of a class instance, or `undefined` when it is not exposed or not a function. */
export const getMethod = (
	target: unknown,
	name: string,
): ((...args: unknown[]) => unknown) | undefined => {
	if (typeof target !== "object" || target === null) return undefined;
	if (!isClassInstance(target) || BLOCKED_NAMES.has(name)) return undefined;
	if (!exposedMembers(Object.getPrototypeOf(target)).has(name))
		return undefined;
	const method = (target as Record<string, unknown>)[name];
	return typeof method === "function"
		? (method as (...args: unknown[]) => unknown)
		: undefined;
};

/** Names a template could read from a value, for "did you mean" hints. */
export const readableNames = (target: unknown): string[] => {
	if (typeof target !== "object" || target === null) return [];
	if (isPlainObject(target)) return hashKeys(target);
	if (target instanceof Map) return mapKeys(target);
	if (isClassInstance(target)) {
		return [...exposedMembers(Object.getPrototypeOf(target))];
	}
	return [];
};
