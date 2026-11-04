import { describe, expect, it } from "vitest";
import { distribution, averageOrNull } from "../src/report/stats.js";
import { diff, summarize, type KindTotals, type RawPcStats } from "../src/participant/webrtc-probe.js";
import { participantsCsv } from "../src/report/report.js";
import type { ParticipantResult } from "../src/participant/types.js";

const totals = (patch: Partial<KindTotals> = {}): KindTotals => ({
  bytes: 0,
  packets: 0,
  lost: 0,
  jitter: null,
  fps: null,
  width: null,
  height: null,
  ...patch,
});

const pc = (patch: Partial<RawPcStats> = {}): RawPcStats => ({
  state: "connected",
  outbound: { audio: totals(), video: totals() },
  inbound: { audio: totals(), video: totals() },
  rtt: null,
  candidate: null,
  ...patch,
});

describe("distribution", () => {
  it("returns null instead of zeros for no data", () => {
    expect(distribution([])).toBeNull();
    expect(distribution([NaN])).toBeNull();
    expect(averageOrNull([null, null])).toBeNull();
  });

  it("computes nearest-rank percentiles", () => {
    const d = distribution(Array.from({ length: 100 }, (_, i) => i + 1))!;
    expect(d).toMatchObject({ count: 100, min: 1, p50: 50, p95: 95, p99: 99, max: 100, avg: 50.5 });
  });
});

describe("WebRTC stats", () => {
  it("sums peer connections and converts units", () => {
    const s = summarize({
      at: 1000,
      pcs: [
        pc({
          outbound: { audio: totals({ bytes: 100 }), video: totals({ bytes: 900, fps: 24, width: 640, height: 480 }) },
          rtt: 0.05,
          candidate: { local: "host/udp", remote: "relay" },
        }),
        pc({
          state: "connecting",
          inbound: { audio: totals({ bytes: 50, packets: 90, lost: 10, jitter: 0.012 }), video: totals() },
          rtt: 0.07,
        }),
      ],
    });
    expect(s).toMatchObject({
      connectedPcs: 1,
      out: { audioBytes: 100, videoBytes: 900, videoFps: 24, videoWidth: 640 },
      in: { audioBytes: 50, packets: 90, lost: 10, jitterMs: 12 },
      rttMs: 60,
      candidate: "host/udp -> relay",
    });
  });

  it("derives bitrate and interval packet loss, clamping counter resets", () => {
    const a = summarize({ at: 0, pcs: [pc({ inbound: { audio: totals({ bytes: 1000, packets: 100, lost: 0 }), video: totals() } })] });
    const b = summarize({ at: 2000, pcs: [pc({ inbound: { audio: totals({ bytes: 26000, packets: 195, lost: 5 }), video: totals() } })] });
    const d = diff(a, b);
    expect(d.inKbps).toBe(100);
    expect(d.lossPct).toBe(5);
    const reset = diff(b, summarize({ at: 4000, pcs: [pc()] }));
    expect(reset.in.audioBytes).toBe(0);
    expect(reset.lossPct).toBeNull();
  });
});

describe("participantsCsv", () => {
  it("escapes values and neutralises formulas", () => {
    const row = {
      id: "p1",
      name: "Bot 001",
      profile: "listener",
      plan: { camera: false, microphone: false },
      outcome: "failed",
      finalState: "failed",
      error: { category: "unknown", message: '=HYPERLINK("x"), with comma' },
      timings: { launchMs: 1, loadMs: 2, authMs: 3, joinMs: null },
      connection: { connected: false, disconnects: 0, reconnectMs: [] },
      publish: { audio: "not_requested", video: "not_requested" },
      subscribe: { audio: "skipped", video: "skipped", verified: null },
      interactions: { chatSent: 0, chatBlocked: 0, handRaises: 0, micToggles: 0, errors: 0 },
      api: { requests: 2, errorsByStatus: { "429": 1 }, latenciesMs: [] },
      samples: [],
    } as unknown as ParticipantResult;
    const [, line] = participantsCsv([row]).trim().split("\n");
    expect(line).toContain(`"'=HYPERLINK(""x""), with comma"`);
    expect(line).toContain(",1,"); // api_errors
  });
});
