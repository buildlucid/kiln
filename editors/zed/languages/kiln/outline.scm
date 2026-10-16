(block_statement
  "block" @context
  name: (block_name) @name) @item

(macro_statement
  "macro" @context
  name: (macro_name) @name) @item

(component_statement
  "component" @context
  template: (_) @name) @item

(fill_statement
  "fill" @context
  name: (string) @name) @item

(slot_statement
  "slot" @context
  name: (string) @name) @item

(slot_statement
  .
  ["{%" "{%-"]
  .
  "slot" @name
  .
  ["%}" "-%}"]) @item

(set_statement
  "set" @context
  name: (identifier) @name) @item

(set_block
  "set" @context
  name: (identifier) @name) @item

(props_statement
  "props" @name) @item

(extends_statement
  "extends" @context
  template: (_) @name) @item

(include_statement
  "include" @context
  template: (_) @name) @item

(import_statement
  "import" @context
  template: (string) @name) @item

(from_statement
  "from" @context
  template: (string) @name) @item
