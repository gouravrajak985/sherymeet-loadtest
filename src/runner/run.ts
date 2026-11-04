import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setMaxListeners } from "node:events";
import type { TestConfig } from "../config/schema.js";
import type { MeetingInfo } from "../config/preflight.js";
import { log } from "../log.js";
import { VirtualParticipant } from "../participant/participant.js";
import { PARTICIPANT_STATES, type ParticipantState } from "../participant/lifecycle.js";
import type { ParticipantResult } from "../participant/types.js";
import { buildReport, writeReport, type HostSample, type RunReport } from "../report/report.js";
import { slugify, sleep } from "../util.js";
import { BrowserHost, chromiumLaunchOptions } from "./browser-host.js";
import { buildPlans, totalRunMs, type ParticipantPlan } from "./plan.js";
import { currentHostResources } from "./capacity.js";

export interface RunOptions {
  config: TestConfig;
  meeting: MeetingInfo;
  outDir: string;
}

export interface RunOutcome {
  report: RunReport;
  reportDir: string;
}

const STATUS_EVERY_MS = 5_000;
const HOST_SAMPLE_EVERY_MS = 10_000;
/** Extra time past the planned end before the run is force-stopped. */
const HARD_DEADLINE_SLACK_MS = 120_000;

export async function runLoadTest({ config, meeting, outDir }: RunOptions): Promise<RunOutcome> {
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${slugify(config.name)}`;
  const reportDir = path.resolve(outDir, runId);
  const artifactsDir = path.join(reportDir, "artifacts");
  await mkdir(artifactsDir, { recursive: true });

  const plans = buildPlans(config, runId);
  const controller = new AbortController();
  setMaxListeners(plans.length * 4 + 20, controller.signal);
  const host = new BrowserHost(chromiumLaunchOptions(config));
  const events = createWriteStream(path.join(reportDir, "events.ndjson"), { flags: "a" });
  const states = new Map<string, ParticipantState>(plans.map((p) => [p.id, "pending"]));

  const writeEvent = (event: Record<string, unknown>) =>
    events.write(JSON.stringify({ t: new Date().toISOString(), runId, ...event }) + "\n");

  const onTransition = (plan: ParticipantPlan, t: { from: string; to: string; detail?: string }) => {
    states.set(plan.id, t.to as ParticipantState);
    writeEvent({ type: "transition", participant: plan.id, ...t });
    if (t.to === "failed") log("warn", "participant failed", { participant: plan.name, detail: t.detail });
  };

  let stopReason: string | null = null;
  const stop = (reason: string) => {
    if (controller.signal.aborted) return;
    stopReason = reason;
    log("warn", "stopping test: connected participants will leave gracefully", { reason });
    writeEvent({ type: "stop", reason });
    controller.abort();
  };

  let interrupts = 0;
  const onSigint = () => {
    interrupts++;
    if (interrupts === 1) stop("interrupted (Ctrl+C); press again to force-quit");
    else {
      log("error", "force-quitting");
      void host.close().finally(() => process.exit(130));
    }
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigint);

  const plannedMs = totalRunMs(config);
  const hardDeadlineMs =
    plannedMs + (config.execution.joinTimeoutSeconds + config.execution.leaveTimeoutSeconds) * 1000 + HARD_DEADLINE_SLACK_MS;
  const hardDeadline = setTimeout(() => {
    stop(`hard deadline reached (${Math.round(hardDeadlineMs / 1000)}s)`);
    setTimeout(() => void host.close(), (config.execution.leaveTimeoutSeconds + 15) * 1000).unref();
  }, hardDeadlineMs);

  const hostSamples: HostSample[] = [];
  const sampleHost = () =>
    hostSamples.push({
      at: Date.now(),
      loadAvg1: Math.round(os.loadavg()[0]! * 100) / 100,
      freeMemMb: currentHostResources().freeMemMb,
      runnerRssMb: Math.round(process.memoryUsage().rss / 1048576),
    });
  sampleHost();
  const hostTimer = setInterval(sampleHost, HOST_SAMPLE_EVERY_MS);

  const statusTimer = setInterval(() => {
    const counts: Partial<Record<ParticipantState, number>> = {};
    for (const s of states.values()) counts[s] = (counts[s] ?? 0) + 1;
    const ordered = Object.fromEntries(
      PARTICIPANT_STATES.filter((s) => counts[s]).map((s) => [s, counts[s]]),
    );
    log("info", "status", ordered);
    writeEvent({ type: "status", counts: ordered });
  }, STATUS_EVERY_MS);

  const startedAt = Date.now();
  log("info", "test started", {
    runId,
    participants: plans.length,
    plannedSeconds: Math.round(plannedMs / 1000),
    reportDir,
  });
  writeEvent({ type: "start", participants: plans.length, meeting });

  const runOne = async (plan: ParticipantPlan): Promise<ParticipantResult> => {
    await sleep(startedAt + plan.joinAtMs - Date.now(), controller.signal);
    if (controller.signal.aborted) {
      states.set(plan.id, "failed");
      return VirtualParticipant.notStarted(plan);
    }
    const participantStartedAt = Date.now();
    let browser;
    try {
      browser = await host.get();
    } catch (error) {
      log("error", "could not launch Chromium", { error: String(error) });
      stop("Chromium failed to launch");
      states.set(plan.id, "failed");
      return VirtualParticipant.notStarted(plan);
    }
    return new VirtualParticipant({
      browser,
      config,
      plan,
      meeting,
      runStartedAt: startedAt,
      signal: controller.signal,
      artifactsDir,
      isBrowserCrashed: () => host.crashedSince(participantStartedAt),
      onTransition,
    }).run();
  };

  let results: ParticipantResult[];
  try {
    results = await Promise.all(plans.map(runOne));
  } finally {
    clearTimeout(hardDeadline);
    clearInterval(statusTimer);
    clearInterval(hostTimer);
    sampleHost();
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigint);
    await host.close();
  }

  const report = buildReport({
    runId,
    config,
    meeting,
    results,
    hostSamples,
    startedAt,
    endedAt: Date.now(),
    stopReason,
  });
  writeEvent({ type: "end", stopReason });
  await new Promise<void>((resolve) => events.end(resolve));
  await writeReport(reportDir, report, results);
  return { report, reportDir };
}
