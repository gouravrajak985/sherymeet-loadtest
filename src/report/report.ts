import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MeetingInfo } from "../config/preflight.js";
import type { TestConfig } from "../config/schema.js";
import type { ErrorCategory, MediaStatus, ParticipantResult } from "../participant/types.js";
import { averageOrNull, distribution, percent, type Distribution } from "./stats.js";

export interface HostSample {
  at: number;
  loadAvg1: number;
  freeMemMb: number;
  runnerRssMb: number;
}

interface PublishSummary {
  requested: number;
  verified: number;
  failed: number;
  notPermitted: number;
}

export interface RunReport {
  schemaVersion: 1;
  runId: string;
  name: string;
  target: {
    meetingUrl: string;
    environment: string;
    roomId: string;
    meetingType: string;
    joinType: string | null;
  };
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  stopReason: string | null;
  participants: {
    planned: number;
    attempted: number;
    notStarted: number;
    connected: number;
    completed: number;
    failed: number;
    /** connected / attempted. Participants never started because the test stopped are excluded. */
    connectionSuccessPct: number | null;
  };
  timingsMs: {
    join: Distribution | null;
    launch: Distribution | null;
    load: Distribution | null;
    authenticate: Distribution | null;
  };
  publishing: { audio: PublishSummary; video: PublishSummary };
  subscribing: { expected: number; verified: number; failed: number; audioVerified: number; videoVerified: number };
  network: {
    rttMs: Distribution | null;
    jitterMs: Distribution | null;
    avgPacketLossPct: number | null;
    avgInboundKbpsPerParticipant: number | null;
    avgOutboundKbpsPerPublisher: number | null;
    candidateTypes: Record<string, number>;
  };
  reconnections: { disconnects: number; reconnects: number; reconnectMs: Distribution | null };
  api: { requests: number; errorsByStatus: Record<string, number>; latencyMs: Distribution | null };
  interactions: ParticipantResult["interactions"];
  errors: {
    byCategory: Partial<Record<ErrorCategory, number>>;
    examples: { participant: string; category: ErrorCategory; message: string }[];
  };
  worker: {
    hostname: string;
    platform: string;
    cpus: number;
    totalMemMb: number;
    maxLoadAvg1: number | null;
    minFreeMemMb: number | null;
    maxRunnerRssMb: number | null;
  };
  /** Metrics this version does not collect; listed so nobody mistakes absence for zero. */
  unavailableMetrics: string[];
}

const EXAMPLES_PER_CATEGORY = 3;

function publishSummary(results: ParticipantResult[], kind: "audio" | "video"): PublishSummary {
  const statuses = results.map((r) => r.publish[kind]).filter((s) => s !== "not_requested");
  const count = (s: MediaStatus) => statuses.filter((x) => x === s).length;
  return {
    requested: statuses.length,
    verified: count("verified"),
    failed: count("failed") + count("pending"),
    notPermitted: count("not_permitted"),
  };
}

