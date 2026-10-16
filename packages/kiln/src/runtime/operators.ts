import { issue } from "../errors.js";
import {
	BLOCKED_NAMES,
	compare,
	equals,
	isPlainObject,
	toNumber,
	toStr,
	typeName,
	unwrap,
} from "./values.js";

/** Builds the inclusive integer array for `a..b` and `range()`, refusing arrays longer than `limit`. */
export const buildRange = (
	start: unknown,
	end: unknown,
	stepValue: unknown,
	limit: number,
): number[] => {
	const from = toNumber(start, "range");
	const to = toNumber(end, "range");
	const step =
		stepValue === undefined || stepValue === null
			? to < from
				? -1
				: 1
			: toNumber(stepValue, "range");
	if (step === 0 || !Number.isFinite(step)) {
		return issue("invalid-argument", "Range step must be a non-zero number");
	}
	if (!Number.isFinite(from) || !Number.isFinite(to)) {
		return issue("invalid-argument", "Range ends must be finite numbers");
	}
	if ((to - from) / step < 0) return [];
	const length = Math.floor((to - from) / step) + 1;
	if (length > limit) {
		return issue(
			"limit-steps",
			`Range of ${length} items is larger than the step limit`,
		);
	}
	// oxlint-disable-next-line unicorn/no-new-array -- preallocates a known length on the hot path
	const result = new Array<number>(length);
	for (let i = 0; i < length; i++) result[i] = from + i * step;
	return result;
};

/** `a..b`: both ends must be integers. */
export const rangeOperator = (
	left: unknown,
	right: unknown,
	limit: number,
): number[] => {
	if (!Number.isInteger(left) || !Number.isInteger(right)) {
		return issue(
			"type-error",
			`".." needs integers, but got ${typeName(left)} and ${typeName(right)}`,
		);
	}
	return buildRange(left, right, undefined, limit);
};

/**
 * `a in b`. `charge` is called with the number of items before an array or set is searched, so templates can't
 * search large lists over and over for free.
 */
export const contains = (
	needle: unknown,
	haystack: unknown,
	charge: (count: number) => void = () => {},
): boolean => {
	const target = unwrap(haystack);
	if (Array.isArray(target)) {
		charge(target.length);
		return target.some((item) => equals(item, needle));
	}
	if (target instanceof Set) {
		if (target.has(needle)) return true;
		charge(target.size);
		for (const item of target) if (equals(item, needle)) return true;
		return false;
	}
	if (typeof target === "string") {
		return target.includes(stringOperand(needle, "in"));
	}
	if (isPlainObject(target)) {
		const key = unwrap(needle);
		if (typeof key !== "string" && typeof key !== "number") return false;
		const name = String(key);
		return !BLOCKED_NAMES.has(name) && Object.hasOwn(target, name);
	}
	if (target instanceof Map) {
		const key = unwrap(needle);
		return (
			!(typeof key === "string" && BLOCKED_NAMES.has(key)) && target.has(key)
		);
	}
	return issue(
		"type-error",
		`"in" needs an array, set, string or hash on its right, but got a ${typeName(target)}`,
	);
};

const stringOperand = (value: unknown, operator: string): string => {
	const unwrapped = unwrap(value);
	if (typeof unwrapped === "string") return unwrapped;
	return issue(
		"type-error",
		`"${operator}" needs strings, but got a ${typeName(unwrapped)}`,
	);
};

/** Applies a binary operator that has no short-circuit behaviour. */
export const binaryOperation = (
	operator: string,
	left: unknown,
	right: unknown,
): unknown => {
	switch (operator) {
		case "==":
			return equals(left, right);
		case "!=":
			return !equals(left, right);
		case "<":
			return compare(left, right) < 0;
		case ">":
			return compare(left, right) > 0;
		case "<=":
			return compare(left, right) <= 0;
		case ">=":
			return compare(left, right) >= 0;
		case "in":
			return contains(left, right);
		case "not in":
			return !contains(left, right);
		case "starts with":
			return stringOperand(left, operator).startsWith(
				stringOperand(right, operator),
			);
		case "ends with":
			return stringOperand(left, operator).endsWith(
				stringOperand(right, operator),
			);
		case "~":
			return toStr(left) + toStr(right);
		case "+":
			return toNumber(left, operator) + toNumber(right, operator);
		case "-":
			return toNumber(left, operator) - toNumber(right, operator);
		case "*":
			return toNumber(left, operator) * toNumber(right, operator);
		case "/":
			return toNumber(left, operator) / toNumber(right, operator);
		case "//":
			return Math.floor(toNumber(left, operator) / toNumber(right, operator));
		case "%":
			return toNumber(left, operator) % toNumber(right, operator);
		case "**":
			return toNumber(left, operator) ** toNumber(right, operator);
		default:
			return issue("invalid-operator", `Unknown operator "${operator}"`);
	}
};

/** Fast paths for the most common operators, so the hot loop avoids the switch. */
export const operatorFunction = (
	operator: string,
): ((left: unknown, right: unknown) => unknown) => {
	switch (operator) {
		case "==":
			return equals;
		case "!=":
			return (left, right) => !equals(left, right);
		case "~":
			return (left, right) =>
				(typeof left === "string" ? left : toStr(left)) +
				(typeof right === "string" ? right : toStr(right));
		case "+":
			return (left, right) =>
				typeof left === "number" && typeof right === "number"
					? left + right
					: toNumber(left, "+") + toNumber(right, "+");
		default:
			return (left, right) => binaryOperation(operator, left, right);
	}
};
