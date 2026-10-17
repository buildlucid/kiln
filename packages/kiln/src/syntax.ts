/**
 * Kiln's parser, for editor tools such as the language server. Node shapes follow the language, so they can change in
 * any minor release. Rendering doesn't need this entry point.
 */
export type {
	Argument,
	BinaryOperator,
	Expression,
	HashEntry,
	Param,
	PropParam,
	PropType,
	ShapeKey,
	Spread,
	Statement,
	TemplateNode,
} from "./parser/ast.js";
export { type ParseOptions, type ParseResult, parse } from "./parser/parser.js";
export type { Span } from "./source.js";
