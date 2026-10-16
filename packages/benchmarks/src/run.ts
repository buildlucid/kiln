/**
 * Runs the benchmark and writes `results.json`.
 *
 * node src/run.ts                  check every engine's output, benchmark them all and write results.json
 * node src/run.ts --check          only check that every engine renders the same HTML as Kiln
 * node src/run.ts --engine nunjucks  check and benchmark Kiln and Nunjucks, without writing results.json
 *
 * Each engine is benchmarked in its own Node process, so one engine's warm-up and garbage can't slow another down.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Bench } from "tinybench";
import { difference, normalise } from "./compare.ts";
import { type Engine, readTemplates } from "./engine.ts";
import { engines } from "./engines/index.ts";
import { type Scenario, scenarios } from "./scenarios.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Time spent measuring each engine in each scenario, after warming up. */
const BENCH_TIME = 1000;
const WARMUP_TIME = 250;

type Measurement = {
	opsPerSecond: number;
	meanMs: number;
	p99Ms: number;
	/** Relative margin of error, as a percentage. */
	rme: number;
	samples: number;
};

type Result =
	| ({ engine: string; supported: true; relative: number } & Measurement)
	| { engine: string; supported: false };

const templatesFor = (scenario: Scenario, engine: Engine) =>
	readTemplates(join(root, "templates", scenario.templates, engine.id));

const supports = (engine: Engine, scenario: Scenario) =>
	engine.async || !scenario.async;

/** Renders every scenario with every engine and checks the HTML matches Kiln's. Returns the problems found. */
const check = async (selected: Engine[]) => {
	const problems: string[] = [];
	for (const scenario of scenarios) {
		let expected: string | undefined;
		for (const engine of selected) {
			if (!supports(engine, scenario)) continue;
			try {
				const render = await engine.prepare(
					await templatesFor(scenario, engine),
					scenario,
				);
				const html = normalise(await render(scenario.data));
				expected ??= html;
				const diff = difference(expected, html);
				if (diff) problems.push(`${scenario.id} / ${engine.id}:\n${diff}`);
			} catch (error) {
				problems.push(`${scenario.id} / ${engine.id}: ${String(error)}`);
			}
		}
	}
	return problems;
};

/** Benchmarks one engine in every scenario it supports. Runs in a child process. */
const measure = async (engine: Engine) => {
	const measurements: Record<string, Measurement> = {};
	for (const scenario of scenarios) {
		if (!supports(engine, scenario)) continue;
		const templates = await templatesFor(scenario, engine);
		const { data } = scenario;
		const bench = new Bench({ time: BENCH_TIME, warmupTime: WARMUP_TIME });
		if (scenario.cold) {
			bench.add(scenario.id, async () => {
				const render = await engine.prepare(templates, scenario);
				await render(data);
			});
		} else {
			const render = await engine.prepare(templates, scenario);
			bench.add(scenario.id, () => render(data));
		}
		await bench.run();
		const result = bench.tasks[0]?.result;
		if (result?.state !== "completed")
			throw new Error(`${engine.id} failed in ${scenario.id}`);
		measurements[scenario.id] = {
			opsPerSecond: 1000 / result.latency.mean,
			meanMs: result.latency.mean,
			p99Ms: result.latency.p99,
			rme: result.latency.rme,
			samples: result.latency.samplesCount,
		};
	}
	return measurements;
};

/** Runs `measure` for an engine in a fresh Node process. */
const measureInChild = (engine: Engine): Record<string, Measurement> => {
	const child = spawnSync(
		process.execPath,
		[fileURLToPath(import.meta.url), "--worker", engine.id],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
	);
	if (child.status !== 0) throw new Error(`${engine.id} worker failed`);
	return JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "{}");
};

