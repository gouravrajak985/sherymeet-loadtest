import type { TestConfig } from "../config/schema.js";

export type ProfileName = "presenter" | "active" | "webinarViewer" | "listener";

export interface ParticipantPlan {
  index: number;
  id: string;
  name: string;
  profile: ProfileName;
  camera: boolean;
  microphone: boolean;
  /** Offset from the test start. */
  joinAtMs: number;
  leaveAtMs: number;
}

/**
 * Publishers come first so their tracks are flowing when subscribers join.
 * Publisher #i sends camera if i < cameraPublishers and microphone if
 * i < microphonePublishers. Subscribers are split into interactive viewers
 * and passive listeners.
 */
export function buildPlans(config: TestConfig, runId: string): ParticipantPlan[] {
  const p = config.participants;
  const { rampUpSeconds, durationMinutes, rampDownSeconds } = config.execution;
  const rampUpMs = rampUpSeconds * 1000;
  const steadyMs = durationMinutes * 60_000;
  const rampDownMs = rampDownSeconds * 1000;
  const interactiveSubscribers = Math.round(p.subscribers * p.interactiveSubscriberRatio);
  const spread = (windowMs: number, i: number) =>
    p.total === 1 ? 0 : Math.round((windowMs * i) / (p.total - 1));

  return Array.from({ length: p.total }, (_, i) => {
    const camera = i < p.cameraPublishers;
    const microphone = i < p.microphonePublishers;
    const profile: ProfileName =
      i < p.publishers
        ? camera
          ? "presenter"
          : "active"
        : i - p.publishers < interactiveSubscribers
          ? "webinarViewer"
          : "listener";
    const number = String(i + 1).padStart(3, "0");
    return {
      index: i,
      id: `${runId}-p${number}`,
      name: `${p.namePrefix} ${number}`,
      profile,
      camera,
      microphone,
      joinAtMs: spread(rampUpMs, i),
      leaveAtMs: rampUpMs + steadyMs + spread(rampDownMs, i),
    };
  });
}

export function totalRunMs(config: TestConfig): number {
  const e = config.execution;
  return (e.rampUpSeconds + e.durationMinutes * 60 + e.rampDownSeconds) * 1000;
}
