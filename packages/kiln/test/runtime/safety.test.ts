import { describe, expect, test } from "vite-plus/test";
import { expose, lookup } from "../../src/index.js";
import { errorCode, later, render } from "../helpers.js";

describe("hashes and arrays", () => {
	test("prototype properties cannot be read", async () => {
		expect(
			await errorCode("{{ obj.constructor }}", { context: { obj: {} } }),
		).toBe("missing-property");
	});

	test("__proto__ and constructor cannot be read even as own keys", async () => {
		const data = JSON.parse(
			'{"__proto__": {"polluted": true}, "constructor": "x"}',
		) as unknown;
		expect(
			await render(
				'{{ data.__proto__ ?? "blocked" }}|{{ data["constructor"] ?? "blocked" }}',
				{ context: { data } },
			),
		).toBe("blocked|blocked");
	});

	test("__proto__ cannot be used as a hash key, computed key or named argument", async () => {
		expect(await errorCode('{% set h = { "__proto__": { "x": 1 } } %}')).toBe(
			"invalid-key",
		);
		expect(
			await errorCode("{% set h = { (key): 1 } %}", {
				context: { key: "__proto__" },
			}),
		).toBe("invalid-key");
		expect(
			await errorCode("{{ f(__proto__: 1) }}", { functions: { f: () => "" } }),
		).toBe("invalid-key");
	});

	test("templates cannot pollute prototypes", async () => {
		const data = JSON.parse('{"__proto__": {"polluted": true}}') as unknown;
		expect(
			await render("{{ data|merge({ a: 1 })|keys|join }}|{{ data|json }}", {
				context: { data },
			}),
		).toBe("a|{}");
		expect(Object.prototype).not.toHaveProperty("polluted");
	});

	test("array and string methods cannot be called", async () => {
		expect(
			await errorCode('{{ items.join(",") }}', { context: { items: [1] } }),
		).toBe("method-not-exposed");
		expect(
			await errorCode("{{ name.toUpperCase() }}", { context: { name: "x" } }),
		).toBe("method-not-exposed");
	});
});

describe("functions in data", () => {
	const fns = [() => "DATA"];

	test("cannot be read or called", async () => {
		expect(await errorCode("{{ fn }}", { context: { fn: () => "x" } })).toBe(
			"function-value",
		);
		expect(
			await errorCode("{{ obj.fn }}", { context: { obj: { fn: () => "x" } } }),
		).toBe("function-value");
		expect(
			await errorCode("{{ obj.fn() }}", {
				context: { obj: { fn: () => "x" } },
			}),
		).toBe("method-not-exposed");
	});

	test.each([
		"{{ [1, 2]|map(fns|first)|join }}",
		"{{ [1, 2]|map(cycle(fns, 0))|join }}",
		"{{ [1, 2]|filter(nofn ?? (fns|first))|join }}",
		"{{ [1, 2]|sort(fns|slice(0)|first)|join }}",
	])("cannot be passed as callbacks: %s", async (template) => {
		expect(await errorCode(template, { context: { fns, nofn: null } })).toBe(
			"type-error",
		);
	});
});

describe("conversions", () => {
	class Label {
		calls = 0;
		toString() {
			this.calls++;
			return "html";
		}
		toJSON() {
			this.calls++;
			return "html";
		}
	}

	test.each([
		["{{ 1|round(1, label) }}", "type-error"],
		["{{ 1|formatNumber(style: label) }}", "type-error"],
		['{{ "a"|trim(side: label) }}', "invalid-argument"],
		['{{ "a"|escape(label) }}', "unknown-strategy"],
		["{{ block(label) }}", "unknown-block"],
		["{{ none[label] }}", "null-access"],
		["{{ none[label]() }}", "null-access"],
	])("never call unexposed methods: %s", async (template, code) => {
		const label = new Label();
		expect(await errorCode(template, { context: { label, none: null } })).toBe(
			code,
		);
		expect(label.calls).toBe(0);
	});
});

describe("then methods in data", () => {
	class Box {
		static [expose] = ["name"];
		name = "box";
		calls = 0;
		// oxlint-disable-next-line unicorn/no-thenable -- the data this test protects
		then(resolve: (value: unknown) => void) {
			this.calls++;
			resolve({ name: "leaked" });
		}
	}

	test.each([
		"{{ [later(1), box][1].name }}",
		"{{ (later(true) ? box : null).name }}",
		"{{ ([box]|map(item => later(true) ? item : null)|first).name }}",
		"{{ ([box]|find(item => later(true))).name }}",
		"{{ ([box]|reduce((carry, item) => later(true) ? item : carry)).name }}",
	])("are never called, even after waiting: %s", async (template) => {
		const box = new Box();
		expect(
			await render(template, { functions: { later }, context: { box } }),
		).toBe("box");
		expect(box.calls).toBe(0);
	});
});

