import { issue } from "../errors.js";
import type { PropType } from "../parser/ast.js";
import { BLOCKED_NAMES, exposedMembers } from "./exposure.js";
import { Markup } from "./markup.js";
import type { TypeCheck } from "./types.js";

export { BLOCKED_NAMES };

/** Returned by guarded lookups for a variable or property that does not exist. Never escapes into template values. */
export const MISSING: unique symbol = Symbol("kiln.missing");

export type Hash = Record<string, unknown>;

/** Checks for an object literal or a null-prototype object, which Kiln treats as a hash. */
export const isPlainObject = (value: unknown): value is Hash => {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
};

/** Checks for any value Kiln treats as a hash: a plain object or a `Map`. */
export const isHashLike = (
	value: unknown,
): value is Hash | Map<unknown, unknown> =>
	isPlainObject(value) || value instanceof Map;

/** Own enumerable keys of a plain object, without blocked names. */
export const hashKeys = (value: Hash): string[] => {
	const keys = Object.keys(value);
	return keys.some((key) => BLOCKED_NAMES.has(key))
		? keys.filter((key) => !BLOCKED_NAMES.has(key))
		: keys;
};

/** Sets an own property without triggering the `__proto__` setter. */
export const setOwn = (target: Hash, key: string, value: unknown): void => {
	if (key === "__proto__") {
		Object.defineProperty(target, key, {
			value,
			enumerable: true,
			writable: true,
			configurable: true,
		});
	} else {
		target[key] = value;
	}
};

const hasOwnKeys = (value: object): boolean => {
	for (const key in value) {
		if (Object.hasOwn(value, key)) return true;
	}
	return false;
};

/** Kiln truthiness: empty arrays, hashes, maps and sets are falsy, and `"0"` is truthy. */
export const truthy = (value: unknown): boolean => {
	switch (typeof value) {
		case "boolean":
			return value;
		case "string":
			return value !== "";
		case "number":
			return value !== 0 && !Number.isNaN(value);
		case "undefined":
			return false;
		case "object": {
			if (value === null) return false;
			if (Array.isArray(value)) return value.length > 0;
			if (value instanceof Markup) return value.value !== "";
			if (value instanceof Map || value instanceof Set) return value.size > 0;
			if (isPlainObject(value)) return hasOwnKeys(value);
			return true;
		}
		default:
			return true;
	}
};

/** Kiln emptiness, used by the `empty` test and `default` filter. Unlike falsiness, `0` is not empty. */
export const isEmpty = (value: unknown): boolean => {
	if (
		value === null ||
		value === undefined ||
		value === false ||
		value === ""
	) {
		return true;
	}
	if (typeof value !== "object") return false;
	if (Array.isArray(value)) return value.length === 0;
	if (value instanceof Markup) return value.value === "";
	if (value instanceof Map || value instanceof Set) return value.size === 0;
	if (isPlainObject(value)) return !hasOwnKeys(value);
	return false;
};

/** A short name for a value's Kiln type, for error messages. */
export const typeName = (value: unknown): string => {
	if (value === null || value === undefined) return "null";
	if (Array.isArray(value)) return "array";
	if (value instanceof Markup) return "markup";
	if (value instanceof Date) return "date";
	if (value instanceof Map || isPlainObject(value)) return "hash";
	if (value instanceof Set) return "set";
	if (typeof value === "function") return "function";
	if (typeof value === "object") {
		const name = Object.getPrototypeOf(value)?.constructor?.name;
		return typeof name === "string" && name !== ""
			? `${name} object`
			: "object";
	}
	return typeof value;
};

/**
 * Whether a value fits one member of a prop's type. `string` also accepts markup, and `object` any class instance.
 *
 * Only the outer value is checked: a list must be an array and a shape a hash or object, whatever they hold. Host types run their check from `types`.
 */
export const matchesType = (
	value: unknown,
	type: readonly PropType[],
	types: ReadonlyMap<string, TypeCheck>,
): boolean => {
	const name = typeName(value);
	return type.some((member) => {
		if (typeof member === "string") {
			return (
				member === name ||
				(member === "string" && name === "markup") ||
				(member === "object" && name.endsWith("object"))
			);
		}
		if ("literal" in member) return unwrap(value) === member.literal;
		if ("list" in member) return name === "array";
		if ("shape" in member) return name === "hash" || name.endsWith("object");
		return types.get(member.named)?.(value) === true;
	});
};

