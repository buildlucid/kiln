import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { type IslandManifest, streamIslands } from "@lucidkiln/core";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { product } from "./data.ts";
import { clock, kiln, type RequestState } from "./kiln.ts";

const dist = join(import.meta.dirname, "../dist");
const port = Number(process.env.PORT ?? 4700);

const stateOf = (c: Context): RequestState => ({
	visitor: getCookie(c, "name") ?? null,
});

/** Read on each request, so running the build again needs no restart. */
const manifest = async (): Promise<IslandManifest> =>
	JSON.parse(await readFile(join(dist, "islands.json"), "utf8"));

const app = new Hono();

app.get("/", async (c) =>
	c.html(await kiln.render("pages/index", {}, { state: stateOf(c) })),
);

app.get("/sign-in", (c) => {
	const name = c.req.query("name")?.trim();
	if (name) setCookie(c, "name", name, { path: "/", httpOnly: true });
	return c.redirect(c.req.header("referer") ?? "/");
});

app.get("/sign-out", (c) => {
	deleteCookie(c, "name", { path: "/" });
	return c.redirect(c.req.header("referer") ?? "/");
});

// Static build: the page comes from dist, and each deferred island is rendered here from the manifest.
app.use("/static/*", serveStatic({ root: relative(process.cwd(), dist) }));

app.get("/_islands/:id", async (c) => {
	const islands = await manifest();
	const id = c.req.param("id");
	const island = Object.hasOwn(islands, id) ? islands[id] : undefined;
	if (!island) return c.text("Not found", 404);
	const html = await kiln.render(island.template, island.props, {
		state: stateOf(c),
		signal: c.req.raw.signal,
	});
	c.header("cache-control", "private, no-store");
	c.header("x-robots-tag", "noindex");
	return c.html(html);
});

// Server render: the page streams with fallbacks, and each island follows in the same response. Add ?fail to see a
// failing island end the stream.
app.get("/stream/", async (c) => {
	const stream = await kiln.renderStream(
		"pages/product",
		{
			product,
			mode: "Streamed",
			renderedAt: clock(),
			fail: c.req.query("fail") !== undefined,
		},
		{ islands: streamIslands(), state: stateOf(c), signal: c.req.raw.signal },
	);
	return c.body(stream, 200, { "content-type": "text/html; charset=utf-8" });
});

// The same page with islands rendered in place, for comparison: nothing is sent until the slowest island is done.
app.get("/in-place/", async (c) =>
	c.html(
		await kiln.render(
			"pages/product",
			{ product, mode: "In place", renderedAt: clock(), fail: false },
			{ state: stateOf(c) },
		),
	),
);

app.onError((error, c) => {
	console.error(error);
	return c.text(String(error), 500);
});

serve({ fetch: app.fetch, port }, (info) => {
	console.log(`Islands playground on http://localhost:${info.port}`);
});
