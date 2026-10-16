; Zed gives later patterns priority, so general patterns come first and specific ones follow.

; Names

(identifier) @variable

((identifier) @variable.special
  (#any-of? @variable.special "loop" "slots"))

(property_identifier) @property

(shorthand_property) @property

(parameters
  (identifier) @variable.parameter)

(default_parameter
  name: (identifier) @variable.parameter)

(arrow_function
  parameters: (identifier) @variable.parameter)

(named_argument
  name: (identifier) @variable.parameter)

(prop
  name: (identifier) @variable.parameter)

(rest_prop
  name: (identifier) @variable.parameter)

(filter_identifier) @function

(test_name) @function

(macro_name) @function

(call_expression
  function: (identifier) @function)

(call_expression
  function: (member_expression
    property: (property_identifier) @function))

(import_specifier
  name: (identifier) @function)

(block_name) @title

(type_identifier) @type

((type_identifier) @type.builtin
  (#any-of? @type.builtin
    "null" "boolean" "number" "string" "array" "hash" "set" "date" "markup" "object"))

; Literals

(string) @string

(escape_sequence) @string.escape

(number) @number

(boolean) @boolean

(null) @constant.builtin

; Operators and punctuation

[
  "=="
  "!="
  "<"
  ">"
  "<="
  ">="
  "+"
  "-"
  "*"
  "/"
  "//"
  "%"
  "**"
  "~"
  ".."
  "??"
  "?:"
  "?"
  "|"
  "="
  "=>"
  "..."
] @operator

[
  ","
  "."
  "?."
  ":"
] @punctuation.delimiter

(conditional_expression
  ":" @operator)

[
  "("
  ")"
  "["
  "]"
  "{"
  "}"
] @punctuation.bracket

; Keywords

[
  "and"
  "or"
  "not"
  "in"
  "is"
  "starts"
  "ends"
  "with"
  "as"
  "ignore"
  "missing"
  "import"
  "if"
  "elseif"
  "else"
  "endif"
  "for"
  "endfor"
  "set"
  "endset"
  "props"
  "extends"
  "block"
  "endblock"
  "include"
  "component"
  "endcomponent"
  "island"
  "endisland"
  "fill"
  "endfill"
  "slot"
  "endslot"
  "macro"
  "endmacro"
  "from"
  "endwith"
  "cache"
  "endcache"
  "outlet"
  "add"
  "endadd"
  "to"
  "once"
  "apply"
  "endapply"
  "autoescape"
  "endautoescape"
  "verbatim"
  "endverbatim"
] @keyword

(statement_name) @keyword

; Kiln delimiters

[
  "{{"
  "{{-"
  "}}"
  "-}}"
  "{%"
  "{%-"
  "%}"
  "-%}"
] @punctuation.special

(interpolation
  [
    "#{"
    "}"
  ] @punctuation.special)

(comment) @comment

; HTML

(tag_name) @tag

(attribute_name) @attribute

(attribute_value) @string

(quoted_attribute_value
  [
    "\""
    "'"
  ] @string)

(attribute
  "=" @punctuation.delimiter)

(start_tag
  [
    "<"
    ">"
  ] @punctuation.bracket)

(self_closing_tag
  [
    "<"
    "/>"
  ] @punctuation.bracket)

(end_tag
  [
    "</"
    ">"
  ] @punctuation.bracket)

(doctype) @tag.doctype

(html_comment) @comment