describe("class instances", () => {
	class Secret {
		password = "hunter2";
		get name() {
			return "n";
		}
		toString() {
			return "secret";
		}
	}

	test("expose nothing by default", async () => {
		const context = { s: new Secret() };
		expect(await errorCode("{{ s.password }}", { context })).toBe(
			"missing-property",
		);
		expect(await errorCode("{{ s.name }}", { context })).toBe(
			"missing-property",
		);
		expect(await errorCode("{{ s }}", { context })).toBe("not-printable");
		expect(await render("{{ s|json }}", { context })).toBe("{}");
	});

	class Base {
		static [expose]: readonly string[] = ["id"];
		id = 7;
	}

	class Post extends Base {
		static override [expose] = ["title", "excerpt", "toString", "constructor"];
		hidden = "no";
		get title() {
			return "Hello world";
		}
		excerpt(length: number) {
			return this.title.slice(0, length);
		}
		override toString() {
			return "Post";
		}
	}

	test("expose lists members to read and methods to call, including inherited ones", async () => {
		expect(
			await render("{{ p.id }}|{{ p.title }}|{{ p.excerpt(5) }}|{{ p }}", {
				context: { p: new Post() },
			}),
		).toBe("7|Hello world|Hello|Post");
	});

	test("json includes only exposed values", async () => {
		expect(
			await render("{{ p|json|raw }}", { context: { p: new Post() } }),
		).toBe('{"title":"Hello world","id":7}');
	});

	test("stay hidden in a variable that held a hash on an earlier pass of a loop", async () => {
		const template =
			'{% for item in items %}{% set s = item %}{% if loop.last and s %}{% endif %}{{ s.password }}{% include "part" %}{% endfor %}';
		expect(
			await errorCode(template, {
				context: { items: [{ password: "open" }, new Secret()] },
				templates: { part: "" },
			}),
		).toBe("missing-property");
	});

	test("unlisted members, blocked names and uncalled methods stay hidden", async () => {
		const context = { p: new Post() };
		expect(await errorCode("{{ p.hidden }}", { context })).toBe(
			"missing-property",
		);
		expect(await errorCode("{{ p.constructor }}", { context })).toBe(
			"missing-property",
		);
		expect(await errorCode("{{ p.excerpt }}", { context })).toBe(
			"function-value",
		);
	});

	test("printing calls the exposed toString, never Symbol.toPrimitive", async () => {
		class Card {
			static [expose] = ["toString"];
			toString() {
				return "public";
			}
			[Symbol.toPrimitive]() {
				return "private";
			}
		}
		class Odd {
			static [expose] = ["toString"];
			toString() {
				return 1;
			}
		}
		expect(
			await render('{{ c }}|{{ c ~ "" }}', { context: { c: new Card() } }),
		).toBe("public|public");
		expect(await errorCode("{{ o }}", { context: { o: new Odd() } })).toBe(
			"not-printable",
		);
	});

	class Fields {
		static [expose] = ["id"];
		id = 1;
		#values = new Map([["heroTitle", "Hero"]]);
		[lookup](name: string) {
			return this.#values.get(name);
		}
	}

	test("lookup answers dynamic names", async () => {
		expect(
			await render("{{ f.id }}|{{ f.heroTitle }}|{{ f.nope ?? 'none' }}", {
				context: { f: new Fields() },
			}),
		).toBe("1|Hero|none");
		expect(
			await errorCode("{{ f.nope }}", { context: { f: new Fields() } }),
		).toBe("missing-property");
	});
});

describe("dangerous names", () => {
	test("set __proto__ does not change any prototype", async () => {
		expect(
			await render(
				'{% set __proto__ = { polluted: 1 } %}{{ polluted ?? "safe" }}',
			),
		).toBe("safe");
	});

	test("blocked names stay blocked when built at render time or read from a map", async () => {
		expect(
			await render('{{ h[("__pro" ~ "to__")] ?? "blocked" }}', {
				context: { h: {} },
			}),
		).toBe("blocked");
		expect(
			await render('{{ m.constructor ?? "blocked" }}', {
				context: { m: new Map([["constructor", 1]]) },
			}),
		).toBe("blocked");
	});

	test("loops and filters skip blocked names in a map", async () => {
		const m = new Map([
			["constructor", "secret"],
			["a", "ok"],
		]);
		expect(
			await render(
				'{% for k, v in m %}{{ k }}={{ v }}{% endfor %}|{{ m|first }}|{{ m|keys|join }}|{{ m|json|raw }}|{{ "constructor" in m ? "found" : "none" }}',
				{ context: { m } },
			),
		).toBe('a=ok|ok|a|{"a":"ok"}|none');
	});

	test("a map holding only blocked names is falsy and gets its default", async () => {
		expect(
			await render('{{ m ? "full" : "empty" }}|{{ m|default("none") }}', {
				context: { m: new Map([["constructor", "secret"]]) },
			}),
		).toBe("empty|none");
	});

	test("arrow functions cannot reach a constructor", async () => {
		expect(await errorCode("{{ [1]|map(x => x.constructor)|first }}")).toBe(
			"missing-property",
		);
	});
});
