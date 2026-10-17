import type { Effects } from "../compiler/effects.js";
import type { Span } from "../source.js";
import { moveOutlets } from "./outlets.js";
import { write } from "./render.js";
import { ownerOf } from "./scope.js";
import {
	additionLog,
	type Behind,
	Capture,
	type Out,
	type RenderState,
	type Run,
	type Scope,
	type Stmt,
} from "./types.js";

/*
 * Running ahead.
 *
 * When part of a render waits for a promise, the parts after it that don't depend on it start straight away, so their
 * own waits overlap with it. Which parts may is found when compiling; see `compiler/effects.ts`.
 *
 * The part that waits keeps its output buffer. The parts running ahead write to a buffer of their own, and add to
 * outlets in a capture of their own, which takes its place in the outlets' log once the part before it is done. Their
 * output joins the part's once both are done, so the page and every outlet get content in the template's order,
 * however the promises settle.
 *
 * What depends on everything before it in the page waits until all of that is done: an outlet's place, a `flush`,
 * an island and whether it brings the island script. See `atFront`.
 *
 * A page's layout starts while the page's top-level statements wait, and its top-level statements that touch their
 * variables wait for them. See `Gate`.
 */

/** The most parts of one render that run ahead at once. Beyond it, parts wait their turn as they would otherwise. */
export const MAX_AHEAD = 64;

const NOTHING = (): void => {};

/** Whether parts may start early ahead of a part that waits: the render runs fewer parts ahead than it may. */
export const mayRunAhead = (state: RenderState): boolean =>
	state.ahead < MAX_AHEAD;

/**
 * Starts `rest` while `pending`, the promise of the part before it, waits, and returns a promise for both. Rejects with
 * the part's error when it fails, or else with the rest's, after both settle, so a failed render has nothing still
 * running. Only call it when `mayRunAhead` allows.
 */
export const runAhead = (
	run: Run,
	out: Out,
	pending: Promise<void>,
	rest: (run: Run, out: Out) => void | Promise<void>,
	span: Span,
): Promise<void> => {
	const state = run.state;
	state.ahead++;
	const log = additionLog(run);
	const outer = run.capture;
	const capture = new Capture(log, outer?.section ?? null, {
		part: pending,
		previous: outer?.behind ?? null,
	});
	const ahead: Out = { s: "", ahead: out.ahead ?? { base: out, size: 0 } };
	return new Promise<void>((resolve, reject) => {
		let left = 2;
		let failure: { error: unknown } | null = null;
		const settle = () => {
			if (--left !== 0) return;
			state.ahead--;
			if (failure !== null) return reject(failure.error);
			try {
				(ahead.ahead as NonNullable<Out["ahead"]>).size -= ahead.s.length;
				const offset = out.s.length;
				write(run, out, ahead.s, span);
				moveOutlets(state, ahead, out, offset);
				resolve();
			} catch (error) {
				reject(error);
			}
		};
		// The rest's capture goes in the log once the part is done, after everything the part added. Registered before
		// the rest starts, so it is in place before anything in the rest that waits for the part.
		pending.then(
			() => {
				log.push(capture);
				settle();
			},
			(error: unknown) => {
				log.push(capture);
				// The part comes first in the template, so its error wins.
				failure = { error };
				settle();
			},
		);
		let result: void | Promise<void>;
		try {
			result = rest(run.within(capture), ahead);
		} catch (error) {
			result = Promise.reject(error);
		}
		if (result === undefined) settle();
		else {
			result.then(settle, (error: unknown) => {
				failure ??= { error };
				settle();
			});
		}
	});
};

/**
 * Which later statements of a list may start while each statement waits. For statement `i`, statements `i + 1` to
 * `after[i]` depend on it, directly or through each other, so they run once it is done. Statements `after[i] + 1` to
 * `reach[i]` depend on none of those, so they start at once. When nothing may start early, both are `i`.
 */
export type Plan = {
	readonly after: readonly number[];
	readonly reach: readonly number[];
};

/**
 * A list of statements, each of which may let others start early while it waits. `plan` gives the plan for a render,
 * with each statement's span, for errors where parts join. It is only worked out the first time a statement waits, so
 * renders that never wait spend no time on it. With `gated`, the plan counts every statement as one that may wait,
 * since any may wait for a `Gate`. `clear` is whether a statement can run in either order with statements that have
 * `effects`.
 */
export type Sequence = {
	readonly statements: readonly Stmt[];
	readonly plan: (
		run: Run,
		gated: boolean,
	) => Plan & { readonly spans: readonly Span[] };
	readonly clear: (run: Run, index: number, effects: Effects) => boolean;
};

