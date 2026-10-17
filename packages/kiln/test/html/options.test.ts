import { describe, expect, test } from "vite-plus/test";
import { createKiln, type HtmlChecks, memoryLoader } from "../../src/index.js";
import { check } from "../helpers.js";

const source = '<center><img src="a"><button>Go</button></center>';
const levels = async (htmlChecks?: HtmlChecks) =>
	(await check(source, { htmlChecks })).map((d) => [d.code, d.severity]);

describe("htmlChecks option", () => {
	test("reports every rule as a warning by default", async () => {
		expect(await levels()).toEqual([
			["html-obsolete-element", "warning"],
			["html-img-alt", "warning"],
			["html-button-type", "warning"],
		]);
		expect(await levels(true)).toEqual(await levels());
	});

	test("turns every rule off with false", async () => {
		expect(await levels(false)).toEqual([]);
	});

	test("sets a level for each rule it names", async () => {
		expect(
			await levels({ "html-button-type": "off", "html-img-alt": "error" }),
		).toEqual([
			["html-obsolete-element", "warning"],
			["html-img-alt", "error"],
		]);
	});

	test("does not depend on strict mode", async () => {
		expect(await check(source, { strict: false })).toHaveLength(3);
	});

	test("rejects unknown rules and levels", () => {
		const create = (htmlChecks: unknown) => () =>
			createKiln({
				loader: memoryLoader({}),
				// @ts-expect-error -- testing values TypeScript rejects
				htmlChecks,
			});
		expect(create({ "html-img-alts": "off" })).toThrow(
			'Unknown HTML check "html-img-alts". Did you mean "html-img-alt"?',
		);
		expect(create({ "html-img-alt": "loud" })).toThrow(
			'HTML check "html-img-alt" must be "off", "warning" or "error"',
		);
		expect(create("yes")).toThrow(
			"htmlChecks must be true, false or an object of rule levels",
		);
	});
});
