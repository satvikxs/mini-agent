import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { createGate, type Gate } from "./permission.ts";
import { looksBinary, resolveInside, show, walk, type Workspace } from "./workspace.ts";

export type Outcome = { content: string; isError: boolean; label: string };

const MAX_READ = 200_000;
const MAX_OUTPUT = 30_000;
const SHELL_TIMEOUT = 60_000;

const fail = (label: string, message: string): Outcome => ({ content: message, isError: true, label });

const clip = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}\n… ${text.length - limit} more characters`;

function readFile(workspace: Workspace, input: Record<string, unknown>): Outcome {
  const path = String(input["path"] ?? "");
  const target = resolveInside(workspace, path);
  if (!target) return fail(path, `"${path}" is outside the workspace.`);

  try {
    if (statSync(target).isDirectory()) return fail(path, `"${path}" is a directory. Use list_files.`);
    const buffer = readFileSync(target);
    if (looksBinary(buffer)) return fail(path, `"${path}" is a binary file.`);

    const lines = buffer.toString("utf8").split("\n");
    const from = Math.max(0, Number(input["offset"] ?? 0));
    const count = Math.max(1, Number(input["limit"] ?? lines.length));
    // Numbered, because every later edit is described by line and an unnumbered
    // read makes the model invent them.
    const body = lines
      .slice(from, from + count)
      .map((line, index) => `${String(from + index + 1).padStart(5)}  ${line}`)
      .join("\n");

    return { content: clip(body, MAX_READ), isError: false, label: show(workspace, target) };
  } catch (error) {
    return fail(path, `Could not read "${path}": ${(error as Error).message}`);
  }
}

function writeFile(workspace: Workspace, input: Record<string, unknown>): Outcome {
  const path = String(input["path"] ?? "");
  const target = resolveInside(workspace, path);
  if (!target) return fail(path, `"${path}" is outside the workspace.`);

  try {
    mkdirSync(dirname(target), { recursive: true });
    const content = String(input["content"] ?? "");
    writeFileSync(target, content);
    return { content: `Wrote ${content.split("\n").length} lines.`, isError: false, label: show(workspace, target) };
  } catch (error) {
    return fail(path, `Could not write "${path}": ${(error as Error).message}`);
  }
}

function editFile(workspace: Workspace, input: Record<string, unknown>): Outcome {
  const path = String(input["path"] ?? "");
  const find = String(input["find"] ?? "");
  const replace = String(input["replace"] ?? "");
  const target = resolveInside(workspace, path);
  if (!target) return fail(path, `"${path}" is outside the workspace.`);
  if (!find) return fail(path, "`find` must not be empty.");

  try {
    const before = readFileSync(target, "utf8");
    const hits = before.split(find).length - 1;
    // An ambiguous match is the model's cue to include more context, not ours to
    // guess which occurrence it meant.
    if (hits === 0) return fail(path, `"${find.slice(0, 60)}" does not appear in ${path}.`);
    if (hits > 1 && input["all"] !== true) {
      return fail(path, `"${find.slice(0, 60)}" appears ${hits} times. Add more context, or pass all: true.`);
    }

    writeFileSync(target, input["all"] === true ? before.split(find).join(replace) : before.replace(find, replace));
    return { content: `Replaced ${hits === 1 ? "1 occurrence" : `${hits} occurrences`}.`, isError: false, label: show(workspace, target) };
  } catch (error) {
    return fail(path, `Could not edit "${path}": ${(error as Error).message}`);
  }
}

function listFiles(workspace: Workspace, input: Record<string, unknown>): Outcome {
  const path = String(input["path"] ?? ".");
  const target = resolveInside(workspace, path);
  if (!target) return fail(path, `"${path}" is outside the workspace.`);

  try {
    const entries = readdirSync(target, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith("."))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort();
    return { content: entries.join("\n") || "(empty)", isError: false, label: show(workspace, target) };
  } catch (error) {
    return fail(path, `Could not list "${path}": ${(error as Error).message}`);
  }
}

function search(workspace: Workspace, input: Record<string, unknown>): Outcome {
  const pattern = String(input["pattern"] ?? "");
  if (!pattern) return fail("search", "`pattern` must not be empty.");

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "i");
  } catch (error) {
    return fail("search", `Not a valid regular expression: ${(error as Error).message}`);
  }

  const within = String(input["path"] ?? ".");
  const from = resolveInside(workspace, within);
  if (!from) return fail(within, `"${within}" is outside the workspace.`);

  const hits: string[] = [];
  for (const entry of walk(workspace, from)) {
    if (entry.directory || hits.length >= 200) continue;
    try {
      const buffer = readFileSync(entry.path);
      if (looksBinary(buffer)) continue;
      buffer
        .toString("utf8")
        .split("\n")
        .forEach((line, index) => {
          if (hits.length < 200 && regex.test(line)) {
            hits.push(`${show(workspace, entry.path)}:${index + 1}: ${line.trim().slice(0, 200)}`);
          }
        });
    } catch {
      // Unreadable file. Skipping it is more useful than failing the search.
    }
  }

  return { content: hits.join("\n") || "No matches.", isError: false, label: `${hits.length} hit${hits.length === 1 ? "" : "s"}` };
}

async function runCommand(workspace: Workspace, gate: Gate, input: Record<string, unknown>): Promise<Outcome> {
  const command = String(input["command"] ?? "");
  if (!command) return fail("run", "`command` must not be empty.");

  const decision = await gate.allows(command);
  // Refusal is a tool result, not an exception: the model should read why and
  // pick a different approach rather than have the turn collapse.
  if (decision.verdict !== "allow") {
    return fail(command.slice(0, 60), `Refused (${decision.reason}). Ask the user to run it, or try another way.`);
  }

  return new Promise((done) => {
    execFile(
      process.env["SHELL"] || "/bin/sh",
      ["-c", command],
      { cwd: workspace.root, timeout: SHELL_TIMEOUT, maxBuffer: 4 * 1024 * 1024, env: process.env },
      (error, stdout, stderr) => {
        const body = clip([stdout, stderr].filter(Boolean).join("\n").trimEnd() || "(no output)", MAX_OUTPUT);
        // A non-zero exit is a result the model should read and react to, not a
        // harness failure — so the output comes back either way.
        done({
          content: error && !("code" in error) ? `${body}\n\n${error.message}` : body,
          isError: Boolean(error),
          label: command.slice(0, 60),
        });
      },
    );
  });
}

const schema = (properties: Record<string, unknown>, required: string[]): Anthropic.Tool["input_schema"] =>
  ({ type: "object", properties, required }) as Anthropic.Tool["input_schema"];

export type Toolkit = {
  definitions: Anthropic.Tool[];
  owns(name: string): boolean;
  run(name: string, input: unknown): Promise<Outcome>;
};

export function createToolkit(workspace: Workspace, gate: Gate = createGate("ask")): Toolkit {
  const definitions: Anthropic.Tool[] = [
    {
      name: "read_file",
      description: "Read a file from the workspace. Returns numbered lines.",
      input_schema: schema(
        {
          path: { type: "string", description: "Path relative to the workspace root." },
          offset: { type: "number", description: "First line to return, zero-based." },
          limit: { type: "number", description: "How many lines to return." },
        },
        ["path"],
      ),
    },
    {
      name: "write_file",
      description: "Write a file, creating directories as needed. Replaces the whole file.",
      input_schema: schema({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
    },
    {
      name: "edit_file",
      description: "Replace an exact string in a file. Fails if the string is absent or ambiguous.",
      input_schema: schema(
        {
          path: { type: "string" },
          find: { type: "string", description: "Exact text to replace, with enough context to be unique." },
          replace: { type: "string" },
          all: { type: "boolean", description: "Replace every occurrence instead of failing on ambiguity." },
        },
        ["path", "find", "replace"],
      ),
    },
    {
      name: "list_files",
      description: "List the entries of a directory in the workspace.",
      input_schema: schema({ path: { type: "string" } }, []),
    },
    {
      name: "search",
      description: "Search file contents for a regular expression, case-insensitive.",
      input_schema: schema({ pattern: { type: "string" }, path: { type: "string" } }, ["pattern"]),
    },
    {
      name: "run_command",
      description: "Run a shell command in the workspace root and return its output.",
      input_schema: schema({ command: { type: "string" } }, ["command"]),
    },
  ];

  const names = new Set(definitions.map((tool) => tool.name));

  return {
    definitions,
    owns: (name) => names.has(name),
    async run(name, raw) {
      const input = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
      try {
        if (name === "read_file") return readFile(workspace, input);
        if (name === "write_file") return writeFile(workspace, input);
        if (name === "edit_file") return editFile(workspace, input);
        if (name === "list_files") return listFiles(workspace, input);
        if (name === "search") return search(workspace, input);
        if (name === "run_command") return await runCommand(workspace, gate, input);
        return fail(name, `Unknown tool "${name}".`);
      } catch (error) {
        return fail(name, `"${name}" failed: ${(error as Error).message}`);
      }
    },
  };
}
