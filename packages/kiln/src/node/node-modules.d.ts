// The few Node built-ins the file loader uses. Declared here so the core package compiles without Node or DOM types.
declare module "node:fs/promises" {
	export function readFile(path: string, encoding: "utf8"): Promise<string>;
}

declare module "node:path" {
	export function resolve(...paths: string[]): string;
	export const sep: string;
}
