import { DEFAULT_SLOT } from "../parser/ast.js";
import { Markup } from "../runtime/markup.js";
import { after, locating, step, write } from "../runtime/render.js";
import {
	type CompiledTemplate,
	type EnvironmentCore,
	emptyOut,
	fillScope,
	type RenderInfo,
	type Run,
	type Stmt,
} from "../runtime/types.js";
import { setOwn } from "../runtime/values.js";
import { compileTemplate, emitter } from "./compiler.js";

const hostMark: unique symbol = Symbol("kiln.hostComponent");

/**
 * Renders a component written in JavaScript. Gets the props passed with `with`, each slot the caller filled rendered
 * to markup, and the render's request data.
 */
export type HostRender<State = unknown> = (
	props: Record<string, unknown>,
	slots: Record<string, Markup>,
	render: RenderInfo<State>,
) => unknown;

/** A component written in JavaScript, which a loader returns in place of template source. Create it with `hostComponent`. */
export type HostComponent<State = unknown> = {
	readonly [hostMark]: true;
	/** A method, so a loader can return a component that declares any state. */
	render(...args: Parameters<HostRender<State>>): unknown;
};

/**
 * Wraps a function that renders a component, such as one made with a UI library, so a loader can return it for a
 * name. It should return markup made with `safe`, or a promise of it. A plain string is escaped.
 *
 * ```ts
 * load: (name) => name.endsWith(".tsx") ? hostComponent((props, slots) => safe(renderReact(name, props, slots))) : null
 * ```
 */
export const hostComponent = <State = unknown>(
	render: HostRender<State>,
): HostComponent<State> => ({ [hostMark]: true, render });

export const isHostComponent = (value: unknown): value is HostComponent =>
	typeof value === "object" && value !== null && hostMark in value;

const SPAN = { start: 0, end: 0 };

/**
 * A template whose content is the host component: it renders the caller's fills, then calls the component with the
 * variables passed in and writes what it returns. Everything that renders templates renders it unchanged.
 */
export const compileHost = (
	env: EnvironmentCore,
	name: string,
	component: HostComponent,
): CompiledTemplate => {
	const emit = emitter(env.autoescape);
	const label = `Component "${name}"`;
	const body: Stmt = (run, scope, out) => {
		step(run, SPAN);
		const props: Record<string, unknown> = {};
		for (const key of run.passed ?? []) setOwn(props, key, scope[key]);
		return after(renderFills(run), (slots) =>
			after(
				locating(
					run,
					SPAN,
					() => component.render(props, slots, run.info),
					label,
				),
				(html) => write(run, out, emit(html), SPAN),
			),
		);
	};
	return Object.assign(compileTemplate(env, name, ""), { body, host: true });
};

/**
 * Renders each fill the caller passed where the component is, as a slot would: the content outside fills first, then
 * each fill in order.
 */
const renderFills = (
	run: Run,
): Record<string, Markup> | Promise<Record<string, Markup>> => {
	const slots: Record<string, Markup> = {};
	if (run.slots === null) return slots;
	const fills = [...run.slots].sort(
		([a], [b]) => Number(b === DEFAULT_SLOT) - Number(a === DEFAULT_SLOT),
	);
	const from = (index: number): typeof slots | Promise<typeof slots> => {
		for (let i = index; i < fills.length; i++) {
			const [name, fill] = fills[i] as (typeof fills)[number];
			const out = emptyOut();
			const done = () => setOwn(slots, name, new Markup(out.s, "html"));
			const result = fill.body(
				fill.run.within(run.capture, run.blockDepth),
				fillScope(fill, run),
				out,
			);
			if (result instanceof Promise) {
				return result.then(() => {
					done();
					return from(i + 1);
				});
			}
			done();
		}
		return slots;
	};
	return from(0);
};
