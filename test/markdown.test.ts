import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createMarkdownStream } from "../src/ui/markdown.ts";

/**
 * Colour is disabled when stdout is not a TTY, which is always the case under
 * the test runner. So these assert the plain-text shape: what got kept, what got
 * dropped, and how it is laid out.
 */
function render(markdown: string): string {
  let output = "";
  const stream = createMarkdownStream((text) => {
    output += text;
  });
  stream.push(markdown);
  stream.end();
  return output;
}

/** Feeds the input one character at a time, as a stream would. */
function renderByCharacter(markdown: string): string {
  let output = "";
  const stream = createMarkdownStream((text) => {
    output += text;
  });
  for (const character of markdown) stream.push(character);
  stream.end();
  return output;
}

describe("inline formatting", () => {
  test("removes bold and italic markers", () => {
    assert.equal(render("**bold** and *italic*"), "bold and italic\n");
  });

  test("removes backticks from inline code", () => {
    assert.equal(render("run `npm test` now"), "run npm test now\n");
  });

  test("leaves asterisks inside a code span alone", () => {
    assert.equal(render("`a ** b`"), "a ** b\n");
  });

  test("keeps the label of a link and moves the url after it", () => {
    assert.equal(render("see [the docs](https://example.com)"), "see the docs https://example.com\n");
  });
});

describe("block formatting", () => {
  test("uppercases sub-headings and keeps top-level ones as written", () => {
    assert.equal(render("# Title"), "Title\n");
    assert.equal(render("## Get it running"), "GET IT RUNNING\n");
  });

  test("replaces list markers with a bullet", () => {
    assert.equal(render("- first\n- second"), "· first\n· second\n");
  });

  test("keeps numbers on ordered lists", () => {
    assert.equal(render("1. first\n2. second"), "1. first\n2. second\n");
  });

  test("hides code fences but keeps the code, marked with a bar", () => {
    const output = render("```bash\nnpm install\n```");
    assert.equal(output, "│ npm install\n");
    assert.doesNotMatch(output, /```/);
  });

  test("collapses runs of blank lines and drops leading ones", () => {
    assert.equal(render("\n\n\nfirst\n\n\n\nsecond"), "first\n\nsecond\n");
  });
});

describe("nested lists", () => {
  test("indent according to their nesting level", () => {
    assert.equal(render("- top\n  - nested\n    - deeper"), "· top\n  · nested\n    · deeper\n");
  });

  test("keep nesting on ordered items too", () => {
    assert.equal(render("1. top\n  2. nested"), "1. top\n  2. nested\n");
  });
});

describe("tables", () => {
  const table = "| Tier | What loads |\n|------|------------|\n| 1 | name |\n| 2 | the body |";

  test("align columns and drop the pipes", () => {
    const output = render(table);
    assert.doesNotMatch(output, /\|/);
    assert.match(output, /Tier {3}What loads/);
    // "the body" is wider than "name", so column one pads to the header width.
    assert.match(output, /1 {6}name/);
    assert.match(output, /2 {6}the body/);
  });

  test("separate the header with a rule", () => {
    const lines = render(table).split("\n");
    assert.match(lines[1] ?? "", /^─+$/);
  });

  test("do not swallow the text that follows", () => {
    assert.match(render(`${table}\n\nAfter the table.`), /After the table\./);
  });

  test("treat a lone pipe row as ordinary text rather than a table", () => {
    assert.equal(render("| not really a table |"), "not really a table\n");
  });

  test("flush a table that ends the message", () => {
    assert.match(render(table), /the body/);
  });
});

describe("blockquotes", () => {
  /**
   * The welcome-me skill requires the literal line
   * "> Welcome to our Command Code assignment agent!". Rendering it as a
   * prettier blockquote would strip the marker and break the one output the
   * assignment pins down, so quotes pass through verbatim.
   */
  test("pass through untouched, marker included", () => {
    const header = "> Welcome to our Command Code assignment agent!";
    assert.equal(render(header), `${header}\n`);
  });
});

describe("streaming", () => {
  test("produces the same output whether fed whole or one character at a time", () => {
    const markdown = "# Title\n\nSome **bold** text.\n\n- one\n- two\n\n```\ncode here\n```\n\n> quoted\n";
    assert.equal(renderByCharacter(markdown), render(markdown));
  });

  test("holds back a partial line until it is complete", () => {
    const chunks: string[] = [];
    const stream = createMarkdownStream((text) => chunks.push(text));

    stream.push("a partial sen");
    assert.deepEqual(chunks, [], "nothing should print before the line ends");

    stream.push("tence\n");
    assert.deepEqual(chunks, ["a partial sentence\n"]);
  });

  test("flushes a trailing line that never got a newline", () => {
    assert.equal(render("no trailing newline"), "no trailing newline\n");
  });

  /**
   * The model often says something, calls a tool, then carries on. The status
   * row for that tool call has to appear *after* the words that preceded it, and
   * the next turn's text must not run on from the previous sentence.
   */
  test("flush lands a half-written line without ending the stream", () => {
    const chunks: string[] = [];
    const stream = createMarkdownStream((text) => chunks.push(text));

    stream.push("Let me check that");
    assert.deepEqual(chunks, [], "nothing prints until the line is complete");

    stream.flush();
    assert.deepEqual(chunks, ["Let me check that\n"], "flush lands it");

    stream.push("A second thought.\n");
    stream.end();
    assert.deepEqual(chunks, ["Let me check that\n", "A second thought.\n"]);
  });

  test("flush on an empty buffer prints nothing", () => {
    const chunks: string[] = [];
    const stream = createMarkdownStream((text) => chunks.push(text));
    stream.flush();
    stream.flush();
    assert.deepEqual(chunks, []);
  });
});
