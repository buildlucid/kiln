# Kiln for VS Code

Support for [Kiln](https://kilnlang.com) templates in VS Code, Cursor, Windsurf and VSCodium.

- Syntax highlighting for Kiln and the HTML around it, including Kiln inside attribute values, with JavaScript in `<script>` and CSS in `<style>`.
- A file icon for `.kiln` files, which shows when your icon theme doesn't have one.
- Comment toggling with `{# #}`, bracket matching, auto-closing for `{{` and `{%`, folding for block tags, and indenting as you type.
- Snippets for each block tag, such as `for` and `component`.
- Kiln's language server: errors as you type, formatting, completions, hover, go to definition, links and an outline.

The language server comes with the extension and runs on VS Code's own Node. When your project has Kiln installed, the server uses that version, so its errors match how your templates render.

## Settings

To format when you save:

```json
{
	"[kiln]": {
		"editor.defaultFormatter": "buildlucid.kiln",
		"editor.formatOnSave": true
	}
}
```

To use Tailwind CSS class completion and Emmet abbreviations in templates:

```json
{
	"tailwindCSS.includeLanguages": { "kiln": "html" },
	"emmet.includeLanguages": { "kiln": "html" }
}
```

The language server reads your project's functions, filters, globals and template folder from a `kiln.json` file. See [Editors](https://kilnlang.com/docs/tooling/editors/) in the Kiln docs.
