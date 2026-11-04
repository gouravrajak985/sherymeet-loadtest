import { ConfigError, type TestConfig } from "./schema.js";

export interface SafetyContext {
  /** Hosts (host[:port]) explicitly allowed as targets, from LOADTEST_ALLOWED_HOSTS. */
  allowedHosts: string[];
  /** Must equal the target host before a production test may run. */
  confirmProductionHost?: string;
  /** Absolute participant ceiling for production targets. */
  productionHardMax: number;
}

export interface MeetingTarget {
  url: URL;
  origin: string;
  host: string;
  hostname: string;
  roomId: string;
}

/** API calls a browser makes to join an anonymous meeting: /details then /get-token. */
export const REQUESTS_PER_JOIN = 2;

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function parseMeetingUrl(meetingUrl: string): MeetingTarget {
  let url: URL;
  try {
    url = new URL(meetingUrl);
  } catch {
    throw new ConfigError(`meetingUrl is not a valid URL: ${meetingUrl}`);
  }
  const match = url.pathname.match(/^\/meet\/([A-Za-z0-9_-]+)\/?$/);
  if (!match?.[1]) {
    throw new ConfigError(
      `meetingUrl must look like https://<host>/meet/<roomId>; got path "${url.pathname}"`,
    );
  }
  if (url.search) {
    throw new ConfigError(
      "meetingUrl must not contain a query string; host links carry a host token. Use the participant join link.",
    );
  }
  return { url, origin: url.origin, host: url.host, hostname: url.hostname, roomId: match[1] };
}

/**
 * Shortest ramp-up that keeps one worker IP under SheryMeet's per-IP limits.
 * Returns 0 when every join fits inside a single burst window.
 */
export function minimumRampUpSeconds(
  total: number,
  limit: { perMinute: number; burstPer10s: number },
): number {
  const requests = total * REQUESTS_PER_JOIN;
  if (requests <= Math.min(limit.burstPer10s, limit.perMinute)) return 0;
  const byMinute = (requests / limit.perMinute) * 60;
  const byBurst = (requests / limit.burstPer10s) * 10;
  return Math.ceil(Math.max(byMinute, byBurst));
}

/** Throws ConfigError for unsafe targets; returns non-fatal warnings. */
export function checkTargetSafety(config: TestConfig, ctx: SafetyContext): { warnings: string[] } {
  const target = parseMeetingUrl(config.target.meetingUrl);
  const isLocal = LOCAL_HOSTNAMES.has(target.hostname);
  const warnings: string[] = [];

  if (!isLocal && target.url.protocol !== "https:") {
    throw new ConfigError("Non-local targets must use https.");
  }
  if (config.target.environment === "local" && !isLocal) {
    throw new ConfigError(
      `environment is "local" but ${target.host} is not a local host. Set the real environment.`,
    );
  }
  if (!ctx.allowedHosts.includes(target.host)) {
    throw new ConfigError(
      `Host ${target.host} is not in LOADTEST_ALLOWED_HOSTS (${ctx.allowedHosts.join(", ") || "empty"}). Add it explicitly to allow load tests against it.`,
    );
  }

  if (config.target.environment === "production") {
    if (ctx.confirmProductionHost !== target.host) {
      throw new ConfigError(
        `This test targets production (${target.host}). Check that no important meetings are running, then re-run with --confirm-production=${target.host}`,
      );
    }
    if (config.participants.total > ctx.productionHardMax) {
      throw new ConfigError(
        `Production tests are capped at ${ctx.productionHardMax} participants (LOADTEST_PRODUCTION_HARD_MAX); this config has ${config.participants.total}.`,
      );
    }
    warnings.push(
      "Production target: these participants share LiveKit capacity with real meetings for the whole test.",
    );
  }

  const minRamp = minimumRampUpSeconds(config.participants.total, config.target.ipRateLimit);
  if (config.execution.rampUpSeconds < minRamp) {
    warnings.push(
      `rampUpSeconds=${config.execution.rampUpSeconds} is below ${minRamp}s. All participants on this machine share one IP, each join makes ~${REQUESTS_PER_JOIN} API calls, and SheryMeet allows ${config.target.ipRateLimit.perMinute}/min and ${config.target.ipRateLimit.burstPer10s}/10s per IP. Expect HTTP 429 join failures (reported as "rate_limited").`,
    );
  }

  return { warnings };
}

export function safetyContextFromEnv(
  env: NodeJS.ProcessEnv,
  confirmProductionHost?: string,
): SafetyContext {
  const productionHardMax = Number(env.LOADTEST_PRODUCTION_HARD_MAX ?? 50);
  if (!Number.isInteger(productionHardMax) || productionHardMax < 1) {
    throw new ConfigError("LOADTEST_PRODUCTION_HARD_MAX must be a positive integer");
  }
  return {
    allowedHosts: (env.LOADTEST_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
    confirmProductionHost: confirmProductionHost?.trim().toLowerCase(),
    productionHardMax,
  };
}
