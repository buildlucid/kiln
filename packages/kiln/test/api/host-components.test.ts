import { describe, expect, test } from "vite-plus/test";
import {
	createKiln,
	deferIslands,
	hostComponent,
	type Markup,
	memoryLoader,
	safe,
	streamIslands,
} from "../../src/index.js";
import {
	errorCode,
	later,
	lines,
	readParts,
	render,
	renderError,
	renderStream,
} from "../helpers.js";

/** Renders its props as JSON and each slot in a named element, so tests see exactly what it received. */
const echo = hostComponent((props, slots) =>
	safe(
		JSON.stringify(props) +
			Object.entries(slots)
				.map(([name, html]) => `<${name}>${html.value}</${name}>`)
				.join(""),
	),
);

describe("host components", () => {
	test("a component gets its props and each filled slot as markup", async () => {
		const template = lines(
			'{% component "Echo.tsx" with { title: post.title, count: 2 } %}',
			"<p>{{ post.excerpt }}</p>",
			'{% fill "footer" %}<a href="/more">More</a>{% endfill %}',
			"{% endcomponent %}",
		);
		expect(
			await render(template, {
				templates: { "Echo.tsx": echo },
				context: { post: { title: "Hi", excerpt: "<b>" } },
			}),
		).toBe(
			'{"title":"Hi","count":2}<default><p>&lt;b&gt;</p>\n\n</default><footer><a href="/more">More</a></footer>',
		);
	});

	test("include passes props and no slots", async () => {
		expect(
			await render('{% include "Echo.tsx" with { a: 1 } %}', {
				templates: { "Echo.tsx": echo },
			}),
		).toBe('{"a":1}');
	});

	test("a plain string is escaped, and a promise is waited for", async () => {
		const templates = {
			"Text.tsx": hostComponent(() => "<b>"),
			"Later.tsx": hostComponent(() => later(safe("<i>later</i>"), 5)),
		};
		expect(
			await render('{% include "Text.tsx" %}{% include "Later.tsx" %}', {
				templates,
			}),
		).toBe("&lt;b&gt;<i>later</i>");
	});

	test("fills render before the component, the default slot first, waiting where they wait", async () => {
		const template = lines(
			'{% component "Echo.tsx" %}{{ first() }}',
			'{% fill "second" %}{{ second() }}{% endfill %}',
			"{% endcomponent %}",
		);
		expect(
			await render(template, {
				templates: { "Echo.tsx": echo },
				functions: { first: () => later("1", 5), second: () => "2" },
			}),
		).toBe("{}<default>1\n\n</default><second>2</second>");
	});

	test("content an unused fill adds to an outlet still arrives", async () => {
		const template = lines(
			'<head>{% outlet "head" %}</head>',
			'{% component "Empty.tsx" %}{% add to "head" %}<style></style>{% endadd %}{% endcomponent %}',
		);
		expect(
			await render(template, {
				templates: {
					"Empty.tsx": hostComponent(() => safe("<x-empty></x-empty>")),
				},
			}),
		).toBe("<head><style></style></head>\n<x-empty></x-empty>");
	});

	test("it gets the render's request data", async () => {
		const kiln = createKiln<{ user: string }>({
			loader: memoryLoader({
				page: '{% include "User.tsx" %}',
				"User.tsx": hostComponent<{ user: string }>((_props, _slots, info) =>
					safe(`${info.state.user} ${info.template}`),
				),
			}),
		});
		expect(await kiln.render("page", {}, { state: { user: "ada" } })).toBe(
			"ada User.tsx",
		);
	});

	test("strict mode doesn't check its props", async () => {
		expect(
			await render('{% include "Echo.tsx" with { any: true } %}', {
				templates: { "Echo.tsx": echo },
				strict: true,
			}),
		).toBe('{"any":true}');
	});

	test("render renders one with the context as its props", async () => {
		const kiln = createKiln({ loader: memoryLoader({ "Echo.tsx": echo }) });
		expect(await kiln.render("Echo.tsx", { id: 7 })).toBe('{"id":7}');
	});

	test("deferred islands render from their manifest entry", async () => {
		const islands = deferIslands({ url: "/islands/", script: false });
		const kiln = createKiln({
			loader: memoryLoader({
				page: '{% island "Echo.tsx" with { id: 7 } %}…{% endisland %}',
				"Echo.tsx": echo,
			}),
		});
		await kiln.render("page", {}, { islands });
		const [entry] = Object.values(islands.manifest);
		expect(entry?.template).toBe("Echo.tsx");
		expect(await kiln.render(entry?.template ?? "", entry?.props)).toBe(
			'{"id":7}',
		);
	});

	test("streamed islands render after the page", async () => {
		const stream = await renderStream(
			'{% island "Echo.tsx" with { id: 7 } %}…{% endisland %}',
			{
				templates: { "Echo.tsx": echo },
				islands: streamIslands({ script: false }),
			},
		);
		expect((await readParts(stream)).join("")).toContain(
			'<template>{"id":7}</template><kiln-island fill="1">',
		);
	});

	test("an error it throws is a host error, located at the caller", async () => {
		const error = await renderError('\n{% include "Fail.tsx" %}', {
			templates: {
				"Fail.tsx": hostComponent(() => {
					throw new Error("boom");
				}),
			},
		});
		expect(error.message).toContain(
			'Component "Fail.tsx" threw an error: boom',
		);
		expect(error).toMatchObject({
			code: "host-error",
			templateStack: [
				{ template: "index.kiln", line: 2 },
				{ template: "Fail.tsx" },
			],
		});
	});

	test("it can't be extended or imported", async () => {
		const templates = { "Echo.tsx": echo };
		expect(await errorCode('{% extends "Echo.tsx" %}', { templates })).toBe(
			"not-a-template",
		);
		expect(
			await errorCode('{% import "Echo.tsx" as ui %}{{ ui.card() }}', {
				templates,
			}),
		).toBe("not-a-template");
	});

	test("slots are markup", async () => {
		let received: Record<string, Markup> = {};
		await render('{% component "Spy.tsx" %}<p></p>{% endcomponent %}', {
			templates: {
				"Spy.tsx": hostComponent((_props, slots) => {
					received = slots;
					return "";
				}),
			},
		});
		expect(received.default).toMatchObject({
			value: "<p></p>",
			strategy: "html",
		});
	});
});
