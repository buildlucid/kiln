# Kiln benchmarks

Compares how fast Kiln renders real pages with other JavaScript template engines: Nunjucks, LiquidJS, Twing, Handlebars, EJS, Eta and Pug. The results are written to `results.json`, which the documentation site shows on its Benchmarks page.

## Running

From the repository root:

```bash
npm run bench
```

This builds Kiln, checks every engine's output, benchmarks each engine in its own Node process and writes `results.json`. Commit the new results with the change that caused them.

While working on one engine, run the runner directly from this package:

```bash
node src/run.ts --check --engine nunjucks   # only check Nunjucks renders the same HTML as Kiln
node src/run.ts --engine nunjucks           # benchmark Kiln and Nunjucks, without writing results.json
```

## How it is organised

- `src/scenarios.ts` lists the pages the benchmark renders, and `src/data.ts` builds their data.
- `src/engines/` has one adapter per engine. Each sets the engine up for production and loads templates from memory. Kiln's adapter precompiles its templates before timing starts, as a site's build would, except in the first-render scenario, which times compiling from source.
- `templates/<scenario>/<engine>/` holds each engine's templates. The entry template is always `page` plus the engine's extension.
- `src/helpers.ts` holds helpers for engines that have no built-in with the same output as Kiln's, such as price formatting.

## Rules for templates

- Every engine must render the same HTML as Kiln. The runner checks this before it times anything. Only whitespace and the way quotes are escaped may differ.
- Write templates the way the engine's own documentation recommends. Use its layouts, partials, components and built-in filters.
- Pass the scenario's data through unchanged. Don't move template work into JavaScript.
- `prepare` must build a fresh environment, because the first-render scenario times it.
