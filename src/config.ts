import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

export type ClientConfig = {
  apiKey: string;
  model?: string;
  /** An Anthropic-compatible endpoint. Unset means api.anthropic.com. */
  baseURL?: string;
};

/** Loads .env from the project root, then the working directory. */
function loadEnv(): void {
  loadDotenv({
    path: [resolve(import.meta.dirname, "..", ".env"), resolve(process.cwd(), ".env")],
    quiet: true,
  });
}

/** Reads the client settings from the environment. Null when there is no API key. */
export function readClientConfig(): ClientConfig | null {
  loadEnv();

  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) return null;

  const model = process.env["ANTHROPIC_MODEL"];
  const baseURL = process.env["ANTHROPIC_BASE_URL"];
  return { apiKey, ...(model ? { model } : {}), ...(baseURL ? { baseURL } : {}) };
}
