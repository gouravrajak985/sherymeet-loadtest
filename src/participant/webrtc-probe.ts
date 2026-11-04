/*
 * Browser-side scripts are plain JS strings, not TS functions: tsx/esbuild
 * may inject helpers (e.g. __name) into compiled functions, and those don't
 * exist inside the page.
 */

/** Runs before any page script: records every RTCPeerConnection the app creates. */
export const PROBE_SCRIPT = `(() => {
  if (window.__ltProbe || !window.RTCPeerConnection) return;
  const Native = window.RTCPeerConnection;
  const pcs = [];
  function RTCPeerConnection(...args) {
    const pc = new Native(...args);
    pcs.push(pc);
    return pc;
  }
  RTCPeerConnection.prototype = Native.prototype;
  Object.setPrototypeOf(RTCPeerConnection, Native);
  window.RTCPeerConnection = RTCPeerConnection;
  Object.defineProperty(window, "__ltProbe", { value: { pcs }, enumerable: false });
})();`;

/** Count of peer connections currently in the "connected" state; -1 if the probe is missing. */
export const CONNECTED_COUNT_SCRIPT = `(() => {
  const probe = window.__ltProbe;
  if (!probe) return -1;
  let connected = 0;
  for (const pc of probe.pcs) if (pc.connectionState === "connected") connected++;
  return connected;
})()`;

/** Raw getStats() totals per open peer connection, as JSON-safe data. */
export const STATS_SCRIPT = `(async () => {
  const probe = window.__ltProbe;
  const out = { at: Date.now(), pcs: [] };
  if (!probe) return out;
  const blank = () => ({ bytes: 0, packets: 0, lost: 0, jitter: null, fps: null, width: null, height: null });
  for (const pc of probe.pcs) {
    if (pc.connectionState === "closed") continue;
    const entry = {
      state: pc.connectionState,
      outbound: { audio: blank(), video: blank() },
      inbound: { audio: blank(), video: blank() },
      rtt: null,
      candidate: null,
    };
    let report;
    try {
      report = await pc.getStats();
    } catch (e) {
      out.pcs.push(entry);
      continue;
    }
    const byId = new Map();
    report.forEach((s) => byId.set(s.id, s));
    report.forEach((s) => {
      const kind = s.kind || s.mediaType;
      if ((s.type === "outbound-rtp" || s.type === "inbound-rtp") && (kind === "audio" || kind === "video")) {
        const outbound = s.type === "outbound-rtp";
        const t = (outbound ? entry.outbound : entry.inbound)[kind];
        t.bytes += (outbound ? s.bytesSent : s.bytesReceived) || 0;
        t.packets += (outbound ? s.packetsSent : s.packetsReceived) || 0;
        if (!outbound) {
          t.lost += Math.max(0, s.packetsLost || 0);
          if (typeof s.jitter === "number") t.jitter = Math.max(t.jitter ?? 0, s.jitter);
        }
        if (typeof s.framesPerSecond === "number") t.fps = Math.max(t.fps ?? 0, s.framesPerSecond);
        if (s.frameWidth) {
          t.width = Math.max(t.width ?? 0, s.frameWidth);
          t.height = Math.max(t.height ?? 0, s.frameHeight || 0);
        }
      } else if (s.type === "candidate-pair" && s.state === "succeeded" && (s.nominated || s.selected)) {
        if (typeof s.currentRoundTripTime === "number") entry.rtt = s.currentRoundTripTime;
        const local = byId.get(s.localCandidateId);
        const remote = byId.get(s.remoteCandidateId);
        entry.candidate = {
          local: local ? [local.candidateType, local.protocol].filter(Boolean).join("/") : null,
          remote: remote ? remote.candidateType || null : null,
        };
      }
    });
    out.pcs.push(entry);
  }
  return out;
})()`;

export interface KindTotals {
  bytes: number;
  packets: number;
  lost: number;
  jitter: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
}

export interface RawPcStats {
  state: string;
  outbound: { audio: KindTotals; video: KindTotals };
  inbound: { audio: KindTotals; video: KindTotals };
  rtt: number | null;
  candidate: { local: string | null; remote: string | null } | null;
}

export interface RawStats {
  at: number;
  pcs: RawPcStats[];
}

