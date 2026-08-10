# mini-agent

A small Node.js CLI coding agent that uses Claude Sonnet and the open
[Agent Skills specification](https://agentskills.io/specification). Skills are
discovered from `.skills/` (or `~/.agents/skills/`); only their metadata goes
into the system prompt; full instructions are loaded on demand when the model
(or the user with `/skill-name`) activates them.

## Requirements

- Node.js ≥ 22.18.0
- A key for Anthropic or any gateway that fronts it

## Setup

Nothing to copy. The first run asks for a provider and a key and writes `.env`
itself. To skip that screen, write the file by hand:

```sh
echo "ANTHROPIC_API_KEY=..." >> .env
```

Optional env vars: `ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL` (for a gateway or
Azure endpoint). A Claude model is sent to that endpoint's `/v1/messages`; any
other model is sent to its `/v1/chat/completions`.

## Run

```sh
node bin/mini-agent.js              # interactive TUI
node bin/mini-agent.js --verbose    # shows the full system prompt and skill loading
```

## Test

```sh
npm test          # node --test on all test/*.test.ts files
npm run typecheck # tsc --noEmit, no compilation step needed
```

Tests use Node's built-in `node:test` runner. No Jest, no Vitest.

## Conventions to get right

1. **TypeScript is run directly — never compiled.** Node strips types at
   runtime via `--experimental-strip-types`. `tsc` is only for checking.
   Never add `enum`, parameter properties, or `namespace`; `erasableSyntaxOnly`
   is enforced and the build will break.

2. **Import paths must include the `.ts` extension.** Module resolution is
   `nodenext`. Write `import { foo } from "./foo.ts"` not `"./foo"`.

3. **Skill `name` must equal the containing directory name.** The spec requires
   it; mismatches are surfaced as warnings and the skill may be silently
   shadowed. Keep skill directories lowercase-alphanumeric with single hyphens
   and ≤ 64 characters.
