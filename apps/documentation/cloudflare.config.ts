import { defineConfig } from "cf/config";

/**
 * Deploys the docs as an assets-only Worker: no script, just the static files in `dist`.
 * The assets directory is set in `wrangler.config.ts`, because cf hands static builds to Wrangler.
 */
export default defineConfig({
	worker: {
		name: "kiln-docs",
		compatibilityDate: "2026-10-15",
		assets: {
			htmlHandling: "auto-trailing-slash",
			notFoundHandling: "404-page",
		},
	},
});
