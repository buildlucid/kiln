// The few Node built-ins the file loader and the CLI use. Declared here so the core package compiles without Node or DOM types.
declare module "node:fs/promises" {
	export function readFile(path: string, encoding: "utf8"): Promise<string>;
	export function writeFile(path: string, data: string): Promise<void>;
	export function stat(path: string): Promise<{ isDirectory(): boolean }>;
	export function readdir(
		path: string,
		options: { recursive: true; withFileTypes: true },
	): Promise<{ name: string; parentPath: string; isFile(): boolean }[]>;
}

declare module "node:path" {
	export function resolve(...paths: string[]): string;
	export function join(...paths: string[]): string;
	export function relative(from: string, to: string): string;
	export const sep: string;
}

declare module "node:process" {
	type Stream = { write(text: string): boolean };
	const process: {
		argv: string[];
		exitCode: number | undefined;
		stdout: Stream;
		stderr: Stream;
	};
	export default process;
}