/**
 * A page's top-level statements, still waiting while its layout starts: their promise, and what they read and set. A
 * top-level statement of the layout that touches their variables waits for `part`. `previous` is the gate of the page
 * below, when the page is a layout itself. `done` once `part` fulfils.
 */
export type Gate = {
	readonly part: Promise<void>;
	readonly effects: Effects;
	readonly previous: Gate | null;
	done: boolean;
};

/** A gate for `part`, which marks itself done once `part` fulfils. */
export const gateFor = (
	part: Promise<void>,
	effects: Effects,
	previous: Gate | null,
): Gate => {
	const gate: Gate = { part, effects, previous, done: false };
	part.then(() => {
		gate.done = true;
	}, NOTHING);
	return gate;
};

/** Runs statement `index` of a sequence, once the gates whose statements it touches are done. */
const runGated = (
	sequence: Sequence,
	index: number,
	gate: Gate,
	run: Run,
	scope: Scope,
	out: Out,
): void | Promise<void> => {
	const statement = sequence.statements[index] as Stmt;
	let waits: Promise<unknown> | null = null;
	for (let at: Gate | null = gate; at !== null; at = at.previous) {
		if (at.done || sequence.clear(run, index, at.effects)) continue;
		waits = waits === null ? at.part : Promise.all([waits, at.part]);
	}
	if (waits === null) return statement(run, scope, out);
	return waits.then(() => statement(run, scope, out));
};

/**
 * Runs a sequence's statements `index` to `last` in order, waiting only when one returns a promise. While one waits,
 * the statements its plan lets start early run ahead of it, see `runAhead`, while the ones that depend on it run once
 * it is done. The rest run once those are done. With a `gate`, each statement first waits for the gates it touches.
 */
export const runSequence = (
	sequence: Sequence,
	index: number,
	last: number,
	run: Run,
	scope: Scope,
	out: Out,
	gate: Gate | null,
): void | Promise<void> => {
	const statements = sequence.statements;
	for (let i = index; i <= last; i++) {
		const result =
			gate === null
				? (statements[i] as Stmt)(run, scope, out)
				: runGated(sequence, i, gate, run, scope, out);
		if (result === undefined) continue;
		const plan = sequence.plan(run, gate !== null);
		const after = Math.min(plan.after[i] as number, last);
		const end = Math.min(plan.reach[i] as number, last);
		if (end > after && mayRunAhead(run.state)) {
			const pending =
				after > i
					? result.then(() =>
							runSequence(sequence, i + 1, after, run, scope, out, gate),
						)
					: result;
			const joined = runAhead(
				run,
				out,
				pending,
				(ahead, aheadOut) =>
					runSequence(sequence, after + 1, end, ahead, scope, aheadOut, gate),
				plan.spans[i] as Span,
			);
			return end === last
				? joined
				: joined.then(() =>
						runSequence(sequence, end + 1, last, run, scope, out, gate),
					);
		}
		return result.then(() =>
			runSequence(sequence, i + 1, last, run, scope, out, gate),
		);
	}
};

/** Runs one pass of a loop, given its index, in the render and output given. */
export type Pass = (run: Run, out: Out, index: number) => void | Promise<void>;

/**
 * Runs passes `from` to `to` of a loop in order, waiting only when one returns a promise. Then the passes after it
 * continue as `passesFrom` runs them. `ahead` is whether the loop's passes may run ahead of each other.
 */
export const runPasses = (
	run: Run,
	out: Out,
	from: number,
	to: number,
	pass: Pass,
	span: Span,
	ahead: boolean,
): void | Promise<void> => {
	for (let index = from; index < to; index++) {
		const result = pass(run, out, index);
		if (result === undefined) continue;
		return index + 1 < to
			? passesFrom(run, out, result, index + 1, to, pass, span, ahead)
			: result;
	}
};

/**
 * Runs passes `from` to `to` of a loop, which come after `pending`, a pass that waits. When `ahead`, they start at
 * once: each pass that waits lets the passes after it start in a buffer and capture of their own, and every buffer
 * joins `out` in order once all the passes are done. Otherwise, or when `mayRunAhead` refuses, they run once the pass
 * is done. Rejects with the first error in the loop's order, once every pass started is done.
 */
