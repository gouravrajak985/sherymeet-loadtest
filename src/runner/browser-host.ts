import path from "node:path";
import { chromium, type Browser, type LaunchOptions } from "playwright";
import type { TestConfig } from "../config/schema.js";
import { log } from "../log.js";

export function chromiumLaunchOptions(config: TestConfig): LaunchOptions {
  const args = [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-dev-shm-usage",
  ];
  // Fixture flags apply to the whole browser, so every publisher sends the same media.
  if (config.media.videoFile) {
    args.push(`--use-file-for-fake-video-capture=${path.resolve(config.media.videoFile)}`);
  }
  if (config.media.audioFile) {
    args.push(`--use-file-for-fake-audio-capture=${path.resolve(config.media.audioFile)}`);
  }
  return { headless: config.execution.headless, args };
}

/**
 * One shared Chromium; each participant gets an isolated context. If Chromium
 * crashes, participants already running on it fail (their sessions are gone),
 * and the next participant to start gets a fresh browser.
 */
export class BrowserHost {
  private browser?: Browser;
  private launching?: Promise<Browser>;
  private lastCrashAt: number | null = null;
  private closing = false;

  constructor(private readonly options: LaunchOptions) {}

  async get(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.launching ??= chromium
      .launch(this.options)
      .then((browser) => {
        browser.on("disconnected", () => {
          if (this.closing) return;
          this.lastCrashAt = Date.now();
          log("error", "Chromium disconnected unexpectedly; participants not yet started get a new browser");
        });
        this.browser = browser;
        return browser;
      })
      .finally(() => {
        this.launching = undefined;
      });
    return this.launching;
  }

  crashedSince(since: number): boolean {
    return this.lastCrashAt !== null && this.lastCrashAt >= since;
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.browser?.close().catch(() => undefined);
  }
}
