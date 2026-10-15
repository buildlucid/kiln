// Type-level tests. They run under their own tsconfig because they add to `KilnTemplates` and `KilnTypes`, which every file in a project shares.
import { describe, expectTypeOf, test } from "vite-plus/test";
import {
	createKiln,
	type Markup,
	memoryLoader,
	type TemplateBlock,
	type TemplateContext,
} from "../../src/index.js";

class PostView {
	title = "Hello";
}

// What `generateTypes` writes, by hand.
declare module "../../src/index.js" {
	interface KilnTypes {
		Post: PostView;
	}
	interface KilnTemplates {
		"pages/post": {
			context: {
				post: KilnTypes["Post"];
				tags?: readonly (string | Markup)[] | null;
			};
			blocks: "content" | "title";
		};
		"pages/home": {
			context: { title?: unknown } & Record<string, unknown>;
			blocks: "content";
		};
	}
}

const loader = memoryLoader({});
const kiln = createKiln({
	loader,
	types: { Post: (value) => value instanceof PostView },
});
const post = new PostView();

describe("render types", () => {
	test("look up a template's data by name, with or without .kiln", () => {
		expectTypeOf<TemplateContext<"pages/post">>().toEqualTypeOf<{
			post: PostView;
			tags?: readonly (string | Markup)[] | null;
		}>();
		expectTypeOf<TemplateContext<"pages/post.kiln">>().toEqualTypeOf<
			TemplateContext<"pages/post">
		>();
		expectTypeOf<TemplateBlock<"pages/post">>().toEqualTypeOf<
			"content" | "title"
		>();
	});

	test("accept any data and block for other names", () => {
		expectTypeOf<TemplateContext<string>>().toEqualTypeOf<
			Record<string, unknown>
		>();
		expectTypeOf<TemplateBlock<"pages/other">>().toEqualTypeOf<string>();
	});

	test("check the data passed to render and renderBlock", () => {
		// Never called: the compiler checks these lines.
		const calls = async (name: string) => {
			await kiln.render("pages/post", { post });
			await kiln.render("pages/post.kiln", { post, tags: ["a"] });
			await kiln.render("pages/home");
			await kiln.render("pages/home", { title: "Home", extra: 1 });
			await kiln.render(name, { anything: 1 });
			await kiln.renderBlock("pages/post", "title", { post });
			// @ts-expect-error: "pots" isn't a prop.
			await kiln.render("pages/post", { pots: post });
			// @ts-expect-error: "post" is required.
			await kiln.render("pages/post");
			// @ts-expect-error: "post" must be a PostView.
			await kiln.render("pages/post", { post: 1 });
			// @ts-expect-error: the template has no "sidebar" block.
			await kiln.renderBlock("pages/post", "sidebar", { post });
		};
		expectTypeOf(calls).toBeFunction();
	});

	test("keep state required when the environment has a State type", () => {
		const stateful = createKiln<{ locale: string }>({ loader });
		const calls = async () => {
			await stateful.render("pages/home", {}, { state: { locale: "en" } });
			// @ts-expect-error: state is required.
			await stateful.render("pages/post", { post });
		};
		expectTypeOf(calls).toBeFunction();
	});

	test("require a type guard for each type in KilnTypes", () => {
		const calls = () => {
			// @ts-expect-error: the check must narrow to PostView.
			createKiln({ loader, types: { Post: () => true } });
			// @ts-expect-error: Post needs a check.
			createKiln({ loader, types: {} });
			createKiln({
				loader,
				types: {
					Post: (value) => value instanceof PostView,
					Other: () => true,
				},
			});
		};
		expectTypeOf(calls).toBeFunction();
	});
});
