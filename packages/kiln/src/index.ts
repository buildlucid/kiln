export type { Analysis, TemplateReference } from "./analyzer.js";
export {
	createKiln,
	type Kiln,
	type KilnCallable,
	type KilnOptions,
	type Limits,
	type Loader,
	memoryLoader,
	type RenderAware,
	type RenderInfo,
	type RenderOptions,
	withRender,
} from "./environment.js";
export {
	type Diagnostic,
	KilnRenderError,
	KilnSyntaxError,
	type TemplateLocation,
} from "./errors.js";
export type { EscapeStrategy, PropType, TypeName } from "./parser/ast.js";
export { expose, lookup } from "./runtime/exposure.js";
export { isSafe, Markup, safe } from "./runtime/markup.js";
export type { AbortSignalLike } from "./runtime/types.js";
export type { Position } from "./source.js";
