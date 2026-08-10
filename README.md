# mini-agent

A small Node.js CLI coding agent built on the open
[Agent Skills specification](https://agentskills.io/specification). It runs on Claude and
on open models too. A Claude id goes to the endpoint's `/v1/messages`, anything else to
its `/v1/chat/completions`, so whatever your provider lists is what you can pick.

## Run it

```sh
npm install
npm start
```

Try these prompts:

```text
I'm new to this project, what should I do
```

```text
what's the weather?
```

```text
write a 3P update for my team about the auth migration
```

The first loads `welcome-me` and prints the header that skill requires. The second loads
nothing at all. Add `--verbose` to see the system prompt for it, which holds three skill
names and descriptions and no instructions. The third loads `internal-comms`, which then
sends the agent for one of its four bundled files.

The agent discovers skills from `.skills/`, puts only their metadata in the system prompt,
and loads a skill's full instructions when the model asks for it, or when you name one
yourself with `/welcome-me`. Bundled files are a further step again.

All three skills are installed unmodified from
[CommandCodeAI/agent-skills](https://github.com/CommandCodeAI/agent-skills).
