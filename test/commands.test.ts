import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { COMMANDS, costText, gist, helpText, isCommand, parse, skillsText, toolsText } from "../src/commands.ts";
import { discoverSkills } from "../src/skills.ts";
import { resolve } from "node:path";

const skills = discoverSkills({ roots: [resolve(import.meta.dirname, "..", ".skills")] }).skills;

describe("parse", () => {
  test("splits a command from its argument", () => {
    assert.deepEqual(parse("/model sonnet"), { name: "model", args: "sonnet" });
    assert.deepEqual(parse("/help"), { name: "help", args: "" });
    assert.deepEqual(parse("  /mode  auto  "), { name: "mode", args: "auto" });
  });

  test("returns null for anything that is not a command", () => {
    assert.equal(parse("hello"), null);
    assert.equal(parse("/"), null);
    assert.equal(parse("what about /help"), null);
  });

  test("keeps a multi-word argument whole", () => {
    assert.deepEqual(parse("/init write it now"), { name: "init", args: "write it now" });
  });
});

describe("the command set", () => {
  test("every command has a name and a summary", () => {
    for (const command of COMMANDS) {
      assert.match(command.name, /^[a-z][a-z-]*$/, command.name);
      assert.ok(command.summary.length > 0, command.name);
    }
  });

  test("names are unique", () => {
    const names = COMMANDS.map((command) => command.name);
    assert.equal(new Set(names).size, names.length);
  });

  /** Every command the palette offers must be one the dispatcher handles. */
  test("each command is recognised by isCommand", () => {
    for (const command of COMMANDS) assert.ok(isCommand(command.name), command.name);
    assert.equal(isCommand("nonsense"), false);
  });
});

describe("what each command prints", () => {
  test("/help lists every command, the skills, and the keys", () => {
    const text = helpText(skills);
    for (const command of COMMANDS) assert.match(text, new RegExp(`/${command.name}\\b`), command.name);
    for (const skill of skills) assert.match(text, new RegExp(`/${skill.name}\\b`), skill.name);
    assert.match(text, /Keys/);
  });

  test("/help stands alone with no skills installed", () => {
    const text = helpText([]);
    assert.match(text, /\/help/);
    assert.doesNotMatch(text, /Skills —/);
  });

  test("/skills names each one and says the bodies are withheld", () => {
    const text = skillsText(skills);
    for (const skill of skills) assert.match(text, new RegExp(skill.name));
    assert.match(text, /instructions arrive when the model asks/);
  });

  test("/skills says so when there are none", () => {
    assert.match(skillsText([]), /No skills installed/);
  });

  test("/tools lists what it is given", () => {
    const text = toolsText([
      { name: "read_file", description: "Read a file. Returns numbered lines." },
      { name: "run_command", description: "Run a shell command." },
    ]);
    assert.match(text, /2 tools/);
    assert.match(text, /read_file\s+Read a file/);
  });

  test("/cost reports nothing before the first turn", () => {
    assert.match(costText({ turns: 0, input: 0, output: 0, elapsedMs: 0 }), /Nothing sent yet/);
  });

  test("/cost abbreviates thousands", () => {
    const text = costText({ turns: 3, input: 12_400, output: 900, elapsedMs: 4200 });
    assert.match(text, /3 turns/);
    assert.match(text, /12\.4k in/);
    assert.match(text, /900 out/);
    assert.match(text, /4\.2s/);
  });
});

describe("gist", () => {
  test("takes the first sentence and drops its full stop", () => {
    assert.equal(gist("Does a thing. And another thing."), "does a thing");
  });

  test("survives a description with no sentence end", () => {
    assert.equal(gist("no full stop here"), "no full stop here");
  });
});
