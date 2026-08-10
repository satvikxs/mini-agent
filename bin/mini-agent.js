#!/usr/bin/env node
/**
 * Entry point. Plain JavaScript on purpose.
 *
 * The rest of this project is TypeScript, which Node runs directly from v22.18
 * onward. On an older Node, the failure happens while *parsing* src/cli.ts — so
 * no error message written inside that file could ever run. This file parses on
 * every version of Node, which means it can check first and say something
 * useful instead of dumping a syntax error.
 *
 * Bun and Deno run TypeScript natively, so the check does not apply to them.
 */

const MIN_MAJOR = 22;
const MIN_MINOR = 18;

if (!process.versions.bun && !process.versions.deno) {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);

  if (major < MIN_MAJOR || (major === MIN_MAJOR && minor < MIN_MINOR)) {
    console.error(`mini-agent needs Node ${MIN_MAJOR}.${MIN_MINOR} or newer — you are on v${process.versions.node}.`);
    console.error("It runs TypeScript directly, which older versions of Node cannot do.\n");
    console.error("Upgrade Node, or run it with a newer one without installing:");
    console.error("  npx -y node@22 bin/mini-agent.js \"your prompt\"");
    process.exit(1);
  }
}

await import("../src/cli.ts");
