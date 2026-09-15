import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { readVersion } from "../src/version.ts";

test("reads the CLI version from package.json", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "mini-agent-version-"));
  context.after(() => rm(directory, { recursive: true, force: true }));

  const packagePath = join(directory, "package.json");
  await writeFile(packagePath, JSON.stringify({ version: "9.8.7" }));

  assert.equal(readVersion(pathToFileURL(packagePath)), "v9.8.7");
});
