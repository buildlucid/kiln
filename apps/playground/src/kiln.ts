import { join } from "node:path";
import { createKiln, withRender } from "@lucidkiln/core";
import { fileLoader } from "@lucidkiln/core/node";

/** What a request gives the templates: the visitor's name, from the `name` cookie. */
export type RequestState = { visitor: string | null };

/** The time now, as hours, minutes and seconds, so you can see when each part of a page was rendered. */
export const clock = (): string => new Date().toISOString().slice(11, 19);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The environment every route renders with. The async functions stand in for slow services. */
export const kiln = createKiln<RequestState>({
	loader: fileLoader({ root: join(import.meta.dirname, "../templates") }),
	functions: {
		clock,
		stock: async (id: number) => {
			await wait(600);
			return (id + new Date().getSeconds()) % 20;
		},
		reviews: async (id: number, fail: boolean) => {
			await wait(1500);
			if (fail)
				throw new Error(`The reviews service is down for product ${id}`);
			return [
				{ author: "Sam", text: "Keeps my tea warm for ages." },
				{ author: "Priya", text: "Lovely glaze, a little heavy." },
			];
		},
		visitor: withRender(async (render) => {
			await wait(200);
			return render.state.visitor;
		}),
	},
});
