import { describe, expect, it } from "vitest";
import { buildPlans, totalRunMs } from "../src/runner/plan.js";
import { checkCapacity, parseVmStatAvailableBytes } from "../src/runner/capacity.js";
import { Lifecycle } from "../src/participant/lifecycle.js";
import { config } from "./fixtures.js";

describe("buildPlans", () => {
  it("assigns publishers first, with camera and microphone by index", () => {
    const plans = buildPlans(config(), "run");
    expect(plans.map((p) => p.profile)).toEqual([
      "presenter",
      "presenter",
      "active",
      "webinarViewer",
      "listener",
      "listener",
      "listener",
      "listener",
      "listener",
      "listener",
    ]);
    expect(plans.slice(0, 3).map((p) => [p.camera, p.microphone])).toEqual([
      [true, true],
      [true, true],
      [false, true],
    ]);
    expect(plans.slice(3).every((p) => !p.camera && !p.microphone)).toBe(true);
  });

  it("spreads joins over ramp-up and leaves over ramp-down", () => {
    const plans = buildPlans(config(), "run");
    expect(plans[0]!.joinAtMs).toBe(0);
    expect(plans.at(-1)!.joinAtMs).toBe(60_000);
    expect(plans[0]!.leaveAtMs).toBe(60_000 + 300_000);
    expect(plans.at(-1)!.leaveAtMs).toBe(60_000 + 300_000 + 30_000);
    expect(new Set(plans.map((p) => p.id)).size).toBe(plans.length);
    expect(totalRunMs(config())).toBe(390_000);
  });

  it("handles a single participant", () => {
    const one = config((i) => {
      i.participants = { total: 1, publishers: 1, subscribers: 0, cameraPublishers: 1, microphonePublishers: 1 };
    });
    expect(buildPlans(one, "r")[0]).toMatchObject({ joinAtMs: 0, profile: "presenter" });
  });
});

describe("checkCapacity", () => {
  it("refuses more participants than one worker allows", () => {
    expect(() => checkCapacity(config((i) => void (i.execution.maxBrowsersPerWorker = 5)))).toThrow(
      /maxBrowsersPerWorker/,
    );
  });

  it("flags machines that are too small", () => {
    const tiny = checkCapacity(config(), { freeMemMb: 1000, cpus: 1 });
    expect(tiny.problems).toHaveLength(2);
    expect(checkCapacity(config(), { freeMemMb: 64_000, cpus: 16 }).problems).toEqual([]);
  });
});

describe("Lifecycle", () => {
  it("follows the participant state machine", () => {
    const seen: string[] = [];
    const l = new Lifecycle((t) => seen.push(t.to));
    for (const s of ["launching", "loading", "authenticating", "joining", "connected", "interacting", "reconnecting", "interacting", "leaving", "completed"] as const) {
      l.to(s);
    }
    expect(seen.at(-1)).toBe("completed");
    expect(l.isTerminal).toBe(true);
    expect(() => l.to("failed")).toThrow(/Illegal/);
  });

  it("rejects skipped steps and allows failing from any live state", () => {
    const l = new Lifecycle();
    expect(() => l.to("connected")).toThrow(/pending -> connected/);
    l.to("launching");
    l.to("failed", "boom");
    expect(l.transitions.at(-1)).toMatchObject({ from: "launching", to: "failed", detail: "boom" });
  });
});

describe("parseVmStatAvailableBytes", () => {
  it("counts free, inactive and speculative pages", () => {
    const sample = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                                    100.",
      "Pages active:                                 9999.",
      "Pages inactive:                                200.",
      "Pages speculative:                              50.",
    ].join("\n");
    expect(parseVmStatAvailableBytes(sample)).toBe(350 * 16384);
    expect(parseVmStatAvailableBytes("garbage")).toBeNull();
  });
});
