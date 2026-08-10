import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { resolve } from "node:path";
import { buildCatalog, buildSystemPrompt } from "../src/catalog.ts";
import { discoverSkills, type Skill } from "../src/skills.ts";
import { makeSkillsRoot, removeRoots, skillMd } from "./fixtures.ts";

const roots: string[] = [];
after(() => removeRoots(...roots));

const fakeSkill = (overrides: Partial<Skill> = {}): Skill => ({
  name: "demo",
  description: "Does a demo thing. Use when the user asks for a demo.",
  body: "SECRET_BODY_CONTENT — these are the full instructions.",
  dir: "/skills/demo",
  path: "/skills/demo/SKILL.md",
  ...overrides,
});

describe("buildCatalog", () => {
  test("lists each skill's name, description and location", () => {
    const catalog = buildCatalog([fakeSkill()]);
    assert.match(catalog, /<name>demo<\/name>/);
    assert.match(catalog, /<description>Does a demo thing\. Use when the user asks for a demo\.<\/description>/);
    assert.match(catalog, /<location>\/skills\/demo\/SKILL\.md<\/location>/);
  });

  test("never includes a skill's body", () => {
    const catalog = buildCatalog([fakeSkill(), fakeSkill({ name: "other", body: "ANOTHER_SECRET" })]);
    assert.doesNotMatch(catalog, /SECRET_BODY_CONTENT/);
    assert.doesNotMatch(catalog, /ANOTHER_SECRET/);
  });

  test("escapes angle brackets so a description cannot break out of the catalog", () => {
    const catalog = buildCatalog([fakeSkill({ description: "Handles <html> & <xml>." })]);
    assert.match(catalog, /Handles &lt;html&gt; &amp; &lt;xml&gt;\./);
  });
});

describe("buildSystemPrompt", () => {
  test("includes the catalog and the instruction to load skills on demand", () => {
    const prompt = buildSystemPrompt([fakeSkill()]);
    assert.match(prompt, /<available_skills>/);
    assert.match(prompt, /call `load_skill`/);
    assert.doesNotMatch(prompt, /SECRET_BODY_CONTENT/);
  });

  test("omits the catalog entirely when no skills are installed", () => {
    const prompt = buildSystemPrompt([]);
    assert.doesNotMatch(prompt, /available_skills/);
    assert.doesNotMatch(prompt, /load_skill/);
  });

  /**
   * The assignment's actual requirement, as a unit test.
   *
   * `welcome-me`'s body is what tells the agent to print
   * "> Welcome to our Command Code assignment agent!". If that string can be
   * found anywhere in the system prompt, the skill is being loaded on every
   * single request and progressive disclosure is not implemented — no matter how
   * correct the agent's answers look.
   *
   * The header is read out of the installed skill rather than written here, so
   * this cannot rot into asserting a string the skill no longer contains.
   */
  test("the real .skills catalog advertises welcome-me without disclosing its instructions", () => {
    const skillsDir = resolve(import.meta.dirname, "..", ".skills");
    const { skills } = discoverSkills({ roots: [skillsDir] });
    const prompt = buildSystemPrompt(skills);

    const welcome = skills.find((skill) => skill.name === "welcome-me");
    assert.ok(welcome, "welcome-me should be discovered from .skills/");

    const header = /^>.*Welcome to our .*!$/m.exec(welcome.body)?.[0];
    assert.ok(header, "welcome-me's body should state a required header");

    assert.match(prompt, /welcome-me/, "welcome-me should appear in the catalog");
    assert.ok(!prompt.includes(header), `the header "${header}" must not be in the system prompt`);
  });

  test("a skill's body is withheld from the prompt but still available on the skill record", () => {
    const path = makeSkillsRoot({ "demo/SKILL.md": skillMd("demo", "A demo skill.", "UNIQUE_BODY_MARKER") });
    roots.push(path);

    const { skills } = discoverSkills({ roots: [path] });
    assert.equal(skills[0]?.body, "UNIQUE_BODY_MARKER");
    assert.doesNotMatch(buildSystemPrompt(skills), /UNIQUE_BODY_MARKER/);
  });
});
