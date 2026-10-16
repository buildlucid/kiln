import { Liquid } from "liquidjs";
import { asyncFunctions } from "../data.ts";
import type { Engine } from "../engine.ts";
import { helpers } from "../helpers.ts";

/**
 * LiquidJS with in-memory templates, its template cache and `outputEscape: "escape"`, so output is escaped unless it
 * ends in `| raw`. The `date` filter runs in UTC with the en-GB locale, as Kiln does. Prices, thousands separators and
 * URL encoding have no matching built-in, and the built-in `truncate` counts the ellipsis and doesn't trim, so those
 * are registered as filters. Liquid has no function calls, so the async data functions are filters too. The page is
 * parsed once, then rendered with `renderSync`, or `render` in async scenarios.
 */
export const liquidjs: Engine = {
	id: "liquidjs",
	name: "LiquidJS",
	package: "liquidjs",
	homepage: "https://liquidjs.com/",
	extension: ".liquid",
	async: true,
	prepare(templates, options) {
		const liquid = new Liquid({
			templates,
			extname: ".liquid",
			cache: true,
			outputEscape: "escape",
			timezoneOffset: 0,
			locale: "en-GB",
		});
		liquid.registerFilter("formatPrice", helpers.formatPrice);
		liquid.registerFilter("formatNumber", helpers.formatNumber);
		liquid.registerFilter("truncateText", helpers.truncate);
		liquid.registerFilter("urlEncode", helpers.urlEncode);
		for (const [name, fn] of Object.entries(asyncFunctions))
			liquid.registerFilter(name, fn);

		const page = liquid.parseFileSync("page");
		return options.async
			? (data) => liquid.render(page, data)
			: (data) => liquid.renderSync(page, data);
	},
};
