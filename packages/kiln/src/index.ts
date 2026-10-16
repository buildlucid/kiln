export type { AnalysedProp, Analysis, TemplateReference } from "./analyzer.js";
export {
	createKiln,
	type Kiln,
	type KilnCallable,
	type KilnOptions,
	type KilnTemplates,
	type KilnTypes,
	type Limits,
	type Loader,
	memoryLoader,
	type RenderAware,
	type RenderInfo,
	type RenderOptions,
	type TemplateBlock,
	type TemplateContext,
	type TemplateName,
	type TypeChecks,
	withRender,
} from "./environment.js";
export type { PrecompiledTemplate } from "./compiler/precompiled.js";
export {
	type Diagnostic,
	KilnRenderError,
	KilnSyntaxError,
	type TemplateLocation,
} from "./errors.js";
export type {
	EscapeStrategy,
	PropType,
	ShapeKey,
	TypeName,
} from "./parser/ast.js";
export { expose, lookup } from "./runtime/exposure.js";
export { isSafe, Markup, safe } from "./runtime/markup.js";
export type { AbortSignalLike } from "./runtime/types.js";
export type { Position } from "./source.js";
export { generateTypes } from "./typegen.js";
