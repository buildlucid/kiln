import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deferIslands } from "@lucidkiln/core";
import { product } from "../src/data.ts";
import { clock, kiln } from "../src/kiln.ts";

// The static half of the playground: render the product page once, deferring its islands, and save the manifest the
// server's island route reads.
const dist = join(import.meta.dirname, "../dist");
const islands = deferIslands({ url: "/_islands/" });

const html = await kiln.render(
	"pages/product",
	{ product, mode: "Static build", renderedAt: clock(), fail: false },
	{ islands, state: { visitor: null } },
);

await mkdir(join(dist, "static"), { recursive: true });
await writeFile(join(dist, "static/index.html"), html);
await writeFile(
	join(dist, "islands.json"),
	JSON.stringify(islands.manifest, null, "\t"),
);
console.log(
	`Built dist/static/index.html with ${Object.keys(islands.manifest).length} deferred islands`,
);
