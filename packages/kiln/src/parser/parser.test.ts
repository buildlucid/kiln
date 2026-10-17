import { describe, expect, test } from "vite-plus/test";
import { parse } from "./parser.js";

const options = {
	isTest: (name: string) => ["even", "divisible by"].includes(name),
};

describe("parser", () => {
	test("expressions follow Kiln precedence, with spans", () => {
		const { ast, problems } = parse('{{ "T: " ~ a + b * 2 }}', options);
		expect(problems).toEqual([]);
		expect(ast.body[0]).toMatchInlineSnapshot(`
			{
			  "expression": {
			    "left": {
			      "span": {
			        "end": 8,
			        "start": 3,
			      },
			      "type": "Literal",
			      "value": "T: ",
			    },
			    "operator": "~",
			    "right": {
			      "left": {
			        "name": "a",
			        "span": {
			          "end": 12,
			          "start": 11,
			        },
			        "type": "Name",
			      },
			      "operator": "+",
			      "right": {
			        "left": {
			          "name": "b",
			          "span": {
			            "end": 16,
			            "start": 15,
			          },
			          "type": "Name",
			        },
			        "operator": "*",
			        "right": {
			          "span": {
			            "end": 20,
			            "start": 19,
			          },
			          "type": "Literal",
			          "value": 2,
			        },
			        "span": {
			          "end": 20,
			          "start": 15,
			        },
			        "type": "Binary",
			      },
			      "span": {
			        "end": 20,
			        "start": 11,
			      },
			      "type": "Binary",
			    },
			    "span": {
			      "end": 20,
			      "start": 3,
			    },
			    "type": "Binary",
			  },
			  "span": {
			    "end": 23,
			    "start": 0,
			  },
			  "type": "Output",
			}
		`);
	});

	test("two-word tests and negation", () => {
		const { ast } = parse("{{ n is not divisible by(3) }}", options);
		const output = ast.body[0];
		expect(output?.type === "Output" && output.expression).toMatchObject({
			type: "Test",
			name: "divisible by",
			negated: true,
			args: [{ type: "Positional", value: { type: "Literal", value: 3 } }],
		});
	});

	test("optional chains wrap the whole member chain, and filters end it", () => {
		const { ast } = parse("{{ a?.b.c|upper }}", options);
		const output = ast.body[0];
		expect(output?.type === "Output" && output.expression).toMatchObject({
			type: "Filter",
			name: "upper",
			input: {
				type: "OptionalChain",
				expression: {
					type: "Member",
					optional: false,
					object: { type: "Member", optional: true },
				},
			},
		});
	});

	test("recovers from errors and reports each one", () => {
		const { ast, problems } = parse(
			[
				"{{ 1 + }}",
				"{% if %}ok{% endif %}",
				"{% for x in %}{% endfor %}",
				"{% nope %}",
				"{{ fine }}",
			].join("\n"),
			options,
		);
		expect(problems.map((p) => p.code)).toEqual([
			"unexpected-token",
			"unexpected-token",
			"unexpected-token",
			"unknown-tag",
		]);
		expect(ast.body.some((s) => s.type === "Output")).toBe(true);
		expect(ast.body.filter((s) => s.type === "If")).toHaveLength(1);
	});

	test("a missing end tag is reported at the opening tag", () => {
		const { problems } = parse(
			"{% if a %}{% for x in y %}{% endif %}",
			options,
		);
		expect(problems).toEqual([
			{
				code: "unclosed-block",
				message: '"for" is missing its "endfor" tag',
				span: { start: 10, end: 12 },
			},
		]);
	});
});