export function buildReport(input: {
  runId: string;
  config: TestConfig;
  meeting: MeetingInfo;
  results: ParticipantResult[];
  hostSamples: HostSample[];
  startedAt: number;
  endedAt: number;
  stopReason: string | null;
}): RunReport {
  const { config, meeting, results, hostSamples } = input;
  const attempted = results.filter((r) => r.startedAt !== null);
  const connected = attempted.filter((r) => r.connection.connected);
  const samples = attempted.flatMap((r) => r.samples);

  const byCategory: Partial<Record<ErrorCategory, number>> = {};
  const examples: RunReport["errors"]["examples"] = [];
  for (const r of results) {
    if (!r.error) continue;
    const n = (byCategory[r.error.category] ?? 0) + 1;
    byCategory[r.error.category] = n;
    if (n <= EXAMPLES_PER_CATEGORY) {
      examples.push({ participant: r.name, category: r.error.category, message: r.error.message });
    }
  }

  const errorsByStatus: Record<string, number> = {};
  for (const r of attempted) {
    for (const [status, n] of Object.entries(r.api.errorsByStatus)) {
      errorsByStatus[status] = (errorsByStatus[status] ?? 0) + n;
    }
  }

  const subscribers = attempted.filter((r) => r.subscribe.verified !== null);
  const publishers = attempted.filter((r) => r.publish.audio === "verified" || r.publish.video === "verified");
  const candidateTypes: Record<string, number> = {};
  for (const r of connected) {
    const last = r.samples.findLast((s) => s.candidate !== null)?.candidate;
    if (last) candidateTypes[last] = (candidateTypes[last] ?? 0) + 1;
  }

  const sum = <K extends keyof ParticipantResult["interactions"]>(key: K) =>
    attempted.reduce((n, r) => n + r.interactions[key], 0);

  return {
    schemaVersion: 1,
    runId: input.runId,
    name: config.name,
    target: {
      meetingUrl: config.target.meetingUrl,
      environment: config.target.environment,
      roomId: meeting.roomId,
      meetingType: meeting.type,
      joinType: meeting.joinType,
    },
    startedAt: new Date(input.startedAt).toISOString(),
    endedAt: new Date(input.endedAt).toISOString(),
    durationSeconds: Math.round((input.endedAt - input.startedAt) / 1000),
    stopReason: input.stopReason,
    participants: {
      planned: results.length,
      attempted: attempted.length,
      notStarted: results.length - attempted.length,
      connected: connected.length,
      completed: results.filter((r) => r.outcome === "completed").length,
      failed: results.filter((r) => r.outcome === "failed").length,
      connectionSuccessPct: percent(connected.length, attempted.length),
    },
    timingsMs: {
      join: distribution(connected.map((r) => r.timings.joinMs ?? NaN)),
      launch: distribution(attempted.map((r) => r.timings.launchMs ?? NaN)),
      load: distribution(attempted.map((r) => r.timings.loadMs ?? NaN)),
      authenticate: distribution(attempted.map((r) => r.timings.authMs ?? NaN)),
    },
    publishing: { audio: publishSummary(attempted, "audio"), video: publishSummary(attempted, "video") },
    subscribing: {
      expected: subscribers.length,
      verified: subscribers.filter((r) => r.subscribe.verified).length,
      failed: subscribers.filter((r) => !r.subscribe.verified).length,
      audioVerified: subscribers.filter((r) => r.subscribe.audio === "verified").length,
      videoVerified: subscribers.filter((r) => r.subscribe.video === "verified").length,
    },
    network: {
      rttMs: distribution(samples.map((s) => s.rttMs ?? NaN)),
      jitterMs: distribution(samples.map((s) => s.jitterMs ?? NaN)),
      avgPacketLossPct: averageOrNull(samples.map((s) => s.lossPct)),
      avgInboundKbpsPerParticipant: averageOrNull(
        connected.map((r) => averageOrNull(r.samples.map((s) => s.inKbps))),
      ),
      avgOutboundKbpsPerPublisher: averageOrNull(
        publishers.map((r) => averageOrNull(r.samples.map((s) => s.outKbps))),
      ),
      candidateTypes,
    },
    reconnections: {
      disconnects: attempted.reduce((n, r) => n + r.connection.disconnects, 0),
      reconnects: attempted.reduce((n, r) => n + r.connection.reconnectMs.length, 0),
      reconnectMs: distribution(attempted.flatMap((r) => r.connection.reconnectMs)),
    },
    api: {
      requests: attempted.reduce((n, r) => n + r.api.requests, 0),
      errorsByStatus,
      latencyMs: distribution(attempted.flatMap((r) => r.api.latenciesMs)),
    },
    interactions: {
      chatSent: sum("chatSent"),
      chatBlocked: sum("chatBlocked"),
      handRaises: sum("handRaises"),
      micToggles: sum("micToggles"),
      errors: sum("errors"),
    },
    errors: { byCategory, examples },
    worker: {
      hostname: os.hostname(),
      platform: `${os.platform()} ${os.arch()}`,
      cpus: os.availableParallelism(),
      totalMemMb: Math.round(os.totalmem() / 1048576),
      maxLoadAvg1: hostSamples.length ? Math.max(...hostSamples.map((s) => s.loadAvg1)) : null,
      minFreeMemMb: hostSamples.length ? Math.min(...hostSamples.map((s) => s.freeMemMb)) : null,
      maxRunnerRssMb: hostSamples.length ? Math.max(...hostSamples.map((s) => s.runnerRssMb)) : null,
    },
    unavailableMetrics: [
      "per-browser CPU and memory (only whole-machine load and free memory are sampled)",
      "LiveKit server CPU, memory, bandwidth, and track counts",
      "Redis and MongoDB performance",
      "server-side API latency (api.latencyMs is measured from the browser, including network)",
      "network shaping results (no network profile applied)",
    ],
  };
}

