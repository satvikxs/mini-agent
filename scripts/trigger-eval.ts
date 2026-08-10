#!/usr/bin/env node
/**
 * Trigger eval — does each skill activate on the prompts it should, and stay out
 * of the way on the ones it should not?
 *
 * A skill's `description` is the only thing the model matches on, so the
 * description carries the entire burden of triggering. Unit tests cannot check
 * it: whether a description works is a question about a model's judgement, not
 * about our code. This is how you check it instead.
 *
 * Method follows https://agentskills.io/skill-creation/optimizing-descriptions —
 * a mix of prompts that should trigger and near-misses that share vocabulary but
 * need something different. The near-misses are the valuable half. "What's the
 * weather?" is easy; "write an onboarding guide" is the one that catches a
 * description written too broadly.
 *
 * Needs an API key. Run with: npm run eval
 */

import { styleText } from "node:util";
import { createAgent } from "../src/agent.ts";
import { readClientConfig } from "../src/config.ts";
import { discoverSkills } from "../src/skills.ts";

type Case = {
  prompt: string;
  expect: string[];
  /** Text the answer itself must contain — the skill's own required output. */
  mustContain?: string;
};

/**
 * The header welcome-me demands. Read from the installed skill rather than
 * written here: if the skill is ever updated, this follows it instead of
 * quietly checking a string nobody requires any more.
 */
const REQUIRED_HEADER = (() => {
  const { skills } = discoverSkills();
  const body = skills.find((skill) => skill.name === "welcome-me")?.body ?? "";
  return /^>.*Welcome to our .*!$/m.exec(body)?.[0]?.replace(/^>\s*/, "") ?? "Welcome to our";
})();

const CASES: Case[] = [
  // Should load welcome-me, and having loaded it, must obey it. The phrasings
  // vary well beyond the two the skill's description lists, which is the point:
  // this tests whether the description generalises.
  { prompt: "new to this project what should i do", expect: ["welcome-me"], mustContain: REQUIRED_HEADER },
  { prompt: "I'm new here", expect: ["welcome-me"], mustContain: REQUIRED_HEADER },
  { prompt: "can you welcome me?", expect: ["welcome-me"], mustContain: REQUIRED_HEADER },
  { prompt: "just joined the team, where do I start?", expect: ["welcome-me"], mustContain: REQUIRED_HEADER },

  // The other two skills, each in its own domain, and each with output of its
  // own to check. writing-plans requires an announcement line; internal-comms
  // sends the agent on to a file in examples/, which is tier 3 of progressive
  // disclosure being driven by a skill rather than by us.
  {
    prompt: "I have a spec for adding rate limiting to our API, write me an implementation plan",
    expect: ["writing-plans"],
    mustContain: "writing-plans skill",
  },
  { prompt: "write a 3P update for my team about the auth migration", expect: ["internal-comms"] },
  { prompt: "draft a company newsletter for this month", expect: ["internal-comms"] },

  // Nothing in the catalog fits. Loading anything here is a failure.
  { prompt: "what's the weather?", expect: [] },
  { prompt: "yo sup whats the weather", expect: [] },
  { prompt: "how do I reverse a string in python", expect: [] },
  // A bare greeting sits close to "I'm new here" without being it.
  { prompt: "hey", expect: [] },
];

const same = (a: string[], b: string[]) => a.length === b.length && a.every((item, i) => item === b[i]);
const describe = (skills: string[]) => (skills.length > 0 ? skills.join(", ") : "(none)");

async function runCase(testCase: Case, skills: ReturnType<typeof discoverSkills>["skills"], config: ReturnType<typeof readClientConfig>) {
  const activated: string[] = [];
  // A fresh agent per case: an activation from a previous prompt would still be
  // in the conversation and would pollute the result.
  const agent = createAgent({ skills, ...config! });

  const answer = await agent.send(testCase.prompt, (event) => {
    if (event.type === "skill_activated") activated.push(event.skill);
  });

  activated.sort();
  const triggeredRight = same(activated, [...testCase.expect].sort());
  // Selecting the skill is only half of it. The assignment asks the agent to
  // *follow* the skill, so where a skill demands specific output, check for it.
  const obeyed = testCase.mustContain === undefined || answer.includes(testCase.mustContain);

  return { ...testCase, activated, obeyed, passed: triggeredRight && obeyed };
}

const config = readClientConfig();
if (!config) {
  console.error("ANTHROPIC_API_KEY is not set. Add it to .env at the project root.");
  process.exit(1);
}

const { skills } = discoverSkills();
console.log(`Running ${CASES.length} cases against ${skills.length} skills…\n`);

const results = await Promise.all(CASES.map((testCase) => runCase(testCase, skills, config)));

for (const result of results) {
  const mark = result.passed ? styleText("green", "PASS") : styleText("red", "FAIL");
  console.log(`${mark}  ${result.prompt}`);
  console.log(`      expected ${describe(result.expect)} · got ${describe(result.activated)}`);
  if (result.mustContain !== undefined) {
    console.log(`      required header ${result.obeyed ? "present" : styleText("red", "MISSING")}`);
  }
  console.log();
}

const failed = results.filter((result) => !result.passed).length;
console.log(failed === 0 ? styleText("green", `All ${results.length} cases passed.`) : styleText("red", `${failed} of ${results.length} failed.`));
process.exit(failed === 0 ? 0 : 1);
