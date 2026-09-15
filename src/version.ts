import { readFileSync } from "node:fs";

export function readVersion(packageUrl = new URL("../package.json", import.meta.url)): string {
  const packageJson = JSON.parse(readFileSync(packageUrl, "utf8")) as { version: string };
  return `v${packageJson.version}`;
}

export const VERSION = readVersion();
