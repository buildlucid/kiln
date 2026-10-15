/** Names that can never be read, whatever the object. */
export const BLOCKED_NAMES = new Set(["constructor", "prototype", "__proto__"]);

/**
 * Lists the members of a class that templates may read or call.
 *
 * ```ts
 * class Post {
 * 	static [expose] = ["title", "excerpt"] as const;
 * }
 * ```
 */
export const expose: unique symbol = Symbol.for("kiln.expose");

/**
 * An instance method that answers names not listed in `expose`. Return `undefined` for a missing name.
 *
 * ```ts
 * class Fields {
 * 	[lookup](name: string) { return this.#values.get(name); }
 * }
 * ```
 */
export const lookup: unique symbol = Symbol.for("kiln.lookup");

type Exposable = {
	[expose]?: readonly string[];
};

export type LookupTarget = {
	[lookup]?: (name: string) => unknown;
};

const exposedCache = new WeakMap<object, Set<string>>();

/** Collects `expose` lists from an object's class and its parent classes. */
export const exposedMembers = (proto: object): Set<string> => {
	const cached = exposedCache.get(proto);
	if (cached) return cached;

	const members = new Set<string>();
	for (
		let current: object | null = proto;
		current !== null && current !== Object.prototype;
		current = Object.getPrototypeOf(current)
	) {
		const owner: unknown = Object.hasOwn(current, "constructor")
			? (current as { constructor: unknown }).constructor
			: undefined;
		if (typeof owner === "function" && Object.hasOwn(owner, expose)) {
			const list = (owner as Exposable)[expose];
			if (Array.isArray(list)) {
				for (const name of list) {
					if (typeof name === "string" && !BLOCKED_NAMES.has(name)) {
						members.add(name);
					}
				}
			}
		}
	}
	exposedCache.set(proto, members);
	return members;
};
