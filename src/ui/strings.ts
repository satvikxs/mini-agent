export const strings = {
  product: "mini-agent",
  tagline: "a coding agent built on the Agent Skills specification",

  help: `mini-agent — a coding agent built on the Agent Skills specification

Usage
  mini-agent [options] [prompt]

  With a prompt, answers once and exits. Without one, opens an interactive session.

Options
  -v, --verbose        Print the system prompt, parse warnings, and every tool call
      --skills-dir DIR Search DIR for skills instead of the defaults (repeatable)
      --model NAME     Model to use (default: ANTHROPIC_MODEL, else claude-sonnet-5)
      --thinking       Unfold the model's reasoning instead of its first line
      --no-mouse       Do not track clicks, leaving text selection to the terminal
  -h, --help           Show this message

In a session
  goat                 type it — no return needed; the banner goat runs a lap
  click the goat       the same, aimed with the mouse

Naming a skill
  Start a prompt with /skill-name to load that skill yourself instead of leaving
  the choice to the model — e.g. /welcome-me, or /welcome-me and keep it short.

Skills are discovered in ./.skills, ./.agents/skills, then ~/.agents/skills.

Environment (or a .env file at the project root)
  ANTHROPIC_API_KEY    required
  ANTHROPIC_MODEL      default model, overridden by --model
  ANTHROPIC_BASE_URL   the gateway to reach, if not api.anthropic.com

A Claude model goes to that endpoint's /v1/messages; any other model goes to its
/v1/chat/completions, so open models work wherever the gateway serves them.`,

  /** Sits at the right end of the title row. */
  ready: (skills: number) => count(skills, "skill"),

  /** First run. Two questions, and what happens once they are answered. */
  onboard: {
    provider: "Where should the model come from?",
    endpoint: "Base URL of your endpoint",
    ask: "Paste your key",
    model: "Which model?",
    filter: "type to filter",
    /** The filter is also the field for a model the endpoint would not list. */
    useTyped: (name: string) =>
      name === "" ? "No models to choose from." : `Nothing matches. ↵ uses "${name}" as typed.`,
    tally: (models: number, scrolls: boolean) =>
      scrolls ? `${count(models, "model")} · ↑↓ to scroll` : count(models, "model"),
    hint: "written to .env, never leaves this machine",
    checking: "checking",
    asking: "asking the endpoint what it hosts",
    saved: (path: string) => `saved to ${path}`,
    refused: "That key was refused.",
    empty: "A key is needed to reach the model.",
    noUrl: "An endpoint is needed.",
    loggedOut: (backup: string) => `Signed out. The old key is at ${backup} if you want it back.`,
    noKey: "Nothing to sign out of.",
  },

  /** The rail under the suggestions: what you can press, and what it does. */
  hints: [
    ["/", "skill"],
    ["↵", "send"],
    ["^C", "cancel"],
    ["^D", "exit"],
    ["goat", ""],
  ] as ReadonlyArray<readonly [string, string]>,

  /** Shown once, on the first prompt only. */
  keyHints: "ctrl-c cancel · ctrl-d exit",

  /** The fourth line of the lockup. Playful things, kept apart from the keys. */
  playHints: "click the goat, or type goat",

  /** The label beside an activated skill. */
  skillMark: "skill",
  /** Marks a skill the user named rather than one the model chose. */
  requestedMark: "skill · requested",

  /** What a bare `/skill-name` means when nothing follows it. */
  explicitOnly: "Follow the instructions above.",
  unknownSkill: (name: string, available: string[]) =>
    `No skill named "${name}". Available: ${available.join(", ")}.`,
  /** The label beside a bundled file the agent pulled in. */
  resourceMark: "read",
  /** The label beside a workspace tool that came back with an error. */
  toolFailed: "failed",

  /**
   * What a folded block of reasoning is hiding, and how to open it.
   *
   * The count alone reads as a control, and in a scrolling transcript there is
   * nothing to click — so the row names the thing that actually unfolds it,
   * which differs by surface: a command in the full screen, a flag outside it.
   */
  more: (lines: number) => `+${lines} more`,
  moreWith: (lines: number, how: string) => `+${lines} more · ${how}`,
  /** What unfolds it, named per surface: a command inside the full screen, a flag outside it. */
  thinkingCommand: "/thinking",
  thinkingFlag: "--thinking",
  thinkingShown: "showing the model's reasoning",
  thinkingHidden: "reasoning folded to one line — /thinking to open it",

  cancelled: "cancelled",

  missingKey: "ANTHROPIC_API_KEY is not set.",
  missingKeyHelp: "Add it to a .env file at the project root, or export it in your shell.",
  noSkills: "No skills found. Answering without any.",

  /** Under --verbose, above the system prompt dump. */
  systemPromptLabel: (skills: number) =>
    `system prompt · ${count(skills, "skill")}, names and descriptions only`,

  /** The `goat` command, which is the keyboard way of clicking the goat. */
  goat: {
    command: "goat",

    /** What the goat has to say for itself, set where the wordmark usually sits. */
    about: (skills: number, catalogBytes: number, model: string): string[] => [
      "Greatest Of All Tokens",
      `${count(skills, "skill")} · ${(catalogBytes / 1024).toFixed(1)} KB of catalog`,
      "bodies load only when asked",
      model,
    ],
  },

  /** Footer after a turn. Absent unless one of these has something to say. */
  turnSummary: (skills: number, seconds: number): string | null => {
    const parts: string[] = [];
    if (skills > 0) parts.push(count(skills, "skill"));
    if (seconds >= 2) parts.push(`${seconds.toFixed(1)}s`);
    return parts.length > 0 ? parts.join(" · ") : null;
  },
} as const;

/** "1 skill" / "3 skills" — the plural rule lives with the copy, not the caller. */
export function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}
