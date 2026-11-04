import { execFileSync } from "node:child_process";
import os from "node:os";
import type { TestConfig } from "../config/schema.js";
import { ConfigError } from "../config/schema.js";

/** Rough per-participant cost of a headless Chromium context with fake media. */
export const COST = {
  browserBaseMb: 400,
  publisherMb: 300,
  subscriberMb: 150,
  publisherCpu: 0.5,
  subscriberCpu: 0.2,
} as const;

export interface HostResources {
  freeMemMb: number;
  cpus: number;
}

export interface CapacityCheck {
  memNeededMb: number;
  cpuNeeded: number;
  host: HostResources;
  /** Overridable with --skip-resource-guard. */
  problems: string[];
}

/**
 * macOS reports only never-used pages as free, so os.freemem() ignores the
 * inactive cache the OS hands back on demand. Linux's figure is
 * already MemAvailable.
 */
export function parseVmStatAvailableBytes(vmStat: string): number | null {
  const pageSize = Number(vmStat.match(/page size of (\d+) bytes/)?.[1]);
  if (!pageSize) return null;
  const pages = (label: string) =>
    Number(vmStat.match(new RegExp(`^${label}:\\s+(\\d+)`, "m"))?.[1] ?? 0);
  return (
    (pages("Pages free") + pages("Pages inactive") + pages("Pages speculative")) *
    pageSize
  );
}

function availableMemoryBytes(): number {
  if (os.platform() === "darwin") {
    try {
      const available = parseVmStatAvailableBytes(execFileSync("vm_stat", { encoding: "utf8" }));
      if (available) return available;
    } catch {
      // fall through to os.freemem()
    }
  }
  return os.freemem();
}

export function currentHostResources(): HostResources {
  return { freeMemMb: Math.round(availableMemoryBytes() / 1048576), cpus: os.availableParallelism() };
}

export function checkCapacity(
  config: TestConfig,
  host: HostResources = currentHostResources(),
): CapacityCheck {
  const { total, publishers, subscribers } = config.participants;
  if (total > config.execution.maxBrowsersPerWorker) {
    throw new ConfigError(
      `total (${total}) exceeds maxBrowsersPerWorker (${config.execution.maxBrowsersPerWorker}). Every participant must stay connected at the same time, and this version runs one worker; splitting across machines comes with distributed workers.`,
    );
  }
  const memNeededMb =
    COST.browserBaseMb + publishers * COST.publisherMb + subscribers * COST.subscriberMb;
  const cpuNeeded =
    Math.round((publishers * COST.publisherCpu + subscribers * COST.subscriberCpu) * 10) / 10;
  const problems: string[] = [];
  if (memNeededMb > host.freeMemMb * 0.8) {
    problems.push(
      `Needs ~${memNeededMb} MB of RAM, but only ${host.freeMemMb} MB is free (limit: 80%).`,
    );
  }
  if (cpuNeeded > host.cpus) {
    problems.push(`Needs ~${cpuNeeded} CPU cores, but this machine has ${host.cpus}.`);
  }
  return { memNeededMb, cpuNeeded, host, problems };
}
