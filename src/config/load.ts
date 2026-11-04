import { access, readFile } from "node:fs/promises";
import { ConfigError, parseConfig, type TestConfig } from "./schema.js";

export async function loadConfigFile(
  path: string,
  overrides: { meetingUrl?: string } = {},
): Promise<TestConfig> {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`Could not read config ${path}: ${(error as Error).message}`);
  }
  if (overrides.meetingUrl) {
    const target = (raw.target ?? {}) as Record<string, unknown>;
    raw = { ...raw, target: { ...target, meetingUrl: overrides.meetingUrl } };
  }
  const config = parseConfig(raw);
  for (const file of [config.media.videoFile, config.media.audioFile]) {
    if (!file) continue;
    await access(file).catch(() => {
      throw new ConfigError(`Media fixture not found: ${file}`);
    });
  }
  return config;
}
