import {
	createArrayLoader,
	createAutoEscapeNode,
	createEnvironment,
	createFunction,
	createSynchronousArrayLoader,
	createSynchronousEnvironment,
	createSynchronousFilter,
	createSynchronousTemplateLoader,
	createTemplateLoader,
	type TwingNodeVisitor,
} from "twing";
import { asyncFunctions } from "../data.ts";
import type { Engine } from "../engine.ts";
import { helpers } from "../helpers.ts";

const options = { autoEscapingStrategy: "html", timezone: "UTC" };

/** `autoEscapingStrategy` only wraps a template's body, so blocks in child and embedded templates went unescaped. */
const escapeBlocks: TwingNodeVisitor = {
	enterNode: (node) => node,
	leaveNode: (node) => {
		const { body } = node.children;
		if (node.type === "block" && body)
			node.children.body = createAutoEscapeNode(
				"html",
				body,
				body.line,
				body.column,
			);
		return node;
	},
};

/**
 * Twing with HTML autoescaping and UTC dates, using the synchronous environment unless the scenario needs async
 * functions. `environment.render` parses every template again on each call, so the adapter keeps one template
 * loader, whose registry holds the parsed templates, and renders through it. `date`, `number_format` and
 * `url_encode` are built in. Core Twig has no `truncate`, so that helper is a filter, and `sort` is replaced
 * because Twing's drops repeated values. Twing hands arrays to filters as maps.
 */
export const twing: Engine = {
	id: "twing",
	name: "Twing",
	package: "twing",
	homepage: "https://gitlab.com/nightlycommit/twing",
	extension: ".twig",
	async: true,
	prepare(templates, { async }) {
		if (async) {
			const env = createEnvironment(createArrayLoader(templates), options);
			env.addNodeVisitor(escapeBlocks);
			env.addFunction(
				createFunction(
					"latestPosts",
					(_, limit: number) => asyncFunctions.latestPosts(limit),
					[{ name: "limit" }],
				),
			);
			env.addFunction(
				createFunction("author", (_, id: string) => asyncFunctions.author(id), [
					{ name: "id" },
				]),
			);
			env.addFunction(
				createFunction("categories", () => asyncFunctions.categories(), []),
			);
			env.addFunction(
				createFunction(
					"document",
					(_, collection: string, slug: string) =>
						asyncFunctions.document(collection, slug),
					[{ name: "collection" }, { name: "slug" }],
				),
			);
			env.addFunction(
				createFunction(
					"documents",
					(_, collection: string, limit: number) =>
						asyncFunctions.documents(collection, limit),
					[{ name: "collection" }, { name: "limit" }],
				),
			);
			env.addFunction(
				createFunction(
					"navigation",
					(_, name: string) => asyncFunctions.navigation(name),
					[{ name: "name" }],
				),
			);
			const templateLoader = createTemplateLoader(env);
			return env
				.loadTemplate("page.twig")
				.then((page) => (data) => page.render(env, data, { templateLoader }));
		}
		const env = createSynchronousEnvironment(
			createSynchronousArrayLoader(templates),
			options,
		);
		env.addNodeVisitor(escapeBlocks);
		env.addFilter(
			createSynchronousFilter(
				"truncate",
				(_, value: string, length: number) => helpers.truncate(value, length),
				[{ name: "length" }],
			),
		);
		env.addFilter(
			createSynchronousFilter(
				"sort",
				(_, items: Map<number, string>) => [...items.values()].sort(),
				[],
			),
		);
		const templateLoader = createSynchronousTemplateLoader(env);
		const page = env.loadTemplate("page.twig");
		return (data) => page.render(env, data, { templateLoader });
	},
};
