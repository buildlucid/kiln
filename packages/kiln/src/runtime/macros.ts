import type { Span } from "../source.js";
import { suggest } from "../suggest.js";
import { Markup } from "./markup.js";
import {
	after,
	fail,
	importsFor,
	isPromise,
	step,
	withCaller,
} from "./render.js";
import { childScope } from "./scope.js";
import { type CompiledMacro, Run } from "./types.js";

/**
 * Calls a macro: binds arguments to parameters in a scope that holds only globals, renders the body and returns it as markup.
 */
export const callMacro = (
	run: Run,
	span: Span,
	macro: CompiledMacro,
	positional: readonly unknown[],
	named: Readonly<Record<string, unknown>> | null,
): Markup | Promise<Markup> => {
	step(run, span);
	const state = run.state;
	if (run.depth + 1 > state.maxDepth) {
		throw fail(
			run,
			span,
			"limit-depth",
			`Render stopped after nesting ${state.maxDepth} templates, macros or layouts deep`,
		);
	}

	const params = macro.params;
	if (positional.length > params.length) {
		throw fail(
			run,
			span,
			"too-many-arguments",
			`Macro "${macro.name}" takes ${params.length} ${params.length === 1 ? "argument" : "arguments"}, but got ${positional.length}`,
		);
	}
	if (named) {
		for (const key of Object.keys(named)) {
			const index = params.findIndex((param) => param.name === key);
			if (index !== -1 && index < positional.length) {
				throw fail(
					run,
					span,
					"duplicate-argument",
					`Macro "${macro.name}" got "${key}" both by position and by name`,
				);
			}
			if (index === -1) {
				throw fail(
					run,
					span,
					"unknown-argument",
					`Macro "${macro.name}" has no parameter "${key}"`,
					suggest(
						key,
						params.map((param) => param.name),
					),
				);
			}
		}
	}

	const macroRun = new Run(state, macro.template, run.depth + 1, null, null);
	const scope = childScope(state.globals);

	const bind = (index: number): void | Promise<void> => {
		for (let i = index; i < params.length; i++) {
			const param = params[i] as CompiledMacro["params"][number];
			let value: unknown =
				i < positional.length
					? positional[i]
					: named && Object.hasOwn(named, param.name)
						? named[param.name]
						: undefined;
			if ((value === undefined || value === null) && param.default) {
				value = param.default.ev(macroRun, scope);
				if (isPromise(value)) {
					return value.then((resolved) => {
						scope[param.name] = resolved ?? null;
						return bind(i + 1);
					});
				}
			}
			scope[param.name] = value ?? null;
		}
	};

	return after(importsFor(macroRun, macro.template), (imports) => {
		macroRun.imports = imports;
		return after(bind(0), () => {
			const out = { s: "" };
			const render = () =>
				after(
					macro.body(macroRun, scope, out),
					() => new Markup(out.s, macro.strategy || "html"),
				);
			// A macro from another template records where it was called.
			return macro.template === run.template
				? render()
				: withCaller(run, span, render);
		});
	});
};
