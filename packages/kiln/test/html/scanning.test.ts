import { describe, expect, test } from "vite-plus/test";
import { check, lines } from "../helpers.js";

const codes = async (source: string, templates?: Record<string, string>) =>
	(await check(source, { templates })).map((d) => d.code);

describe("what HTML checks can see", () => {
	test("skip SVG and MathML content, up to the matching end tag", async () => {
		expect(
			await codes(
				"<svg><font></font><svg><font/></svg><font/></svg><math><tt/></math><center>",
			),
		).toEqual(["html-obsolete-element"]);
	});

	test("skip the content of elements whose content is text", async () => {
		expect(
			await codes(
				'<script>"<center>"</script><style>/* <font> */</style><textarea><img></textarea><title><tt></title>',
			),
		).toEqual([]);
		expect(await codes("<SCRIPT>x</script ><center>")).toEqual([
			"html-obsolete-element",
		]);
	});

	test("skip HTML comments, Kiln comments and verbatim", async () => {
		expect(
			await codes(
				"<!-- <center> -->{# <font> #}{% verbatim %}<tt>{{ x }}</tt>{% endverbatim %}<img {# no alt #} src=a{# end #}>",
			),
		).toEqual(["html-img-alt"]);
	});

	test("skip templates that start with an XML declaration", async () => {
		expect(
			await codes(
				lines(
					"{% props items %}",
					'<?xml version="1.0"?>',
					"<rss><channel><image><url>{{ items }}</url></image></channel></rss>",
				),
			),
		).toEqual([]);
		expect(await codes('<p></p><?xml version="1.0"?><center>')).toEqual([
			"html-obsolete-element",
		]);
	});

	test("skip an element whose name is built at render time", async () => {
		expect(await codes('<{{ tag }} aria-labeledby="x">')).toEqual([]);
	});

	test("read only the template being checked, not what it includes", async () => {
		expect(
			await codes('{% include "partial" %}', { partial: "<center>" }),
		).toEqual([]);
	});

	test("find tags in every block, macro and component body", async () => {
		expect(
			await codes(
				lines(
					"{% block a %}<tt>{% endblock %}",
					"{% macro b() %}<tt>{% endmacro %}",
					'{% component "card" %}<tt>{% fill "x" %}<tt>{% endfill %}{% endcomponent %}',
				),
				{ card: "{% slot %}{% endslot %}" },
			),
		).toEqual([
			"html-obsolete-element",
			"html-obsolete-element",
			"html-obsolete-element",
			"html-obsolete-element",
		]);
	});
});
