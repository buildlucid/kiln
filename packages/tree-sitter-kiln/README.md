# tree-sitter-kiln

A [Tree-sitter](https://tree-sitter.github.io/) grammar for Kiln templates. It powers the Zed extension in [`editors/zed`](../../editors/zed), which also holds the query files.

## How the tree is shaped

- HTML stays flat. Start tags, end tags and text are siblings, so markup opened in one branch of an `if` and closed in another never produces errors. Only `<script>` and `<style>` group their content, as `raw_text` with Kiln allowed inside.
- Kiln block tags nest. Each one is a statement node, such as `if_statement`, with its body as direct children, `elseif_clause` and `else_clause` for branches, and an `end_clause` for its end tag.
- Inside start tags, attribute values and raw text, Kiln tags can't nest, so each one is a flat `tag_statement`. Unknown tags are `tag_statement` too.
- An external scanner in `src/scanner.c` reads text, raw content and HTML comments. It also marks the `{%` that opens a branch or end tag, which keeps block bodies free of parser conflicts.

## Scripts

```sh
npm run generate   # rebuild src/ from grammar.js
npm test           # corpus tests in test/corpus and highlight tests in test/highlight
npm run parse -- path/to/template.kiln
```

Commit the generated `src/` folder. Zed builds the parser from `src/parser.c` and `src/scanner.c`.

## Licence

MIT