const CSV_COLUMNS = [
  "id",
  "name",
  "profile",
  "camera",
  "microphone",
  "outcome",
  "final_state",
  "error_category",
  "launch_ms",
  "load_ms",
  "auth_ms",
  "join_ms",
  "publish_audio",
  "publish_video",
  "subscribe_audio",
  "subscribe_video",
  "disconnects",
  "avg_rtt_ms",
  "avg_jitter_ms",
  "avg_loss_pct",
  "avg_in_kbps",
  "avg_out_kbps",
  "chat_sent",
  "api_errors",
  "leave_method",
  "error_message",
] as const;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  // Neutralise spreadsheet formula injection from error text.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function participantsCsv(results: ParticipantResult[]): string {
  const rows = results.map((r) => {
    const values: Record<(typeof CSV_COLUMNS)[number], unknown> = {
      id: r.id,
      name: r.name,
      profile: r.profile,
      camera: r.plan.camera,
      microphone: r.plan.microphone,
      outcome: r.outcome,
      final_state: r.finalState,
      error_category: r.error?.category,
      launch_ms: r.timings.launchMs,
      load_ms: r.timings.loadMs,
      auth_ms: r.timings.authMs,
      join_ms: r.timings.joinMs,
      publish_audio: r.publish.audio,
      publish_video: r.publish.video,
      subscribe_audio: r.subscribe.audio,
      subscribe_video: r.subscribe.video,
      disconnects: r.connection.disconnects,
      avg_rtt_ms: averageOrNull(r.samples.map((s) => s.rttMs)),
      avg_jitter_ms: averageOrNull(r.samples.map((s) => s.jitterMs)),
      avg_loss_pct: averageOrNull(r.samples.map((s) => s.lossPct)),
      avg_in_kbps: averageOrNull(r.samples.map((s) => s.inKbps)),
      avg_out_kbps: averageOrNull(r.samples.map((s) => s.outKbps)),
      chat_sent: r.interactions.chatSent,
      api_errors: Object.values(r.api.errorsByStatus).reduce((a, b) => a + b, 0),
      leave_method: r.leaveMethod,
      error_message: r.error?.message,
    };
    return CSV_COLUMNS.map((c) => csvCell(values[c])).join(",");
  });
  return [CSV_COLUMNS.join(","), ...rows].join("\n") + "\n";
}

const fmt = (d: Distribution | null, unit = "ms") =>
  d ? `avg ${d.avg}${unit}, p50 ${d.p50}, p95 ${d.p95}, p99 ${d.p99}, max ${d.max} (n=${d.count})` : "no data";

export function summaryText(report: RunReport, reportDir: string): string {
  const p = report.participants;
  const lines = [
    `Load test: ${report.name}`,
    `Target:    ${report.target.meetingUrl} (${report.target.meetingType}, ${report.target.environment})`,
    `Duration:  ${report.durationSeconds}s${report.stopReason ? `, stopped early: ${report.stopReason}` : ""}`,
    "",
    `Participants: ${p.connected}/${p.attempted} connected (${p.connectionSuccessPct ?? "n/a"}%), ${p.completed} completed, ${p.failed} failed${p.notStarted ? `, ${p.notStarted} never started` : ""}`,
    `Join time:    ${fmt(report.timingsMs.join)}`,
    `Publishing:   audio ${report.publishing.audio.verified}/${report.publishing.audio.requested} verified, video ${report.publishing.video.verified}/${report.publishing.video.requested} verified`,
    `Receiving:    ${report.subscribing.verified}/${report.subscribing.expected} received remote media (audio ${report.subscribing.audioVerified}, video ${report.subscribing.videoVerified})`,
    `RTT:          ${fmt(report.network.rttMs)}`,
    `Jitter:       ${fmt(report.network.jitterMs)}`,
    `Packet loss:  ${report.network.avgPacketLossPct ?? "no data"}${report.network.avgPacketLossPct === null ? "" : "%"} average`,
    `Reconnects:   ${report.reconnections.reconnects} of ${report.reconnections.disconnects} disconnects recovered`,
    `API (browser-measured): ${report.api.requests} requests, errors ${JSON.stringify(report.api.errorsByStatus)}, latency ${fmt(report.api.latencyMs)}`,
    `Worker:       peak load ${report.worker.maxLoadAvg1 ?? "n/a"} on ${report.worker.cpus} CPUs, min free RAM ${report.worker.minFreeMemMb ?? "n/a"} MB`,
  ];
  const categories = Object.entries(report.errors.byCategory);
  if (categories.length) {
    lines.push("", "Errors:");
    for (const [category, n] of categories) lines.push(`  ${category}: ${n}`);
    for (const e of report.errors.examples) lines.push(`    - ${e.participant}: ${e.message}`);
  }
  lines.push("", `Report: ${reportDir}`);
  return lines.join("\n") + "\n";
}

export async function writeReport(reportDir: string, report: RunReport, results: ParticipantResult[]) {
  await writeFile(path.join(reportDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(path.join(reportDir, "participants.json"), JSON.stringify(results, null, 2) + "\n");
  await writeFile(path.join(reportDir, "participants.csv"), participantsCsv(results));
  await writeFile(path.join(reportDir, "summary.txt"), summaryText(report, reportDir));
}
