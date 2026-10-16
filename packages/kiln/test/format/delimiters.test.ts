import { describe, expect, test } from "vite-plus/test";
import { format } from "../../src/format.js";

/** Formats one line and drops the final line break. */
const line = (source: string) => format(source).slice(0, -1);

describe("format: spacing inside delimiters", () => {
	test("puts one space inside outputs and tags, and keeps trim markers", () => {
		expect(line("{{x}}{%if  a%}{%endif%}")).toBe(
			"{{ x }}{% if a %}{% endif %}",
		);
		expect(line("{{-x-}}{%- if a -%}{%endif%}")).toBe(
			"{{- x -}}{%- if a -%}{% endif %}",
		);
	});

	test("spaces operators, including a conditional's ? and :", () => {
		expect(line("{{ a==b }}{{ a~b }}{{ a??b }}{{ a?b:c }}{{ a?:b }}")).toBe(
			"{{ a == b }}{{ a ~ b }}{{ a ?? b }}{{ a ? b : c }}{{ a ?: b }}",
		);
		expect(line("{% set a=1 %}{{ items|map(x=>x*2) }}")).toBe(
			"{% set a = 1 %}{{ items|map(x => x * 2) }}",
		);
	});

	test("writes ., ?., | and .. without spaces", () => {
		expect(line("{{ post . title | upper }}{{ a ?. b }}{{ 1 .. 10 }}")).toBe(
			"{{ post.title|upper }}{{ a?.b }}{{ 1..10 }}",
		);
	});

	test("writes brackets and calls without inner spaces", () => {
		expect(
			line("{{ range( 1 , 3 ) }}{{ items [ 0 ] }}{{ ( a + b ) * c }}"),
		).toBe("{{ range(1, 3) }}{{ items[0] }}{{ (a + b) * c }}");
		expect(line("{{ not (a or b) }}{{ a in [1,2] }}")).toBe(
			"{{ not (a or b) }}{{ a in [1, 2] }}",
		);
	});

	test("spaces commas and colons after, not before", () => {
		expect(line('{{ fn(a ,limit : 3) }}{{ { "a" :1 } }}')).toBe(
			'{{ fn(a, limit: 3) }}{{ { "a": 1 } }}',
		);
	});

	test("spaces the inside of a hash, but not an empty one", () => {
		expect(line("{{ {a: 1, ...rest} }}{{ {} }}")).toBe(
			"{{ { a: 1, ...rest } }}{{ {} }}",
		);
	});

	test("writes signs against their number", () => {
		expect(line("{{ - 1 + - a * ( 2 - b ) }}")).toBe("{{ -1 + -a * (2 - b) }}");
	});

	test("spaces | between types in props", () => {
		expect(
			line(
				'{% props variant: "a"|"b" = "a", link: { url: string, label ?: string } = null, items: Post[] = [] %}',
			),
		).toBe(
			'{% props variant: "a" | "b" = "a", link: { url: string, label?: string } = null, items: Post[] = [] %}',
		);
	});

	test("leaves strings as written", () => {
		expect(line(`{{ 'it\\'s' ~ "a #{ b|upper }" }}`)).toBe(
			`{{ 'it\\'s' ~ "a #{ b|upper }" }}`,
		);
	});

	test("keeps line breaks and indents the lines after them", () => {
		expect(
			format(
				'{% include "card" with {\ntitle: post.title,\nurl: post.url,\n} %}',
			),
		).toBe(
			'{% include "card" with {\n\ttitle: post.title,\n\turl: post.url,\n} %}\n',
		);
		expect(format("<div>\n{% if a\nand b %}\nx\n{% endif %}\n</div>")).toBe(
			"<div>\n\t{% if a\n\t\tand b %}\n\t\tx\n\t{% endif %}\n</div>\n",
		);
	});

	test("brackets opened on one line add one step", () => {
		expect(format("{% set data = { posts: [\n1,\n] } %}")).toBe(
			"{% set data = { posts: [\n\t1,\n] } %}\n",
		);
	});
});
