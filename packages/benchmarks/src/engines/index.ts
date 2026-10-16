import type { Engine } from "../engine.ts";
import { ejs } from "./ejs.ts";
import { eta } from "./eta.ts";
import { handlebars } from "./handlebars.ts";
import { kiln } from "./kiln.ts";
import { liquidjs } from "./liquidjs.ts";
import { nunjucks } from "./nunjucks.ts";
import { pug } from "./pug.ts";
import { twing } from "./twing.ts";

/** Every engine in the comparison. Kiln comes first: its output is the reference the others are checked against. */
export const engines: Engine[] = [
	kiln,
	nunjucks,
	liquidjs,
	twing,
	handlebars,
	ejs,
	eta,
	pug,
];