/** Writes a prop's type as it appears in a template, such as `"primary" | "secondary"`. */
export const describeType = (type: readonly PropType[]): string =>
	type.map(describeMember).join(" | ");

const describeMember = (member: PropType): string => {
	if (typeof member === "string") return member;
	if ("literal" in member) return JSON.stringify(member.literal);
	if ("named" in member) return member.named;
	if ("list" in member) {
		const inner = describeType(member.list);
		return member.list.length > 1 ? `(${inner})[]` : `${inner}[]`;
	}
	if (member.shape.length === 0) return "{}";
	const keys = member.shape.map(
		(key) => `${key.name}${key.optional ? "?" : ""}: ${describeType(key.type)}`,
	);
	return `{ ${keys.join(", ")} }`;
};

/** Describes a value for a type error: literal strings and numbers when the type lists literals, otherwise its type. */
export const describeValue = (
	value: unknown,
	type: readonly PropType[],
): string => {
	const plain = unwrap(value);
	if (
		(typeof plain === "string" || typeof plain === "number") &&
		type.some((member) => typeof member === "object" && "literal" in member)
	) {
		return JSON.stringify(plain);
	}
	const name = typeName(value);
	if (name === "null") return "null";
	return `${/^[aeiou]/.test(name) ? "an" : "a"} ${name}`;
};

/** Arrow functions written in templates. Built-ins that take callbacks accept only these, never functions found in data. */
export const templateFunctions = new WeakSet<object>();

/** A class instance prints only when its class exposes `toString`. */
const exposesToString = (value: object): boolean => {
	if (Array.isArray(value) || isPlainObject(value)) return false;
	if (value instanceof Map || value instanceof Set) return false;
	const proto = Object.getPrototypeOf(value) as object | null;
	return proto !== null && exposedMembers(proto).has("toString");
};

/** Converts a value to a string for output, `~` and interpolation. */
export const toStr = (value: unknown): string => {
	switch (typeof value) {
		case "string":
			return value;
		case "number":
			return String(value);
		case "boolean":
			return value ? "true" : "false";
		case "undefined":
			return "";
		case "object": {
			if (value === null) return "";
			if (value instanceof Markup) return value.value;
			if (value instanceof Date) {
				if (Number.isNaN(value.getTime())) {
					return issue("type-error", "Cannot print an invalid date");
				}
				return value.toISOString();
			}
			if (exposesToString(value)) return String(value);
			return issue(
				"not-printable",
				`Cannot print ${typeName(value) === "array" ? "an array" : `a ${typeName(value)}`}. Use a filter such as "join" or "json", or a loop`,
			);
		}
		default:
			return issue("not-printable", `Cannot print a ${typeName(value)}`);
	}
};

/** Strict equality, except that null equals undefined and markup compares by its text. */
export const equals = (left: unknown, right: unknown): boolean => {
	if (left === right) return true;
	if (left == null || right == null) return left == null && right == null;
	if (left instanceof Markup) return equals(left.value, right);
	if (right instanceof Markup) return equals(left, right.value);
	return false;
};

/** Orders two numbers, two strings or two dates. Returns a negative, zero or positive number. */
export const compare = (left: unknown, right: unknown): number => {
	const a = left instanceof Markup ? left.value : left;
	const b = right instanceof Markup ? right.value : right;
	if (typeof a === "number" && typeof b === "number") return a - b;
	if (typeof a === "string" && typeof b === "string") {
		return a < b ? -1 : a > b ? 1 : 0;
	}
	if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
	return issue(
		"type-error",
		`Cannot compare ${typeName(a)} with ${typeName(b)}. Both sides must be numbers, strings or dates`,
	);
};

/** Requires a number, for arithmetic. */
export const toNumber = (value: unknown, operator: string): number => {
	if (typeof value === "number") return value;
	return issue(
		"type-error",
		`"${operator}" needs numbers, but got ${typeName(value) === "array" ? "an array" : `a ${typeName(value)}`}`,
	);
};

/** Converts markup to its string, and leaves other values alone. */
export const unwrap = (value: unknown): unknown =>
	value instanceof Markup ? value.value : value;

/** Requires a string, or markup, which is treated as its text. */
export const toStringArgument = (value: unknown, what: string): string => {
	if (typeof value === "string") return value;
	if (value instanceof Markup) return value.value;
	if (value === null || value === undefined) return "";
	if (typeof value === "number" || typeof value === "boolean") {
		return toStr(value);
	}
	return issue(
		"type-error",
		`${what} needs a string, but got a ${typeName(value)}`,
	);
};
