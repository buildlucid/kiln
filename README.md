# Kiln

Kiln is a server-side template language for building websites. Its syntax is close to Twig, so it reads naturally to editors, developers and AI models, but Kiln owns its semantics and naming.

- Runs on Node 24 and Cloudflare Workers, with no `eval` or `new Function`.
- Templates can await async data functions, such as `document("page", { fullSlug: route.path })`.
- Safe for templates written in a CMS or by AI agents.
- A language server and VS Code extension ship alongside the engine.

Template files use the `.kiln` extension. The language is documented in [apps/documentation](apps/documentation).

## Usage

```ts
import { createKiln, memoryLoader } from "@lucidcms/kiln";

const kiln = createKiln({
	loader: memoryLoader({
		"layouts/base.kiln": "<title>{% block title %}{% endblock %}</title>{% block content %}{% endblock %}",
		"pages/page.kiln": `{% extends "layouts/base" %}
{% set page = document("page", fullSlug: route.path) %}
{% block title %}{{ page.title }}{% endblock %}
{% block content %}<h1>{{ page.title }}</h1>{% endblock %}`,
	}),
	functions: {
		document: async (collection: string, query: { fullSlug: string }) => ({ title: "Home" }),
	},
});

const html = await kiln.render("pages/page", { route: { path: "/" } });
```

On Node, `fileLoader` from `@lucidcms/kiln/node` reads templates from disk.

## Development

```bash
npm install
npm run build
npm run check
npm test
```

The documentation site lives in `apps/documentation`. Run `npm run dev -w @lucidcms/kiln-documentation` to work on it.

## Licence

[MIT](LICENSE)
