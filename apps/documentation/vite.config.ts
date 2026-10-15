import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";
import { kilnPages } from "./plugin/index.js";
import { navigation, pageContext } from "./src/navigation.js";

export default defineConfig({
	plugins: [
		kilnPages({
			globals: {
				site: {
					name: "Kiln",
					package: "@lucidcms/kiln",
					repository: "https://github.com/buildlucid/kiln",
				},
				navigation,
			},
			context: (page) => pageContext(page.url),
		}),
		tailwindcss(),
	],
});
