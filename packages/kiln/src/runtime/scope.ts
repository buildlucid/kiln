/** Key of a scope's parent scope. Templates cannot name symbols. */
export const PARENT: unique symbol = Symbol("kiln.parent");

/**
 * Variables visible at one point of a render. A scope holds its own variables as string keys and links to its parent,
 * ending at the globals, whose parent is null. Variables never hold `undefined`, so `lookup` can tell a missing
 * variable from one set to null.
 *
 * Every scope has the same empty prototype, so scopes made the same way share a shape from render to render and
 * V8's property caches stay warm. Chaining scopes with `Object.create(parent)` would give each one a new shape,
 * because every parent would be a new prototype.
 */
export type Scope = { [key: string | symbol]: unknown; [PARENT]: Scope | null };

const SCOPE_PROTOTYPE: object = Object.freeze(Object.create(null));

/** Creates an empty scope inside `parent`. */
export const childScope = (parent: Scope | null): Scope => {
	const scope = Object.create(SCOPE_PROTOTYPE) as Scope;
	scope[PARENT] = parent;
	return scope;
};

/** Finds a variable in a scope or its parents. Returns `undefined` when none of them has it. */
export const lookup = (scope: Scope, name: string): unknown => {
	let current: Scope | null = scope;
	do {
		const value = current[name];
		if (value !== undefined) return value;
		current = current[PARENT];
	} while (current !== null);
	return undefined;
};

/** The scope that holds `name`, or null when none does. */
export const ownerOf = (scope: Scope, name: string): Scope | null => {
	let current: Scope | null = scope;
	while (current !== null && !Object.hasOwn(current, name)) {
		current = current[PARENT];
	}
	return current;
};

/** Every variable name a scope can see, for "did you mean" hints. */
export const variableNames = (scope: Scope): string[] => {
	const names = new Set<string>();
	for (let current: Scope | null = scope; current; current = current[PARENT]) {
		for (const name of Object.keys(current)) names.add(name);
	}
	return [...names];
};
