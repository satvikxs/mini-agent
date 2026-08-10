import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { discoverSkills, parseSkill, splitFrontmatter } from "../src/skills.ts";
import { makeSkillsRoot, removeRoots, skillMd } from "./fixtures.ts";

const roots: string[] = [];
const root = (files: Record<string, string>) => {
  const path = makeSkillsRoot(files);
  roots.push(path);
  return path;
};
after(() => removeRoots(...roots));

describe("splitFrontmatter", () => {
  test("separates the YAML fence from the Markdown body", () => {
    const result = splitFrontmatter("---\nname: demo\n---\n\n# Heading\n\nText.\n");
    assert.equal(result?.yaml, "name: demo");
    assert.equal(result?.body, "# Heading\n\nText.");
  });

  test("returns null when the file does not open with a fence", () => {
    assert.equal(splitFrontmatter("# Just Markdown\n"), null);
  });

  test("tolerates a byte-order mark and CRLF line endings", () => {
    const result = splitFrontmatter("\uFEFF---\r\nname: demo\r\n---\r\nBody.\r\n");
    assert.equal(result?.yaml, "name: demo");
    assert.equal(result?.body, "Body.");
  });
});

describe("parseSkill", () => {
  const parse = (raw: string, dir = "/skills/demo") => parseSkill(`${dir}/SKILL.md`, raw);

  test("reads name, description and body from valid frontmatter", () => {
    const { skill, warnings } = parse(skillMd("demo", "Does a thing. Use when asked."));
    assert.equal(skill?.name, "demo");
    assert.equal(skill?.description, "Does a thing. Use when asked.");
    assert.equal(skill?.body, "Body of the skill.");
    assert.deepEqual(warnings, []);
  });

  test("recovers from an unquoted value containing a colon", () => {
    const { skill, warnings } = parse("---\nname: demo\ndescription: Use when: the user asks\n---\nBody.\n");
    assert.equal(skill?.description, "Use when: the user asks");
    assert.match(warnings[0]?.message ?? "", /colon/);
  });

  test("skips a skill with no description, since it could never be matched", () => {
    const { skill, warnings } = parse("---\nname: demo\n---\nBody.\n");
    assert.equal(skill, null);
    assert.match(warnings[0]?.message ?? "", /no `description`/);
  });

  test("skips a skill with no frontmatter", () => {
    const { skill, warnings } = parse("# No frontmatter here\n");
    assert.equal(skill, null);
    assert.match(warnings[0]?.message ?? "", /no YAML frontmatter/);
  });

  test("warns but still loads when the name does not match the directory", () => {
    const { skill, warnings } = parse(skillMd("something-else", "A description."), "/skills/demo");
    assert.equal(skill?.name, "something-else");
    assert.match(warnings[0]?.message ?? "", /but the directory is "demo"/);
  });

  test("warns but still loads when the name breaks the spec's character rules", () => {
    const { skill, warnings } = parse(skillMd("Demo_Skill", "A description."), "/skills/Demo_Skill");
    assert.equal(skill?.name, "Demo_Skill");
    assert.match(warnings[0]?.message ?? "", /lowercase alphanumerics/);
  });
});

describe("discoverSkills", () => {
  test("finds every directory containing a SKILL.md", () => {
    const path = root({
      "alpha/SKILL.md": skillMd("alpha", "The first skill."),
      "beta/SKILL.md": skillMd("beta", "The second skill."),
      "README.md": "not a skill",
      "notaskill/notes.md": "also not a skill",
    });

    const { skills } = discoverSkills({ roots: [path] });
    assert.deepEqual(
      skills.map((skill) => skill.name),
      ["alpha", "beta"],
    );
  });

  test("does not mistake a skill's own resource folders for more skills", () => {
    const path = root({
      "alpha/SKILL.md": skillMd("alpha", "The first skill."),
      "alpha/references/SKILL.md": skillMd("sneaky", "Should not be discovered."),
    });

    const { skills } = discoverSkills({ roots: [path] });
    assert.deepEqual(
      skills.map((skill) => skill.name),
      ["alpha"],
    );
  });

  test("lets an earlier root shadow a later one, and reports it", () => {
    const project = root({ "shared/SKILL.md": skillMd("shared", "Project version.") });
    const user = root({ "shared/SKILL.md": skillMd("shared", "User version.") });

    const { skills, warnings } = discoverSkills({ roots: [project, user] });
    assert.equal(skills.length, 1);
    assert.equal(skills[0]?.description, "Project version.");
    assert.match(warnings[0]?.message ?? "", /shadowed/);
  });

  test("ignores roots that do not exist", () => {
    const { skills, warnings } = discoverSkills({ roots: ["/nope/not/here"] });
    assert.deepEqual(skills, []);
    assert.deepEqual(warnings, []);
  });

  test("one broken skill does not stop the others from loading", () => {
    const path = root({
      "good/SKILL.md": skillMd("good", "A working skill."),
      "broken/SKILL.md": "---\nname: [unclosed\n---\nBody.\n",
    });

    const { skills, warnings } = discoverSkills({ roots: [path] });
    assert.deepEqual(
      skills.map((skill) => skill.name),
      ["good"],
    );
    assert.equal(warnings.length, 1);
  });
});
