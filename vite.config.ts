import { defineConfig } from "vite-plus";

export default defineConfig({
	test: {
		exclude: ["**/node_modules/**", "**/dist/**"],
		passWithNoTests: true,
		projects: [
			{
				extends: true,
				test: { name: "closures", include: ["packages/**/*.test.ts"] },
			},
			// Every feature test again, rendering precompiled templates. See `render` in packages/kiln/test/helpers.ts.
			{
				extends: true,
				test: {
					name: "precompiled",
					include: ["packages/kiln/test/**/*.test.ts"],
					env: { KILN_PRECOMPILE: "1" },
				},
			},
		],
	},
	fmt: {
		useTabs: true,
		printWidth: 80,
		sortImports: { newlinesBetween: false },
		sortPackageJson: false,
		ignorePatterns: [
			"**/*.md",
			"packages/benchmarks/templates/**",
			"packages/benchmarks/results.json",
		],
	},
	lint: {
		jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
		rules: { "vite-plus/prefer-vite-plus-imports": "error" },
		options: { typeAware: true, typeCheck: true },
	},
});
