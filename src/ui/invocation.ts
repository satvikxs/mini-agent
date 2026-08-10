import { strings } from "./strings.ts";

export type Invocation =
  /** No leading slash. Let the model decide, as usual. */
  | { kind: "prompt"; text: string }
  /** A known skill, named by the user. */
  | { kind: "skill"; name: string; text: string }
  /** A leading slash that matches nothing installed. */
  | { kind: "unknown"; name: string; message: string };

/** `/name` at the very start, followed by whitespace or nothing at all. */
const LEADING_SLASH = /^\/([A-Za-z0-9][A-Za-z0-9-]*)(?:\s+([\s\S]*))?$/;

export function parseInvocation(line: string, available: readonly string[]): Invocation {
  const trimmed = line.trim();
  const match = LEADING_SLASH.exec(trimmed);
  if (!match) return { kind: "prompt", text: trimmed };

  const [, name = "", rest = ""] = match;
  if (!available.includes(name)) {
    return { kind: "unknown", name, message: strings.unknownSkill(name, [...available]) };
  }

  // `/welcome-me` on its own is still a request: the instructions arrive with
  // nothing following them, so the model needs to be told to act on them.
  return { kind: "skill", name, text: rest.trim() || strings.explicitOnly };
}