export interface Snapshot {
  at: number;
  connectedPcs: number;
  out: { audioBytes: number; videoBytes: number; videoFps: number | null; videoWidth: number | null; videoHeight: number | null };
  in: {
    audioBytes: number;
    videoBytes: number;
    packets: number;
    lost: number;
    jitterMs: number | null;
    videoFps: number | null;
  };
  rttMs: number | null;
  candidate: string | null;
}

export interface IntervalMetrics {
  at: number;
  seconds: number;
  out: { audioBytes: number; videoBytes: number };
  in: { audioBytes: number; videoBytes: number };
  outKbps: number;
  inKbps: number;
  /** null when no packets were expected in this interval. */
  lossPct: number | null;
  rttMs: number | null;
  jitterMs: number | null;
  videoFpsIn: number | null;
  videoFpsOut: number | null;
  /** Selected ICE candidate pair, e.g. "host/udp -> relay". */
  candidate: string | null;
}

const maxOrNull = (values: (number | null)[]): number | null => {
  const present = values.filter((v): v is number => v !== null);
  return present.length ? Math.max(...present) : null;
};

export function summarize(raw: RawStats): Snapshot {
  const rtts = raw.pcs.map((pc) => pc.rtt).filter((v): v is number => v !== null);
  const jitter = maxOrNull(raw.pcs.flatMap((pc) => [pc.inbound.audio.jitter, pc.inbound.video.jitter]));
  const candidate = raw.pcs.find((pc) => pc.candidate)?.candidate;
  return {
    at: raw.at,
    connectedPcs: raw.pcs.filter((pc) => pc.state === "connected").length,
    out: {
      audioBytes: raw.pcs.reduce((n, pc) => n + pc.outbound.audio.bytes, 0),
      videoBytes: raw.pcs.reduce((n, pc) => n + pc.outbound.video.bytes, 0),
      videoFps: maxOrNull(raw.pcs.map((pc) => pc.outbound.video.fps)),
      videoWidth: maxOrNull(raw.pcs.map((pc) => pc.outbound.video.width)),
      videoHeight: maxOrNull(raw.pcs.map((pc) => pc.outbound.video.height)),
    },
    in: {
      audioBytes: raw.pcs.reduce((n, pc) => n + pc.inbound.audio.bytes, 0),
      videoBytes: raw.pcs.reduce((n, pc) => n + pc.inbound.video.bytes, 0),
      packets: raw.pcs.reduce((n, pc) => n + pc.inbound.audio.packets + pc.inbound.video.packets, 0),
      lost: raw.pcs.reduce((n, pc) => n + pc.inbound.audio.lost + pc.inbound.video.lost, 0),
      jitterMs: jitter === null ? null : Math.round(jitter * 10000) / 10,
      videoFps: maxOrNull(raw.pcs.map((pc) => pc.inbound.video.fps)),
    },
    rttMs: rtts.length ? Math.round((rtts.reduce((a, b) => a + b, 0) / rtts.length) * 10000) / 10 : null,
    candidate: candidate ? `${candidate.local ?? "?"} -> ${candidate.remote ?? "?"}` : null,
  };
}

// Counters restart when LiveKit replaces a peer connection; clamp instead of going negative.
const grew = (before: number, after: number) => Math.max(0, after - before);

export function diff(prev: Snapshot, next: Snapshot): IntervalMetrics {
  const seconds = Math.max(0.001, (next.at - prev.at) / 1000);
  const out = {
    audioBytes: grew(prev.out.audioBytes, next.out.audioBytes),
    videoBytes: grew(prev.out.videoBytes, next.out.videoBytes),
  };
  const inn = {
    audioBytes: grew(prev.in.audioBytes, next.in.audioBytes),
    videoBytes: grew(prev.in.videoBytes, next.in.videoBytes),
  };
  const received = grew(prev.in.packets, next.in.packets);
  const lost = grew(prev.in.lost, next.in.lost);
  const kbps = (bytes: number) => Math.round(((bytes * 8) / 1000 / seconds) * 10) / 10;
  return {
    at: next.at,
    seconds: Math.round(seconds * 10) / 10,
    out,
    in: inn,
    outKbps: kbps(out.audioBytes + out.videoBytes),
    inKbps: kbps(inn.audioBytes + inn.videoBytes),
    lossPct: received + lost > 0 ? Math.round((lost / (received + lost)) * 10000) / 100 : null,
    rttMs: next.rttMs,
    jitterMs: next.in.jitterMs,
    videoFpsIn: next.in.videoFps,
    videoFpsOut: next.out.videoFps,
    candidate: next.candidate,
  };
}
