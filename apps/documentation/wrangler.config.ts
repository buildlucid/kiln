import { defineWranglerConfig } from "wrangler/experimental-config";

/** Points Wrangler at the Vite build output. There is no Worker script, so there are no types to generate. */
export default defineWranglerConfig({
	assetsDirectory: "./dist",
	types: { generate: false },
});
