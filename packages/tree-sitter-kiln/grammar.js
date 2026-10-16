/**
 * @file Tree-sitter grammar for Kiln templates.
 * @license MIT
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

// Expression precedence, loosest first. Mirrors the levels in Kiln's parser.
const PREC = {
	conditional: 1,
	coalesce: 2,
	or: 3,
	and: 4,
	not: 5,
	compare: 6,
	range: 7,
	concat: 8,
	add: 9,
	multiply: 10,
	unary: 11,
	power: 12,
	postfix: 13,
};

/** @typedef {GrammarSymbols<string>} Symbols */

/**
 * One or more `rule`s separated by commas.
 * @param {RuleOrLiteral} rule
 */
const commaSep1 = (rule) => seq(rule, repeat(seq(",", rule)));

/**
 * Zero or more `rule`s separated by commas, with an optional trailing comma.
 * @param {RuleOrLiteral} rule
 */
const commaSepTrailing = (rule) =>
	optional(seq(commaSep1(rule), optional(",")));

/**
 * `{%` or `{%-`, followed by the tag's keyword.
 * @param {string} keyword
 */
const tagOpen = (keyword) => seq(choice("{%", "{%-"), keyword);

/**
 * The `{%` or `{%-` of a branch or end tag, such as `{% else %}`, followed by its keyword.
 * @param {Symbols} $
 * @param {string} keyword
 */
const branchOpen = ($, keyword) =>
	seq(
		choice(alias($._branch_open, "{%"), alias($._branch_open_trim, "{%-")),
		keyword,
	);

/**
 * The end tag of a block, such as `{% endif %}`. Each one is a hidden rule, aliased to `end_clause` where it is used.
 * A node of its own keeps each statement to a single direct `{%`…`%}` pair, which keeps bracket and indent queries
 * simple.
 */
const END_TAGS = [
	"endif",
	"endfor",
	"endset",
	"endblock",
	"endcomponent",
	"endfill",
	"endslot",
	"endmacro",
	"endwith",
	"endapply",
	"endautoescape",
	"endverbatim",
];

/**
 * An `end_clause` for `keyword`, one of `END_TAGS`.
 * @param {Symbols} $
 * @param {string} keyword
 */
const endClause = ($, keyword) => alias($[`_${keyword}`], $.end_clause);

/** `%}` or `-%}`. */
const tagClose = () => choice("%}", "-%}");

