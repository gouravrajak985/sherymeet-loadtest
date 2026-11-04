import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config/schema.js";
import {
  checkTargetSafety,
  minimumRampUpSeconds,
  parseMeetingUrl,
  safetyContextFromEnv,
  type SafetyContext,
} from "../src/config/safety.js";
import { checkMeetingCompatible } from "../src/config/preflight.js";
import { baseInput, config } from "./fixtures.js";

const ctx = (patch: Partial<SafetyContext> = {}): SafetyContext => ({
  allowedHosts: ["meet.example.com"],
  productionHardMax: 50,
  ...patch,
});

describe("config schema", () => {
  it("applies defaults", () => {
    const c = config();
    expect(c.execution.joinTimeoutSeconds).toBe(90);
    expect(c.target.ipRateLimit).toEqual({ perMinute: 500, burstPer10s: 125 });
    expect(c.interactions.chat.messages.length).toBeGreaterThan(0);
    expect(c.network.profile).toBe("none");
  });

  it("requires publishers + subscribers to equal total", () => {
    expect(() => config((i) => void (i.participants.subscribers = 6))).toThrow(/must equal total/);
  });

  it("requires publishers to equal max(camera, microphone)", () => {
    expect(() => config((i) => void (i.participants.cameraPublishers = 1, i.participants.microphonePublishers = 1))).toThrow(
      /publishers must equal max/,
    );
  });

  it("rejects unknown keys and unsupported network profiles", () => {
    expect(() => parseConfig({ ...baseInput(), surprise: true })).toThrow(ConfigError);
    expect(() => parseConfig({ ...baseInput(), network: { profile: "mobile-4g" } })).toThrow(/network.profile/);
  });

  it("rejects bad chat ranges", () => {
    expect(() => config((i) => void (i.interactions = { chat: { everySeconds: [90, 30] } }))).toThrow(/min <= max/);
  });
});

describe("meeting URL", () => {
  it("extracts the room id", () => {
    expect(parseMeetingUrl("https://meet.example.com/meet/abc-123").roomId).toBe("abc-123");
  });

  it("rejects other paths and host links with tokens", () => {
    expect(() => parseMeetingUrl("https://meet.example.com/meeting/abc")).toThrow(/\/meet\/<roomId>/);
    expect(() => parseMeetingUrl("https://meet.example.com/meet/abc?token=x")).toThrow(/query string/);
  });
});

describe("target safety", () => {
  it("requires the host to be allowlisted", () => {
    expect(() => checkTargetSafety(config(), ctx({ allowedHosts: [] }))).toThrow(/LOADTEST_ALLOWED_HOSTS/);
  });

  it("requires https for remote hosts", () => {
    const c = config((i) => void (i.target.meetingUrl = "http://meet.example.com/meet/room-123"));
    expect(() => checkTargetSafety(c, ctx())).toThrow(/https/);
  });

  it("requires explicit confirmation and a ceiling for production", () => {
    const prod = config((i) => void (i.target.environment = "production"));
    expect(() => checkTargetSafety(prod, ctx())).toThrow(/--confirm-production=meet.example.com/);
    expect(checkTargetSafety(prod, ctx({ confirmProductionHost: "meet.example.com" })).warnings[0]).toMatch(/Production/);
    expect(() =>
      checkTargetSafety(prod, ctx({ confirmProductionHost: "meet.example.com", productionHardMax: 5 })),
    ).toThrow(/capped at 5/);
  });

  it("rejects 'local' environment for remote hosts", () => {
    const c = config((i) => void (i.target.environment = "local"));
    expect(() => checkTargetSafety(c, ctx())).toThrow(/not a local host/);
  });

  it("warns when ramp-up would trip the per-IP rate limit", () => {
    const fast = config((i) => {
      i.execution.rampUpSeconds = 0;
      i.target.ipRateLimit = { perMinute: 60, burstPer10s: 15 };
    });
    expect(checkTargetSafety(fast, ctx()).warnings.join()).toMatch(/429/);
    expect(checkTargetSafety(config(), ctx()).warnings).toEqual([]);
  });

  it("parses the environment", () => {
    const s = safetyContextFromEnv({ LOADTEST_ALLOWED_HOSTS: " Meet.Example.com , ,x.io" }, "MEET.example.com");
    expect(s.allowedHosts).toEqual(["meet.example.com", "x.io"]);
    expect(s.confirmProductionHost).toBe("meet.example.com");
    expect(s.productionHardMax).toBe(50);
    expect(() => safetyContextFromEnv({ LOADTEST_PRODUCTION_HARD_MAX: "abc" })).toThrow();
  });
});

describe("minimumRampUpSeconds", () => {
  const limit = { perMinute: 60, burstPer10s: 15 };
  it("is zero when every join fits in one burst", () => {
    expect(minimumRampUpSeconds(7, limit)).toBe(0);
  });
  it("is bounded by the per-minute limit for larger tests", () => {
    expect(minimumRampUpSeconds(50, limit)).toBe(100);
  });
});

describe("meeting compatibility", () => {
  const live = { roomId: "r", type: "meet", joinType: null, status: "active" };
  it("accepts a live anonymous meeting", () => {
    expect(() => checkMeetingCompatible(live, config())).not.toThrow();
  });
  it("rejects meetings that have not started or have ended", () => {
    expect(() => checkMeetingCompatible({ ...live, status: "scheduled" }, config())).toThrow(/not live yet/);
    expect(() => checkMeetingCompatible({ ...live, status: "ended" }, config())).toThrow(/ended/);
  });
  it("rejects registered webinars and webinar publishers", () => {
    expect(() =>
      checkMeetingCompatible({ ...live, type: "webinar", joinType: "registered" }, config()),
    ).toThrow(/Google sign-in/);
    expect(() =>
      checkMeetingCompatible({ ...live, type: "webinar", joinType: "anonymous" }, config()),
    ).toThrow(/can't publish/);
  });
});