export const passesFrom = (
	run: Run,
	out: Out,
	pending: Promise<void>,
	from: number,
	to: number,
	pass: Pass,
	span: Span,
	ahead: boolean,
): Promise<void> => {
	const state = run.state;
	if (!ahead || !mayRunAhead(state)) {
		return pending.then(() => runPasses(run, out, from, to, pass, span, ahead));
	}
	const log = additionLog(run);
	const outer = run.capture;
	const section = outer?.section ?? null;
	const group = out.ahead ?? { base: out, size: 0 };
	// Segment k holds the passes after the one waiting at the end of segment k - 1. Segment 0 is `out`.
	const segments: Out[] = [];
	const captures: Capture[] = [];
	// The last part waiting at the end of a segment, which every later segment runs ahead of.
	let behind: Behind | null = outer?.behind ?? null;
	const settled: boolean[] = [];
	let linked = 0;
	let left = 0;
	let failure: { error: unknown; at: number } | null = null;
	let resolve = NOTHING;
	let reject: (error: unknown) => void = NOTHING;
	const joined = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	const fail = (at: number, error: unknown) => {
		if (failure === null || at < failure.at) failure = { error, at };
	};
	const finish = () => {
		state.ahead -= segments.length;
		if (failure !== null) return reject(failure.error);
		try {
			for (const segment of segments) {
				group.size -= segment.s.length;
				const offset = out.s.length;
				write(run, out, segment.s, span);
				moveOutlets(state, segment, out, offset);
			}
			resolve();
		} catch (error) {
			reject(error);
		}
	};
	const watch = (part: Promise<void>, at: number) => {
		left++;
		behind = { part, previous: behind };
		const done = () => {
			settled[at] = true;
			// Each segment's capture goes in the log once the part before it is done, after every capture before it.
			while (linked < captures.length && settled[linked] === true) {
				log.push(captures[linked++] as Capture);
			}
			if (--left === 0) finish();
		};
		part.then(done, (error: unknown) => {
			fail(at, error);
			done();
		});
	};
	watch(pending, 0);
	let index = from;
	while (index < to) {
		const at = segments.length + 1;
		state.ahead++;
		const capture = new Capture(log, section, behind);
		const segment: Out = { s: "", ahead: group };
		const segmentRun = run.within(capture);
		segments.push(segment);
		captures.push(capture);
		let waiting: void | Promise<void> = undefined;
		try {
			for (; index < to; index++) {
				waiting = pass(segmentRun, segment, index);
				if (waiting !== undefined) {
					index++;
					break;
				}
			}
		} catch (error) {
			fail(at, error);
			break;
		}
		if (waiting === undefined) break;
		if (index < to && state.ahead >= MAX_AHEAD) {
			// No more parts may run ahead, so the rest of the passes run in this segment once its pass is done.
			const next = index;
			waiting = waiting.then(() =>
				runPasses(segmentRun, segment, next, to, pass, span, true),
			);
			index = to;
		}
		watch(waiting, at);
	}
	return joined;
};

/**
 * Whether content placed from elsewhere in `run` may set variables: any version of any block in the render, since
 * blocks place each other through `parent()` and `block()`, or a fill the caller passed. Such content may set any
 * variable that exists, so parts that place it can't start early, nor can parts that read or set anything around it.
 * See `Effects`.
 */
export const contentSets = (run: Run): boolean => {
	for (const entries of run.blocks.values()) {
		for (const entry of entries) if (entry.def.sets) return true;
	}
	if (run.slots !== null) {
		for (const fill of run.slots.values()) if (fill.sets) return true;
	}
	return false;
};

/**
 * Whether a loop's passes may run ahead of each other: when none of the variables its body sets, `sets`, is in `scope`
 * around the loop, and content from elsewhere the body places, when `elsewhere`, sets none. Then each pass sets its
 * own, in a scope of its own, and no pass depends on another.
 */
export const passesAhead = (
	run: Run,
	scope: Scope,
	sets: readonly string[],
	elsewhere: boolean,
): boolean => {
	if (elsewhere && contentSets(run)) return false;
	for (const name of sets) if (ownerOf(scope, name) !== null) return false;
	return true;
};

/**
 * Runs `work` once every part of the render before `run`'s is done, for what depends on all of it, such as where an
 * outlet stands. Runs it at once in parts that don't run ahead. When a part before failed, the render fails with its
 * error, so `work` never runs and makes no changes, such as closing outlets or deferring an island.
 */
export const atFront = <T>(
	run: Run,
	work: () => T | Promise<T>,
): T | Promise<T> => {
	let behind = run.capture?.behind ?? null;
	if (behind === null) return work();
	const parts: Promise<void>[] = [];
	for (; behind !== null; behind = behind.previous) parts.push(behind.part);
	return Promise.allSettled(parts).then((results) => {
		for (const result of results) {
			if (result.status === "rejected") throw result.reason;
		}
		return work();
	});
};

/** Whether `out` is the render's output, or output running ahead that joins it. */
export const isRoot = (state: RenderState, out: Out): boolean =>
	out === state.root || (out.ahead !== null && out.ahead.base === state.root);
