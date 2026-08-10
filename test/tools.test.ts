import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { discoverSkills } from "../src/skills.ts";
import { createSkillTools } from "../src/tools.ts";
import { makeSkillsRoot, removeRoots, skillMd } from "./fixtures.ts";

const roots: string[] = [];
after(() => removeRoots(...roots));

/** A skills root with one plain skill and one that bundles a reference file. */
function fixture() {
  const path = makeSkillsRoot({
    "plain/SKILL.md": skillMd("plain", "A skill with no bundled files.", "PLAIN_BODY"),
    "bundled/SKILL.md": skillMd("bundled", "A skill with a reference file.", "BUNDLED_BODY"),
    "bundled/references/details.md": "DEEP_REFERENCE_CONTENT",
    "bundled/scripts/run.sh": "#!/bin/sh\necho hi\n",
  });
  roots.push(path);
  const { skills } = discoverSkills({ roots: [path] });
  return { root: path, skills, tools: createSkillTools(skills) };
}

describe("tool definitions", () => {
  test("constrains skill names to an enum so the model cannot invent one", () => {
    const { tools } = fixture();
    const loadSkill = tools.definitions.find((tool) => tool.name === "load_skill");
    const properties = loadSkill?.input_schema.properties as { name: { enum: string[] } };
    assert.deepEqual(properties.name.enum, ["bundled", "plain"]);
  });

  test("registers read_skill_file only when some skill actually bundles files", () => {
    const { tools } = fixture();
    assert.ok(tools.definitions.some((tool) => tool.name === "read_skill_file"));

    const bare = makeSkillsRoot({ "plain/SKILL.md": skillMd("plain", "Nothing bundled.") });
    roots.push(bare);
    const bareTools = createSkillTools(discoverSkills({ roots: [bare] }).skills);
    assert.deepEqual(
      bareTools.definitions.map((tool) => tool.name),
      ["load_skill"],
    );
  });
});

describe("load_skill", () => {
  test("returns the body and reports the activation", () => {
    const { tools } = fixture();
    const result = tools.run("load_skill", { name: "plain" });

    assert.equal(result.isError, false);
    assert.match(result.content, /PLAIN_BODY/);
    assert.deepEqual(result.event, { type: "skill_activated", skill: "plain" });
  });

  test("lists bundled files by name without reading their contents", () => {
    const { tools } = fixture();
    const result = tools.run("load_skill", { name: "bundled" });

    assert.match(result.content, /<file>references\/details\.md<\/file>/);
    assert.match(result.content, /<file>scripts\/run\.sh<\/file>/);
    assert.doesNotMatch(result.content, /DEEP_REFERENCE_CONTENT/);
  });

  test("does not re-send a body that is already in the conversation", () => {
    const { tools } = fixture();
    tools.run("load_skill", { name: "plain" });
    const second = tools.run("load_skill", { name: "plain" });

    assert.doesNotMatch(second.content, /PLAIN_BODY/);
    assert.match(second.content, /already loaded/);
    assert.equal(second.event, undefined);
  });

  test("reports an unknown skill as a tool error rather than throwing", () => {
    const { tools } = fixture();
    const result = tools.run("load_skill", { name: "nonexistent" });

    assert.equal(result.isError, true);
    assert.match(result.content, /No skill named "nonexistent"/);
  });
});

describe("read_skill_file", () => {
  test("reads a file bundled inside the skill", () => {
    const { tools } = fixture();
    const result = tools.run("read_skill_file", { skill: "bundled", path: "references/details.md" });

    assert.equal(result.isError, false);
    assert.match(result.content, /DEEP_REFERENCE_CONTENT/);
    assert.deepEqual(result.event, { type: "resource_loaded", skill: "bundled", file: "references/details.md" });
  });

  test("refuses to escape the skill directory with ..", () => {
    const { tools } = fixture();
    for (const path of ["../plain/SKILL.md", "../../../../etc/passwd", "/etc/passwd"]) {
      const result = tools.run("read_skill_file", { skill: "bundled", path });
      assert.equal(result.isError, true, `${path} should be rejected`);
      assert.match(result.content, /not a readable file inside/);
    }
  });

  test("refuses a symlink that points outside the skill directory", () => {
    const { root, skills } = fixture();
    symlinkSync("/etc/passwd", join(root, "bundled", "escape.md"));

    const result = createSkillTools(skills).run("read_skill_file", { skill: "bundled", path: "escape.md" });
    assert.equal(result.isError, true);
  });

  test("reports a missing file instead of throwing", () => {
    const { tools } = fixture();
    const result = tools.run("read_skill_file", { skill: "bundled", path: "references/absent.md" });
    assert.equal(result.isError, true);
  });
});

describe("unknown tools", () => {
  test("are reported back to the model as an error", () => {
    const { tools } = fixture();
    const result = tools.run("delete_everything", {});
    assert.equal(result.isError, true);
    assert.match(result.content, /Unknown tool/);
  });
});
