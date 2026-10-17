# Kiln playground

A Hono app for trying Kiln by hand. It shows one product page with three islands, rendered three ways:

- `/static/`: built once with `deferIslands`. Each island fetches its HTML from `/_islands/:id`.
- `/stream/`: streamed for each request with `streamIslands`. Add `?fail` to see a failing island end the stream.
- `/in-place/`: `render` with no option, for comparison.

The playground uses the built core package, so build it first, then start the app:

```bash
npm run build -w @lucidkiln/core
```

```bash
npm run dev -w @lucidkiln/playground
```

`dev` builds the static page, then serves everything on http://localhost:4700. Run `npx vp run @lucidkiln/playground#build` again after changing a template the static page uses.