module.exports = grammar({
	name: "kiln",

	// The external scanner reads text, raw script/style/verbatim content, HTML comments, and the `{%` that opens a
	// branch or end tag (`else`, `elseif`, `fill`, `end…`). Telling those `{%` apart lets block bodies stay flat
	// lists of siblings without LR conflicts.
	externals: ($) => [
		$.text,
		$.html_comment,
		$._script_raw_text,
		$._style_raw_text,
		$._verbatim_raw_text,
		$._branch_open,
		$._branch_open_trim,
		$._error_sentinel,
	],

	extras: () => [/\s/],

	word: ($) => $.identifier,

	conflicts: ($) => [
		// `(a)` could be a parenthesised expression or the parameter list of `(a) => …`.
		[$._expression, $.parameters],
	],

	rules: {
		template: ($) => repeat($._content),

		_content: ($) =>
			choice(
				$.text,
				$.html_comment,
				$.doctype,
				$.start_tag,
				$.end_tag,
				$.self_closing_tag,
				$.script_element,
				$.style_element,
				$.output,
				$.comment,
				$._statement,
			),

		// HTML. Elements are not nested: start and end tags are siblings, so markup opened in one branch of an `if`
		// and closed in another still parses. Only <script> and <style> group their raw content.

		doctype: () => token(seq("<!", /[a-zA-Z][^>]*/, ">")),

		start_tag: ($) =>
			seq("<", field("name", $.tag_name), repeat($._start_tag_item), ">"),

		self_closing_tag: ($) =>
			seq("<", field("name", $.tag_name), repeat($._start_tag_item), "/>"),

		end_tag: ($) =>
			seq("</", field("name", $.tag_name), repeat($._embedded_kiln), ">"),

		script_element: ($) =>
			seq(
				alias($.script_start_tag, $.start_tag),
				repeat(choice(alias($._script_raw_text, $.raw_text), $._embedded_kiln)),
				$.end_tag,
			),

		style_element: ($) =>
			seq(
				alias($.style_start_tag, $.start_tag),
				repeat(choice(alias($._style_raw_text, $.raw_text), $._embedded_kiln)),
				$.end_tag,
			),

		script_start_tag: ($) =>
			seq(
				"<",
				field("name", alias(/[sS][cC][rR][iI][pP][tT]/, $.tag_name)),
				repeat($._start_tag_item),
				">",
			),

		style_start_tag: ($) =>
			seq(
				"<",
				field("name", alias(/[sS][tT][yY][lL][eE]/, $.tag_name)),
				repeat($._start_tag_item),
				">",
			),

		tag_name: () => /[a-zA-Z][a-zA-Z0-9:._-]*/,

		// Kiln inside a start tag, an attribute value or raw text is kept flat, as generic tags.
		_embedded_kiln: ($) => choice($.output, $.tag_statement, $.comment),

		_start_tag_item: ($) => choice($.attribute, $._embedded_kiln),

		attribute: ($) =>
			seq(
				field("name", $.attribute_name),
				optional(
					seq(
						"=",
						field(
							"value",
							choice($.attribute_value, $.quoted_attribute_value, $.output),
						),
					),
				),
			),

		attribute_name: () => /[^\s"'<>/=`{}%]+/,

		attribute_value: () => /[^\s"'=<>`{}]+/,

		quoted_attribute_value: ($) =>
			choice(
				seq(
					'"',
					repeat(
						choice(
							alias(
								token.immediate(/([^"{]|\{[^"{%#])+|\{/),
								$.attribute_value,
							),
							$._embedded_kiln,
						),
					),
					'"',
				),
				seq(
					"'",
					repeat(
						choice(
							alias(
								token.immediate(/([^'{]|\{[^'{%#])+|\{/),
								$.attribute_value,
							),
							$._embedded_kiln,
						),
					),
					"'",
				),
			),

		// Kiln comments and output.

		comment: () => token(seq("{#", /[^#]*#+([^#}][^#]*#+)*/, "}")),

		output: ($) =>
			seq(
				choice("{{", "{{-"),
				field("value", $._expression),
				choice("}}", "-}}"),
			),

		// Tags.

		_statement: ($) =>
			choice(
				$.if_statement,
				$.for_statement,
				$.set_statement,
				$.set_block,
				$.props_statement,
				$.extends_statement,
				$.block_statement,
				$.include_statement,
				$.component_statement,
				$.slot_statement,
				$.macro_statement,
				$.import_statement,
				$.from_statement,
				$.with_statement,
				$.apply_statement,
				$.autoescape_statement,
				$.verbatim_statement,
				$.tag_statement,
			),

		// Any `{% name … %}`. Used for unknown tags, and for every tag inside start tags, attribute values and raw
		// text, where block tags cannot nest.
		tag_statement: ($) =>
			seq(
				choice("{%", "{%-"),
				field("name", alias($.identifier, $.statement_name)),
				optional(
					seq(
						commaSep1($._expression),
						repeat(
							seq(
								choice("=", "with", "as", "import", "ignore", "missing"),
								optional(commaSep1($._expression)),
							),
						),
					),
				),
				tagClose(),
			),

		if_statement: ($) =>
			seq(
				tagOpen("if"),
				field("condition", $._expression),
				tagClose(),
				repeat($._content),
				repeat(field("alternative", $.elseif_clause)),
				optional(field("alternative", $.else_clause)),
				endClause($, "endif"),
			),

		elseif_clause: ($) =>
			seq(
				branchOpen($, "elseif"),
				field("condition", $._expression),
				tagClose(),
				repeat($._content),
			),

		else_clause: ($) =>
			seq(branchOpen($, "else"), tagClose(), repeat($._content)),

		for_statement: ($) =>
			seq(
				tagOpen("for"),
				optional(seq(field("key", $.identifier), ",")),
				field("value", $.identifier),
				"in",
				field("iterable", $._expression),
				tagClose(),
				repeat($._content),
				optional(field("alternative", $.else_clause)),
				endClause($, "endfor"),
			),

		set_statement: ($) =>
			seq(
				tagOpen("set"),
				field("name", $.identifier),
				"=",
				field("value", $._expression),
				tagClose(),
			),

		set_block: ($) =>
			seq(
				tagOpen("set"),
				field("name", $.identifier),
				tagClose(),
				repeat($._content),
				endClause($, "endset"),
			),

		// Kiln reports a rest prop that isn't last, so the grammar accepts one anywhere.
		props_statement: ($) =>
			seq(
				tagOpen("props"),
				commaSepTrailing(choice($.prop, $.rest_prop)),
				tagClose(),
			),

		prop: ($) =>
			seq(
				field("name", $.identifier),
				optional(seq(":", field("type", $.prop_type))),
				optional(seq("=", field("default", $._expression))),
			),

		// `...attributes`, which collects the variables a template doesn't declare. It comes last.
		rest_prop: ($) => seq("...", field("name", $.identifier)),

		// A union of one or more type terms, such as `string | null`.
		prop_type: ($) => seq($._type_term, repeat(seq("|", $._type_term))),

		_type_term: ($) =>
			choice(
				alias($.identifier, $.type_identifier),
				$.string,
				$.number,
				$.array_type,
				$.shape_type,
				$.parenthesized_type,
			),

		array_type: ($) => seq(field("element", $._type_term), "[", "]"),

		parenthesized_type: ($) => seq("(", $.prop_type, ")"),

		shape_type: ($) => seq("{", commaSepTrailing($.shape_field), "}"),

		shape_field: ($) =>
			seq(
				field(
					"name",
					choice(alias($.identifier, $.property_identifier), $.string),
				),
				choice("?:", seq(optional("?"), ":")),
				field("type", $.prop_type),
			),

		extends_statement: ($) =>
			seq(tagOpen("extends"), field("template", $._expression), tagClose()),

		block_statement: ($) =>
			seq(
				tagOpen("block"),
				field("name", alias($.identifier, $.block_name)),
				choice(
					// Short form: {% block title page.title %}
					seq(field("value", $._expression), tagClose()),
					seq(tagClose(), repeat($._content), endClause($, "endblock")),
				),
			),

		include_statement: ($) =>
			seq(
				tagOpen("include"),
				field("template", $._expression),
				optional(seq("with", field("context", $._expression))),
				optional(seq("ignore", "missing")),
				tagClose(),
			),

		component_statement: ($) =>
			seq(
				tagOpen("component"),
				field("template", $._expression),
				optional(seq("with", field("context", $._expression))),
				tagClose(),
				repeat(choice($._content, $.fill_statement)),
				endClause($, "endcomponent"),
			),

		fill_statement: ($) =>
			seq(
				branchOpen($, "fill"),
				field("name", $.string),
				tagClose(),
				repeat($._content),
				endClause($, "endfill"),
			),

		slot_statement: ($) =>
			seq(
				tagOpen("slot"),
				optional(field("name", $.string)),
				tagClose(),
				repeat($._content),
				endClause($, "endslot"),
			),

		macro_statement: ($) =>
			seq(
				tagOpen("macro"),
				field("name", alias($.identifier, $.macro_name)),
				field("parameters", $.parameters),
				tagClose(),
				repeat($._content),
				endClause($, "endmacro"),
			),

		import_statement: ($) =>
			seq(
				tagOpen("import"),
				field("template", $.string),
				"as",
				field("alias", $.identifier),
				tagClose(),
			),

		from_statement: ($) =>
			seq(
				tagOpen("from"),
				field("template", $.string),
				"import",
				commaSep1($.import_specifier),
				tagClose(),
			),

		import_specifier: ($) =>
			seq(
				field("name", $.identifier),
				optional(seq("as", field("alias", $.identifier))),
			),

		with_statement: ($) =>
			seq(
				tagOpen("with"),
				field("value", $._expression),
				tagClose(),
				repeat($._content),
				endClause($, "endwith"),
			),

		apply_statement: ($) =>
			seq(
				tagOpen("apply"),
				$.filter_call,
				repeat(seq("|", $.filter_call)),
				tagClose(),
				repeat($._content),
				endClause($, "endapply"),
			),

		filter_call: ($) =>
			seq(
				field("name", alias($.identifier, $.filter_identifier)),
				optional(field("arguments", $.arguments)),
			),

		autoescape_statement: ($) =>
			seq(
				tagOpen("autoescape"),
				optional(field("strategy", choice($.string, $.boolean))),
				tagClose(),
				repeat($._content),
				endClause($, "endautoescape"),
			),

		verbatim_statement: ($) =>
			seq(
				tagOpen("verbatim"),
				tagClose(),
				optional(alias($._verbatim_raw_text, $.raw_text)),
				endClause($, "endverbatim"),
			),

		// Expressions.

		_expression: ($) =>
			choice(
				$.identifier,
				$.number,
				$.string,
				$.boolean,
				$.null,
				$.array,
				$.hash,
				$.parenthesized_expression,
				$.unary_expression,
				$.binary_expression,
				$.conditional_expression,
				$.test_expression,
				$.member_expression,
				$.subscript_expression,
				$.call_expression,
				$.filter_expression,
			),

		identifier: () => /[a-zA-Z_][a-zA-Z0-9_]*/,

		number: () => /\d+(_\d+)*(\.\d+(_\d+)*)?/,

		boolean: () => choice("true", "false"),

		null: () => "null",

		string: ($) =>
			choice(
				seq(
					'"',
					repeat(
						choice(
							alias(token.immediate(/([^"\\#]|#[^"\\{])+|#/), $.string_content),
							$.escape_sequence,
							$.interpolation,
						),
					),
					'"',
				),
				seq(
					"'",
					repeat(
						choice(
							alias(token.immediate(/[^'\\]+/), $.string_content),
							$.escape_sequence,
						),
					),
					"'",
				),
			),

		escape_sequence: () =>
			token.immediate(seq("\\", choice(/u\{[0-9a-fA-F]+\}/, "#{", /[^u]|u/))),

		interpolation: ($) =>
			seq(token.immediate("#{"), field("value", $._expression), "}"),

		array: ($) =>
			seq("[", commaSepTrailing(choice($._expression, $.spread)), "]"),

		hash: ($) =>
			seq(
				"{",
				commaSepTrailing(
					choice($.pair, $.spread, alias($.identifier, $.shorthand_property)),
				),
				"}",
			),

		pair: ($) =>
			seq(
				field(
					"key",
					choice(
						alias($.identifier, $.property_identifier),
						$.string,
						$.number,
						$.parenthesized_expression,
					),
				),
				":",
				field("value", $._expression),
			),

		spread: ($) => seq("...", field("value", $._expression)),

		parenthesized_expression: ($) => seq("(", $._expression, ")"),

		unary_expression: ($) =>
			choice(
				prec(
					PREC.not,
					seq(field("operator", "not"), field("argument", $._expression)),
				),
				prec(
					PREC.unary,
					seq(
						field("operator", choice("-", "+")),
						field("argument", $._expression),
					),
				),
			),

		binary_expression: ($) => {
			/** @type {[number, RuleOrLiteral, boolean?][]} */
			const table = [
				[PREC.conditional, "?:", true],
				[PREC.coalesce, "??", true],
				[PREC.or, "or"],
				[PREC.and, "and"],
				[
					PREC.compare,
					choice(
						"==",
						"!=",
						"<",
						">",
						"<=",
						">=",
						"in",
						seq("not", "in"),
						seq("starts", "with"),
						seq("ends", "with"),
					),
				],
				[PREC.range, ".."],
				[PREC.concat, "~"],
				[PREC.add, choice("+", "-")],
				[PREC.multiply, choice("*", "/", "//", "%")],
				[PREC.power, "**", true],
			];
			return choice(
				...table.map(([precedence, operator, right]) => {
					const rule = seq(
						field("left", $._expression),
						field("operator", operator),
						field("right", $._expression),
					);
					return right
						? prec.right(precedence, rule)
						: prec.left(precedence, rule);
				}),
			);
		},

		conditional_expression: ($) =>
			prec.right(
				PREC.conditional,
				seq(
					field("condition", $._expression),
					"?",
					field("consequence", $._expression),
					optional(seq(":", field("alternative", $._expression))),
				),
			),

		// `value is [not] name[(args)]`. Two-word tests such as `divisible by` give two test names.
		test_expression: ($) =>
			prec.left(
				PREC.compare,
				seq(
					field("value", $._expression),
					"is",
					optional("not"),
					field("test", alias($.identifier, $.test_name)),
					optional(field("test", alias($.identifier, $.test_name))),
					optional(field("arguments", $.arguments)),
				),
			),

		member_expression: ($) =>
			prec(
				PREC.postfix,
				seq(
					field("object", $._expression),
					choice(".", "?."),
					field(
						"property",
						choice(
							alias($.identifier, $.property_identifier),
							alias(/\d+/, $.number),
						),
					),
				),
			),

		subscript_expression: ($) =>
			prec(
				PREC.postfix,
				seq(
					field("object", $._expression),
					optional("?."),
					"[",
					field("index", $._expression),
					"]",
				),
			),

		call_expression: ($) =>
			prec(
				PREC.postfix,
				seq(
					field(
						"function",
						choice($.identifier, $.member_expression, $.subscript_expression),
					),
					field("arguments", $.arguments),
				),
			),

		filter_expression: ($) =>
			prec(
				PREC.postfix,
				seq(
					field("value", $._expression),
					"|",
					field("filter", alias($.identifier, $.filter_identifier)),
					optional(field("arguments", $.arguments)),
				),
			),

		arguments: ($) =>
			seq(
				"(",
				commaSepTrailing(
					choice($._expression, $.named_argument, $.spread, $.arrow_function),
				),
				")",
			),

		named_argument: ($) =>
			seq(
				field("name", $.identifier),
				":",
				field("value", choice($._expression, $.arrow_function)),
			),

		arrow_function: ($) =>
			seq(
				field("parameters", choice($.identifier, $.parameters)),
				"=>",
				field("body", $._expression),
			),

		// Parameters of a macro or arrow function. Only macros may give defaults.
		parameters: ($) =>
			seq(
				"(",
				commaSepTrailing(choice($.identifier, $.default_parameter)),
				")",
			),

		default_parameter: ($) =>
			seq(field("name", $.identifier), "=", field("value", $._expression)),

		...Object.fromEntries(
			END_TAGS.map((keyword) => [
				`_${keyword}`,
				($) => {
					// `endblock` and `endmacro` may repeat the name they close.
					const name = { endblock: $.block_name, endmacro: $.macro_name }[
						keyword
					];
					return seq(
						branchOpen($, keyword),
						...(name ? [optional(alias($.identifier, name))] : []),
						tagClose(),
					);
				},
			]),
		),
	},
});
