export type Decision = { verdict: "allow" | "ask" | "deny"; reason?: string };

/**
 * Commands that only read. Anchored, and each forbids the shell metacharacters
 * that would let a second command ride along.
 */
const SAFE = [
  /^(?:ls|pwd|whoami|date|uname|hostname)(?:\s+[^&|;<>`$()]*)?$/,
  /^(?:cat|head|tail|wc|file|stat)\s+[^&|;<>`$()]+$/,
  /^(?:git)\s+(?:status|log|diff|show|branch|remote|rev-parse)(?:\s+[^&|;<>`$()]*)?$/,
  /^(?:node|npm|npx|bun)\s+(?:--version|-v)$/,
  /^(?:which|type|command\s+-v)\s+[^&|;<>`$()]+$/,
  /^(?:grep|rg|find)\s+[^&|;<>`$()]+$/,
  /^(?:echo)\s+[^&|;<>`$()]*$/,
];

/** Irreversible, or close enough that a person should look first. */
const DESTRUCTIVE = [
  /(^|[\s;&|])rm\s+-[a-zA-Z]*[rRf]/,
  /(^|[\s;&|])rmdir\b/,
  /(^|[\s;&|])(?:mv|dd|shred|truncate|mkfs)\s/,
  />\s*\/dev\/[sh]d[a-z]/,
  /\bgit\s+push\b[^;&|\n]*(?:--force|--force-with-lease|-f)\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\b[^;&|\n]*-[a-zA-Z]*f/,
  /\bgit\s+branch\b[^;&|\n]*-D\b/,
  /\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE|SCHEMA)\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bkubectl\s+delete\b/,
  /\bterraform\s+destroy\b/,
  /\bdocker\s+(?:rm|rmi|system\s+prune)\b/,
  /\b(?:curl|wget)\b[^;&|\n]*\|\s*(?:sh|bash|zsh)\b/,
  /\bchmod\s+-R\b/,
  /\bsudo\b/,
];

/** Refused outright: no plausible reason, and catastrophic if the pattern is wrong. */
const FORBIDDEN = [
  /(^|[\s;&|])rm\s+-[a-zA-Z]*[rRf][a-zA-Z]*\s+(?:\/|~|\$HOME)\s*$/,
  /:\(\)\s*\{.*\}\s*;\s*:/,
  /\bmkfs\.[a-z]+\s+\/dev\//,
  />\s*\/dev\/sda\b/,
];

/**
 * What to do about a command before running it.
 *
 * A newline is a command separator, and the safe patterns above use negated
 * character classes that admit one — so `ls\nrm -rf tmp` would match the `ls`
 * rule and run both. Control characters are rejected before the allow-list is
 * consulted; a genuinely read-only command never needs one.
 */
export function judge(command: string): Decision {
  const trimmed = command.trim();
  if (trimmed.length === 0) return { verdict: "deny", reason: "empty command" };

  for (const pattern of FORBIDDEN) {
    if (pattern.test(trimmed)) return { verdict: "deny", reason: "refused: irreversible and unbounded" };
  }

  if (/[\n\r\x00-\x1f\x7f]/.test(trimmed)) return { verdict: "ask", reason: "spans more than one line" };

  for (const pattern of DESTRUCTIVE) {
    if (pattern.test(trimmed)) return { verdict: "ask", reason: "may destroy work" };
  }

  return SAFE.some((pattern) => pattern.test(trimmed))
    ? { verdict: "allow" }
    : { verdict: "ask", reason: "writes, or its effect is not obvious" };
}

export type Mode = "ask" | "auto";

/** Asked once per command, and the answer may be remembered for that exact command. */
export type Confirm = (command: string, reason: string) => Promise<boolean>;

export type Gate = {
  allows(command: string): Promise<Decision>;
  /** The mode changes mid-session, and every agent shares one gate. */
  setMode(mode: Mode): void;
  readonly mode: Mode;
};

/**
 * `auto` still refuses the forbidden set. A mode that turns off every check is
 * one nobody can safely leave on, which makes it a mode nobody should be given.
 */
export function createGate(initial: Mode, confirm?: Confirm): Gate {
  const remembered = new Set<string>();
  let mode = initial;

  return {
    get mode() {
      return mode;
    },
    setMode(next) {
      mode = next;
    },
    async allows(command) {
      const decision = judge(command);
      if (decision.verdict !== "ask") return decision;
      if (mode === "auto" || remembered.has(command.trim())) return { verdict: "allow" };
      if (!confirm) return { verdict: "deny", reason: "needs confirmation, and nothing can ask" };

      if (await confirm(command, decision.reason ?? "")) {
        remembered.add(command.trim());
        return { verdict: "allow" };
      }
      return { verdict: "deny", reason: "declined" };
    },
  };
}
