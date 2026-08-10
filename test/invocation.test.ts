import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseInvocation } from "../src/ui/invocation.ts";

const SKILLS = ["welcome-me", "writing-plans", "internal-comms"];
const parse = (line: string) => parseInvocation(line, SKILLS);

describe("parseInvocation", () => {
  test("passes an ordinary prompt through untouched", () => {
    assert.deepEqual(parse("what's the weather?"), { kind: "prompt", text: "what's the weather?" });
  });

  test("names a skill and keeps the rest of the line as the prompt", () => {
    assert.deepEqual(parse("/welcome-me and keep it short"), {
      kind: "skill",
      name: "welcome-me",
      text: "and keep it short",
    });
  });

  test("a bare skill name still asks for something", () => {
    const invocation = parse("/welcome-me");
    assert.equal(invocation.kind, "skill");
    // The instructions arrive with nothing after them, so the model has to be
    // told to act on them rather than left with a dangling document.
    assert.match(invocation.kind === "skill" ? invocation.text : "", /follow the instructions/i);
  });

  test("reports a slash command that matches no installed skill", () => {
    const invocation = parse("/nope do a thing");
    assert.equal(invocation.kind, "unknown");
    assert.match(invocation.kind === "unknown" ? invocation.message : "", /No skill named "nope"/);
    assert.match(invocation.kind === "unknown" ? invocation.message : "", /welcome-me/);
  });

  test("only treats a slash at the very start as an invocation", () => {
    assert.equal(parse("what does /welcome-me do?").kind, "prompt");
    assert.equal(parse("use the /welcome-me skill").kind, "prompt");
  });

  /**
   * A skill name runs to whitespace or to the end of the line, so a path has a
   * slash where a name would have ended and is never read as an invocation.
   * Otherwise mentioning a directory would produce "No skill named usr".
   */
  test("does not mistake a path or a lone slash for a skill", () => {
    assert.equal(parse("/").kind, "prompt");
    assert.equal(parse("/usr/local/bin").kind, "prompt");
    assert.equal(parse("/etc/hosts is the file").kind, "prompt");
  });

  test("tolerates surrounding whitespace", () => {
    assert.deepEqual(parse("   /writing-plans   build a thing  "), {
      kind: "skill",
      name: "writing-plans",
      text: "build a thing",
    });
  });

  test("is case-sensitive, matching the spec's lowercase skill names", () => {
    assert.equal(parse("/Welcome-Me").kind, "unknown");
  });
});
