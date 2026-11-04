import type { ProfileName } from "../runner/plan.js";
import type { ParticipantState, Transition } from "./lifecycle.js";
import type { IntervalMetrics } from "./webrtc-probe.js";

export type ErrorCategory =
  | "rate_limited"
  | "load_failed"
  | "join_timeout"
  | "webrtc_not_connected"
  | "ui_not_found"
  | "page_crashed"
  | "browser_crashed"
  | "removed_or_ended"
  | "reconnect_timeout"
  | "aborted"
  | "unknown";

/**
 * - verified: bytes measurably flowed in getStats()
 * - failed: requested, but no bytes flowed
 * - not_permitted: SheryMeet's token does not allow publishing it
 * - not_observed: nothing received for this kind (others may not be sending it)
 */
export type MediaStatus =
  | "not_requested"
  | "pending"
  | "verified"
  | "failed"
  | "not_permitted"
  | "not_observed"
  | "skipped";

export class ParticipantError extends Error {
  override name = "ParticipantError";
  constructor(
    readonly category: ErrorCategory,
    message: string,
  ) {
    super(message);
  }
}

export interface ParticipantResult {
  id: string;
  index: number;
  name: string;
  profile: ProfileName;
  plan: { camera: boolean; microphone: boolean };
  outcome: "completed" | "failed" | "aborted";
  finalState: ParticipantState;
  error: { category: ErrorCategory; message: string } | null;
  startedAt: string | null;
  endedAt: string;
  timings: {
    launchMs: number | null;
    loadMs: number | null;
    authMs: number | null;
    joinMs: number | null;
  };
  connection: { connected: boolean; disconnects: number; reconnectMs: number[] };
  publish: { audio: MediaStatus; video: MediaStatus };
  subscribe: { audio: MediaStatus; video: MediaStatus; verified: boolean | null };
  interactions: {
    chatSent: number;
    chatBlocked: number;
    handRaises: number;
    micToggles: number;
    errors: number;
  };
  api: { requests: number; errorsByStatus: Record<string, number>; latenciesMs: number[] };
  leaveMethod: "ui" | "forced" | null;
  samples: IntervalMetrics[];
  transitions: Transition[];
  artifacts: { screenshot?: string; consoleLog?: string };
}
