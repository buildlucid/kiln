#!/usr/bin/env node
import process from "node:process";
import { formatCommand, USAGE } from "./formatter/command.js";

const io = {
	stdout: (text: string) => process.stdout.write(text),
	stderr: (text: string) => process.stderr.write(text),
};
const [command, ...rest] = process.argv.slice(2);
if (command === "format") process.exitCode = await formatCommand(rest, io);
else {
	io.stdout(`${USAGE}\n`);
	process.exitCode = command === undefined || command === "--help" ? 0 : 2;
}
