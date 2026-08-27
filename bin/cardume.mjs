#!/usr/bin/env node
// Wrapper para rodar o CLI (TypeScript via type-stripping do Node 22) com os flags certos.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "src", "cli.ts");

const child = spawn(
  process.execPath,
  ["--disable-warning=ExperimentalWarning", cli, ...process.argv.slice(2)],
  { stdio: "inherit" }
);
child.on("exit", (code) => process.exit(code ?? 0));
