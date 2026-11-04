import { ConfigError, type TestConfig } from "./schema.js";
import { parseMeetingUrl } from "./safety.js";

export interface MeetingInfo {
  roomId: string;
  type: string;
  joinType: string | null;
  status: string;
}

/** One request to SheryMeet's public details endpoint, before any browser starts. */
export async function fetchMeetingInfo(meetingUrl: string): Promise<MeetingInfo> {
  const { origin, roomId } = parseMeetingUrl(meetingUrl);
  let res: Response;
  try {
    res = await fetch(`${origin}/api/server/${encodeURIComponent(roomId)}/details`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new ConfigError(`Could not reach ${origin}: ${(error as Error).message}`);
  }
  if (res.status === 429) {
    throw new ConfigError(
      "SheryMeet rate-limited the preflight check (HTTP 429). Wait a minute and retry.",
    );
  }
  const body = (await res.json().catch(() => null)) as {
    success?: boolean;
    message?: string;
    data?: { type?: string; joinType?: string | null; status?: string };
  } | null;
  if (!res.ok || !body?.success || !body.data?.type || !body.data.status) {
    throw new ConfigError(
      `Meeting lookup failed (HTTP ${res.status}): ${body?.message ?? "unexpected response"}`,
    );
  }
  return {
    roomId,
    type: body.data.type,
    joinType: body.data.joinType ?? null,
    status: body.data.status,
  };
}

export function checkMeetingCompatible(info: MeetingInfo, config: TestConfig): void {
  if (info.status === "ended") {
    throw new ConfigError("This meeting has already ended.");
  }
  if (info.status !== "active") {
    throw new ConfigError(
      `The meeting is not live yet (status: ${info.status}). Start it as host first: participants that join early wait in the lobby and poll /details every 5s, which uses up the shared per-IP rate limit.`,
    );
  }
  if (info.type === "webinar" && info.joinType === "registered") {
    throw new ConfigError(
      "Registration-required webinars need Google sign-in, which these participants can't do. Use an anonymous meeting or webinar link.",
    );
  }
  if (info.type === "webinar" && config.participants.publishers > 0) {
    throw new ConfigError(
      "Anonymous webinar attendees can't publish audio or video (SheryMeet gives them view-only tokens). Set publishers, cameraPublishers and microphonePublishers to 0; the host presents.",
    );
  }
}