/** The installed version of a package, read from its package.json. */
const packageVersion = async (name: string) => {
	let dir = dirname(fileURLToPath(import.meta.resolve(name)));
	while (dir !== dirname(dir)) {
		try {
			const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
			if (pkg.name === name) return String(pkg.version);
		} catch {}
		dir = dirname(dir);
	}
	throw new Error(`Can't find the version of ${name}`);
};

const gitCommit = () => {
	try {
		return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
			encoding: "utf8",
		}).trim();
	} catch {
		return null;
	}
};

const { values: args } = parseArgs({
	options: {
		check: { type: "boolean", default: false },
		engine: { type: "string", multiple: true },
		worker: { type: "string" },
	},
});

if (args.worker) {
	const engine = engines.find((item) => item.id === args.worker);
	if (!engine) throw new Error(`Unknown engine ${args.worker}`);
	console.log(JSON.stringify(await measure(engine)));
	process.exit(0);
}

const selected = args.engine
	? engines.filter(
			(engine) => engine.id === "kiln" || args.engine?.includes(engine.id),
		)
	: engines;

console.log(`Checking output of ${selected.map((e) => e.name).join(", ")}`);
const problems = await check(selected);
if (problems.length) {
	console.error(`\nOutput doesn't match Kiln's:\n\n${problems.join("\n\n")}`);
	process.exit(1);
}
console.log("Every engine renders the same HTML.\n");
if (args.check) process.exit(0);

const measured = new Map<string, Record<string, Measurement>>();
for (const engine of selected) {
	console.log(`Benchmarking ${engine.name}…`);
	measured.set(engine.id, measureInChild(engine));
}

const results = {
	date: new Date().toISOString().slice(0, 10),
	commit: gitCommit(),
	environment: {
		node: process.versions.node,
		os: `${os.type()} ${os.release()} (${os.arch()})`,
		cpu: os.cpus()[0]?.model.trim() ?? "Unknown",
		cores: os.availableParallelism(),
		memoryGb: Math.round(os.totalmem() / 1024 ** 3),
	},
	settings: { benchTimeMs: BENCH_TIME, warmupTimeMs: WARMUP_TIME },
	engines: await Promise.all(
		selected.map(async (engine) => ({
			id: engine.id,
			name: engine.name,
			package: engine.package,
			version: await packageVersion(engine.package),
			homepage: engine.homepage,
		})),
	),
	scenarios: scenarios.map((scenario) => {
		const supported = selected.flatMap((engine) => {
			const measurement = measured.get(engine.id)?.[scenario.id];
			return measurement ? [{ engine: engine.id, ...measurement }] : [];
		});
		const fastest = Math.max(...supported.map((item) => item.opsPerSecond));
		const results: Result[] = [
			...supported
				.map((item) => ({
					...item,
					supported: true as const,
					relative: item.opsPerSecond / fastest,
				}))
				.sort((a, b) => b.opsPerSecond - a.opsPerSecond),
			...selected
				.filter((engine) => !supports(engine, scenario))
				.map((engine) => ({ engine: engine.id, supported: false as const })),
		];
		return {
			id: scenario.id,
			name: scenario.name,
			description: scenario.description,
			features: scenario.features,
			templates: scenario.templates,
			async: scenario.async,
			cold: scenario.cold,
			results,
		};
	}),
};

for (const scenario of results.scenarios) {
	console.log(`\n${scenario.name}`);
	console.table(
		scenario.results.map((result) =>
			result.supported
				? {
						engine: result.engine,
						"ops/s": Math.round(result.opsPerSecond),
						"mean (ms)": result.meanMs.toFixed(3),
						"±%": result.rme.toFixed(2),
						relative: `${(result.relative * 100).toFixed(0)}%`,
					}
				: { engine: result.engine, "ops/s": "unsupported" },
		),
	);
}

if (args.engine) {
	console.log("\nNot writing results.json, because only some engines ran.");
} else {
	await writeFile(
		join(root, "results.json"),
		`${JSON.stringify(results, null, "\t")}\n`,
	);
	console.log("\nWrote results.json");
}
