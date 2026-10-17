import { issue } from "../errors.js";
import { escapeHtml } from "../runtime/escape.js";
import { Markup } from "../runtime/markup.js";
import { buildRange } from "../runtime/operators.js";
import { checkLength, consume } from "../runtime/render.js";
import type { CallableEntry, Run } from "../runtime/types.js";
import {
	compare,
	isEmpty,
	isHashLike,
	isPlainObject,
	toStr,
	typeName,
	unwrap,
} from "../runtime/values.js";
import {
	entriesOf,
	integerArgument,
	listOf,
	mapContents,
	toDate,
	toPlainData,
} from "./helpers.js";

type BuiltinEntry = Extract<CallableEntry, { kind: "builtin" }>;

const define = (
	call: BuiltinEntry["call"],
	params: readonly string[] = [],
): BuiltinEntry => ({ kind: "builtin", call, params });

/** Attribute names HTML allows: no spaces, quotes, `>`, `/`, `=` or control characters. */
const ATTRIBUTE_NAME = /^[^\s"'>/=\p{Cc}]+$/u;

/** `max` and `min`, of their arguments or of the items of one list or the values of one hash. Charges for the items compared. */
const extremes = (
	run: Run,
	values: unknown[],
	what: string,
	pick: (order: number) => boolean,
): unknown => {
	const [only] = values;
	const items =
		values.length === 1 &&
		(Array.isArray(only) || only instanceof Set || isHashLike(only))
			? entriesOf(run, only, what).values
			: values;
	if (items === values) consume(run, items.length);
	if (items.length === 0) return null;
	let best = items[0];
	for (let i = 1; i < items.length; i++) {
		const item = items[i];
		if (pick(compare(item, best))) best = item;
	}
	return best ?? null;
};

/**
 * Turns one `attrs` value into its attribute text, or null to leave the attribute out. Lists are charged per item,
 * and refused before they are joined if the text would pass `maxOutputLength`.
 */
const attributeValue = (run: Run, value: unknown): string | null => {
	if (value === null || value === undefined || value === false) return null;
	if (Array.isArray(value)) {
		consume(run, value.length);
		const parts = value
			.filter(
				(item) =>
					item !== null && item !== undefined && item !== false && item !== "",
			)
			.map((item) => attributeText(item));
		if (parts.length === 0) return null;
		let length = parts.length - 1;
		for (const part of parts) length += part.length;
		if (length > run.state.maxSize) {
			return issue(
				"limit-output",
				`"attrs" would build a string longer than the output limit of ${run.state.maxSize}`,
			);
		}
		return parts.join(" ");
	}
	return attributeText(value);
};

/** HTML markup is kept, except for `"`, which would end the quoted attribute. */
const attributeText = (value: unknown): string =>
	value instanceof Markup && value.strategy === "html"
		? value.value.replaceAll('"', "&quot;")
		: escapeHtml(toStr(value));

export const builtinFunctions: Record<string, BuiltinEntry> = {
	range: define(
		(run, start, end, step) => {
			const items = buildRange(start, end, step, run.state.maxSteps);
			consume(run, items.length);
			return items;
		},
		["start", "end", "step"],
	),
	max: define((run, ...values) =>
		extremes(run, values, "max", (order) => order > 0),
	),
	min: define((run, ...values) =>
		extremes(run, values, "min", (order) => order < 0),
	),
	cycle: define(
		(run, values, position) => {
			const items = listOf(run, values, "cycle");
			if (items.length === 0) return null;
			const index = integerArgument(position, '"cycle" position');
			return items[((index % items.length) + items.length) % items.length];
		},
		["values", "position"],
	),
	date: define(
		(_run, ...args) => {
			// Only a missing argument means now. A null date stays null, so a missing field never prints as today.
			if (args.length === 0) return new Date();
			const value = args[0];
			return value === null || value === undefined
				? null
				: toDate(value, '"date"');
		},
		["value"],
	),
	attrs: define(
		(run, attributes) => {
			const target = unwrap(attributes);
			if (target === null || target === undefined)
				return new Markup("", "html");
			if (!isPlainObject(target) && !(target instanceof Map)) {
				return issue(
					"type-error",
					`"attrs" needs a hash, but got a ${typeName(target)}`,
				);
			}
			const { values, keys } = entriesOf(run, target, "attrs");
			let html = "";
			keys.forEach((key, index) => {
				const name = String(key);
				if (!ATTRIBUTE_NAME.test(name)) {
					issue("invalid-argument", `"${name}" is not a valid attribute name`);
				}
				const value = values[index];
				if (value === true) {
					html += ` ${name}`;
					return;
				}
				const text = attributeValue(run, value);
				if (text === null) return;
				if (html.length + name.length + text.length + 4 > run.state.maxSize) {
					issue(
						"limit-output",
						`"attrs" would build a string longer than the output limit of ${run.state.maxSize}`,
					);
				}
				html += ` ${name}="${text}"`;
			});
			return new Markup(html, "html");
		},
		["attributes"],
	),
	dump: define((run, ...values) => {
		if (!run.state.env.debug) return new Markup("", "html");
		const data = values.map((value) =>
			toPlainData(value, () => "[Circular]", {
				what: "dump",
				charge: (count) => consume(run, count),
				maxLength: run.state.maxSize,
				indent: 2,
			}),
		);
		const text = checkLength(
			run,
			JSON.stringify(data.length === 1 ? data[0] : data, null, 2) ?? "null",
		);
		return new Markup(
			checkLength(run, `<pre class="kiln-dump">${escapeHtml(text)}</pre>`),
			"html",
		);
	}),
};

export const builtinTests: Record<string, BuiltinEntry> = {
	null: define((_run, value) => value === null || value === undefined),
	// A `Map` is empty when a loop would see no entries in it.
	empty: define((_run, value) =>
		value instanceof Map
			? mapContents(value).keys.length === 0
			: isEmpty(value),
	),
	even: define(
		(_run, value) =>
			typeof value === "number" && Number.isInteger(value) && value % 2 === 0,
	),
	odd: define(
		(_run, value) =>
			typeof value === "number" &&
			Number.isInteger(value) &&
			Math.abs(value % 2) === 1,
	),
	iterable: define((_run, value) => {
		if (value === null || value === undefined || typeof value !== "object")
			return false;
		if (value instanceof Markup) return false;
		return (
			Array.isArray(value) ||
			isPlainObject(value) ||
			typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] ===
				"function"
		);
	}),
	"divisible by": define(
		(_run, value, divisor) => {
			if (typeof value !== "number" || typeof divisor !== "number") {
				return issue("type-error", '"divisible by" needs numbers');
			}
			if (divisor === 0)
				return issue(
					"invalid-argument",
					'"divisible by" cannot divide by zero',
				);
			return value % divisor === 0;
		},
		["divisor"],
	),
};
