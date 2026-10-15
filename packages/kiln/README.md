<p align="center">
	<img src="assets/banner.png" alt="Kiln: fast, safe templates for server-rendered websites" width="100%">
</p>

# Kiln

Kiln is a template language for building websites on the server. The syntax will feel familiar if you know Twig, Jinja or Liquid.

- **Async data.** Templates can call async functions to load what they need. Kiln only waits where a call returns a promise.
- **Runs anywhere.** No dependencies and no `eval`. Works on Node 24 and Cloudflare Workers.
- **Safe by default.** Templates only read what you give them, output is escaped, and limits stop runaway templates.
- **Layouts and components.** Blocks, includes, components with typed props and slots, and macros.
- **Clear errors.** Strict mode catches typos, and every error shows the template, line and column.

## Install

```bash
npm install @lucidcms/kiln
```

## Usage

`templates/pages/home.kiln`:

```twig
{% extends "layouts/base" %}

{% block content %}
	<h1>{{ title }}</h1>
	<ul>
		{% for post in documents("post", limit: 3) %}
		<li><a href="{{ post.url }}">{{ post.title }}</a></li>
		{% endfor %}
	</ul>
{% endblock %}
```

`render.ts`:

```ts
import { createKiln } from "@lucidcms/kiln";
import { fileLoader } from "@lucidcms/kiln/node";

const kiln = createKiln({
	loader: fileLoader({ root: "templates" }),
	functions: {
		documents: (collection: string, query: { limit: number }) =>
			db.find(collection, query),
	},
});

const html = await kiln.render("pages/home", { title: "Home" });
```

On Cloudflare Workers, use `memoryLoader` from `@lucidcms/kiln` to pass templates in as strings.

## Documentation

The full documentation lives in the [Kiln repository](https://github.com/buildlucid/kiln).

## Licence

[MIT](LICENSE)
