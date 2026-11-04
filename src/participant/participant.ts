import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Browser, BrowserContext, Page, Request } from "playwright";
import type { TestConfig } from "../config/schema.js";
import type { MeetingInfo } from "../config/preflight.js";
import type { ParticipantPlan } from "../runner/plan.js";
import { errorMessage } from "../log.js";
import { pick, randomBetween, sleep } from "../util.js";
import { Lifecycle, type ParticipantState, type Transition } from "./lifecycle.js";
import { TITLES, byTitle, ui } from "./sherymeet-ui.js";
import {
  CONNECTED_COUNT_SCRIPT,
  PROBE_SCRIPT,
  STATS_SCRIPT,
  diff,
  summarize,
  type IntervalMetrics,
  type RawStats,
  type Snapshot,
} from "./webrtc-probe.js";
import {
  ParticipantError,
  type ErrorCategory,
  type MediaStatus,
  type ParticipantResult,
} from "./types.js";

export interface ParticipantDeps {
  browser: Browser;
  config: TestConfig;
  plan: ParticipantPlan;
  meeting: MeetingInfo;
  /** Epoch ms when the test started; plan offsets are relative to it. */
  runStartedAt: number;
  /** Aborting asks a connected participant to leave gracefully. */
  signal: AbortSignal;
  artifactsDir: string;
  isBrowserCrashed: () => boolean;
  onTransition: (plan: ParticipantPlan, transition: Transition) => void;
}

const MAX_CONSOLE_LINES = 300;
const MAX_LATENCY_SAMPLES = 500;
const CONNECTION_CHECK_MS = 2_000;
const RECONNECT_GIVE_UP_MS = 60_000;
const UI_GONE_GRACE_MS = 10_000;
const CONTROL_TIMEOUT_MS = 10_000;

type TimingKey = keyof ParticipantResult["timings"];

export class VirtualParticipant {
  readonly lifecycle: Lifecycle;
  private context?: BrowserContext;
  private page?: Page;
  private pageCrashed = false;
  private readonly consoleLines: string[] = [];
  private readonly api: ParticipantResult["api"] = {
    requests: 0,
    errorsByStatus: {},
    latenciesMs: [],
  };
  private readonly samples: IntervalMetrics[] = [];
  private lastSnapshot: Snapshot | null = null;
  private readonly timings: ParticipantResult["timings"] = {
    launchMs: null,
    loadMs: null,
    authMs: null,
    joinMs: null,
  };
  private publish: ParticipantResult["publish"] = { audio: "not_requested", video: "not_requested" };
  private subscribe: ParticipantResult["subscribe"] = {
    audio: "skipped",
    video: "skipped",
    verified: null,
  };
  private readonly connection: ParticipantResult["connection"] = {
    connected: false,
    disconnects: 0,
    reconnectMs: [],
  };
  private readonly interactions: ParticipantResult["interactions"] = {
    chatSent: 0,
    chatBlocked: 0,
    handRaises: 0,
    micToggles: 0,
    errors: 0,
  };
  private failure: ParticipantResult["error"] = null;
  private leaveMethod: ParticipantResult["leaveMethod"] = null;
  private readonly artifacts: ParticipantResult["artifacts"] = {};
  private startedAt: string | null = null;

  constructor(private readonly deps: ParticipantDeps) {
    this.lifecycle = new Lifecycle((t) => deps.onTransition(deps.plan, t));
  }

  get state(): ParticipantState {
    return this.lifecycle.state;
  }

  async run(): Promise<ParticipantResult> {
    this.startedAt = new Date().toISOString();
    try {
      await this.step("launching", "launchMs", () => this.launch());
      await this.step("loading", "loadMs", () => this.load());
      await this.step("authenticating", "authMs", () => this.authenticate());
      await this.join();
      await this.verifyMedia();
      await this.interact();
      await this.leave();
    } catch (error) {
      await this.handleFailure(error);
    } finally {
      await this.context?.close().catch(() => undefined);
    }
    return this.result();
  }

  /** Result for a participant that was never started because the test stopped first. */
  static notStarted(plan: ParticipantPlan): ParticipantResult {
    const vp = new VirtualParticipant({ plan, onTransition: () => undefined } as unknown as ParticipantDeps);
    vp.lifecycle.to("failed", "aborted: test stopped before this participant was scheduled");
    vp.failure = { category: "aborted", message: "Test stopped before this participant started" };
    return vp.result();
  }

  private async step(state: ParticipantState, key: TimingKey, fn: () => Promise<void>) {
    this.checkAborted();
    this.lifecycle.to(state);
    const started = Date.now();
    await fn();
    this.timings[key] = Date.now() - started;
  }

  private checkAborted() {
    if (this.deps.signal.aborted) {
      throw new ParticipantError("aborted", "Test stopped before this participant connected");
    }
  }

  private get joinTimeoutMs() {
    return this.deps.config.execution.joinTimeoutSeconds * 1000;
  }

  private mustPage(): Page {
    if (!this.page) throw new ParticipantError("unknown", "Page is not open");
    return this.page;
  }

  // ---- lifecycle steps -------------------------------------------------

  private async launch() {
    this.context = await this.deps.browser.newContext({
      viewport: { width: 1280, height: 720 },
      permissions: ["camera", "microphone"],
    });
    await this.context.addInitScript({ content: PROBE_SCRIPT });
    const page = await this.context.newPage();
    this.page = page;
    page.on("console", (m) => this.note(`[${m.type()}] ${m.text()}`));
    page.on("pageerror", (e) => this.note(`[pageerror] ${e.message}`));
    page.on("crash", () => {
      this.pageCrashed = true;
    });
    page.on("requestfinished", (req) => void this.recordApi(req, false));
    page.on("requestfailed", (req) => void this.recordApi(req, true));
  }

  private async load() {
    const page = this.mustPage();
    await page.goto(this.deps.config.target.meetingUrl, {
      waitUntil: "domcontentloaded",
      timeout: this.joinTimeoutMs,
    });
    try {
      await ui.nameInput(page).waitFor({ state: "visible", timeout: this.joinTimeoutMs });
    } catch {
      throw await this.explainStuck("load_failed", "The name entry screen never appeared");
    }
  }

  private async authenticate() {
    const page = this.mustPage();
    await ui.nameInput(page).fill(this.deps.plan.name);
    await this.setPrejoinToggle(this.deps.plan.microphone, TITLES.prejoinMicOn, TITLES.prejoinMicOff);
    await this.setPrejoinToggle(this.deps.plan.camera, TITLES.prejoinCamOn, TITLES.prejoinCamOff);
  }

  private async join() {
    this.checkAborted();
    this.lifecycle.to("joining");
    const page = this.mustPage();
    const started = Date.now();
    const deadline = started + this.joinTimeoutMs;
    await ui.joinButton(page).click({ timeout: CONTROL_TIMEOUT_MS });
    try {
      await ui.inMeeting(page).waitFor({
        state: "visible",
        timeout: Math.max(1_000, deadline - Date.now()),
      });
    } catch {
      throw await this.explainStuck("join_timeout", "The meeting room never appeared after joining");
    }
    let connected = await this.connectedPeerCount();
    while (connected <= 0) {
      if (Date.now() > deadline) {
        throw new ParticipantError(
          "webrtc_not_connected",
          connected < 0
            ? "WebRTC probe missing: SheryMeet created no RTCPeerConnection"
            : `No peer connection reached "connected" within ${this.deps.config.execution.joinTimeoutSeconds}s`,
        );
      }
      await sleep(500, this.deps.signal);
      this.checkAborted();
      connected = await this.connectedPeerCount();
    }
    this.timings.joinMs = Date.now() - started;
    this.connection.connected = true;
    this.lifecycle.to("connected", `joinMs=${this.timings.joinMs}`);
    this.lastSnapshot = await this.snapshot();
  }

  /** Confirms media with getStats() byte counters rather than trusting button state. */
  private async verifyMedia() {
    const { plan, config } = this.deps;
    this.publish = {
      audio: await this.ensureMeetingMedia("microphone", plan.microphone),
      video: await this.ensureMeetingMedia("camera", plan.camera),
    };
    const expectRemote = config.media.expectRemoteMedia;
    const isPending = () => this.publish.audio === "pending" || this.publish.video === "pending";
    if (!isPending() && !expectRemote) return;

    const windowMs = config.media.verifyWindowSeconds * 1000;
    const publishDeadline = Date.now() + windowMs * 3;
    const subscribeDeadline = Date.now() + this.joinTimeoutMs;
    let gotAudio = false;
    let gotVideo = false;
    let prev = await this.snapshot();

    while (!this.deps.signal.aborted) {
      await sleep(windowMs, this.deps.signal);
      this.assertAlive();
      const next = await this.snapshot();
      const d = diff(prev, next);
      this.samples.push(d);
      prev = next;
      if (this.publish.audio === "pending" && d.out.audioBytes > 0) this.publish.audio = "verified";
      if (this.publish.video === "pending" && d.out.videoBytes > 0) this.publish.video = "verified";
      gotAudio ||= d.in.audioBytes > 0;
      gotVideo ||= d.in.videoBytes > 0;

      const now = Date.now();
      const publishDone = !isPending() || now >= publishDeadline;
      const subscribeDone =
        !expectRemote ||
        (gotAudio && gotVideo) ||
        ((gotAudio || gotVideo) && now >= publishDeadline) ||
        now >= subscribeDeadline;
      if (publishDone && subscribeDone) break;
    }
    this.lastSnapshot = prev;

    if (this.publish.audio === "pending") this.publish.audio = "failed";
    if (this.publish.video === "pending") this.publish.video = "failed";
    if (expectRemote) {
      this.subscribe = {
        audio: gotAudio ? "verified" : "not_observed",
        video: gotVideo ? "verified" : "not_observed",
        verified: gotAudio || gotVideo,
      };
    }
  }

  private async interact() {
    this.lifecycle.to("interacting");
    const page = this.mustPage();
    const { plan, config, signal } = this.deps;
    const { chat, raiseHand, toggleMicrophone, statsEverySeconds } = config.interactions;
    const leaveAt = this.deps.runStartedAt + plan.leaveAtMs;
    const social = plan.profile === "active" || plan.profile === "webinarViewer";
    const start = Date.now();

    let nextChat = social && chat.enabled ? start + randomBetween(chat.everySeconds) * 1000 : Infinity;
    let nextToggle =
      plan.microphone && this.publish.audio === "verified" && toggleMicrophone.enabled
        ? start + randomBetween(toggleMicrophone.everySeconds) * 1000
        : Infinity;
    let raiseAt =
      social && raiseHand.enabled && Math.random() < raiseHand.probability
        ? start + Math.random() * Math.max(0, leaveAt - start) * 0.5
        : Infinity;
    let lowerAt = Infinity;
    let nextStats = start + statsEverySeconds * 1000;
    let reconnectingSince: number | null = null;
    let uiGoneSince: number | null = null;

    while (!signal.aborted && Date.now() < leaveAt) {
      await sleep(Math.min(CONNECTION_CHECK_MS, Math.max(0, leaveAt - Date.now())), signal);
      if (signal.aborted) break;
      this.assertAlive();
      const now = Date.now();

      const connected = await this.connectedPeerCount();
      if (connected <= 0 && reconnectingSince === null) {
        reconnectingSince = now;
        this.connection.disconnects++;
        this.lifecycle.to("reconnecting");
      } else if (connected > 0 && reconnectingSince !== null) {
        this.connection.reconnectMs.push(now - reconnectingSince);
        reconnectingSince = null;
        this.lifecycle.to("interacting", "reconnected");
      }
      if (reconnectingSince !== null) {
        if (now - reconnectingSince > RECONNECT_GIVE_UP_MS) {
          throw new ParticipantError(
            "reconnect_timeout",
            `Lost WebRTC connection and did not recover within ${RECONNECT_GIVE_UP_MS / 1000}s`,
          );
        }
        continue;
      }

      if (await ui.inMeeting(page).isVisible()) {
        uiGoneSince = null;
      } else {
        uiGoneSince ??= now;
        if (now - uiGoneSince > UI_GONE_GRACE_MS) {
          throw new ParticipantError(
            "removed_or_ended",
            "The meeting UI disappeared (removed by the host, meeting ended, or page navigated away)",
          );
        }
        continue;
      }

      if (now >= nextStats) {
        await this.sample();
        nextStats = now + statsEverySeconds * 1000;
      }
      if (now >= nextChat) {
        await this.sendChat();
        nextChat = now + randomBetween(chat.everySeconds) * 1000;
      }
      if (now >= nextToggle) {
        await this.toggleMicrophone();
        nextToggle = now + randomBetween(toggleMicrophone.everySeconds) * 1000;
      }
      if (now >= raiseAt) {
        if (await this.clickRaiseHand()) this.interactions.handRaises++;
        raiseAt = Infinity;
        lowerAt = now + randomBetween(raiseHand.holdSeconds) * 1000;
      }
      if (now >= lowerAt) {
        await this.clickRaiseHand();
        lowerAt = Infinity;
      }
    }
  }

  private async leave() {
    this.lifecycle.to("leaving");
    await this.sample().catch(() => undefined);
    const page = this.page;
    if (!page || this.pageCrashed) {
      this.leaveMethod = "forced";
    } else {
      const timeout = this.deps.config.execution.leaveTimeoutSeconds * 1000;
      try {
        await byTitle(page, TITLES.settings).click({ timeout });
        await ui.leaveMenuItem(page).click({ timeout });
        await ui.leaveConfirm(page).click({ timeout });
        await ui.inMeeting(page).waitFor({ state: "hidden", timeout });
        this.leaveMethod = "ui";
      } catch (error) {
        this.leaveMethod = "forced";
        this.note(`[loadtest] UI leave failed, closing the browser context: ${errorMessage(error)}`);
      }
    }
    this.lifecycle.to("completed", `leave=${this.leaveMethod}`);
  }

  // ---- media & interactions -------------------------------------------

  private async setPrejoinToggle(want: boolean, titleWhenOn: string, titleWhenOff: string) {
    const button = byTitle(this.mustPage(), want ? titleWhenOff : titleWhenOn);
    try {
      if (await button.count()) await button.first().click({ timeout: CONTROL_TIMEOUT_MS });
    } catch (error) {
      this.note(`[loadtest] pre-join toggle "${want ? titleWhenOff : titleWhenOn}" failed: ${errorMessage(error)}`);
    }
  }

  private async ensureMeetingMedia(
    kind: "microphone" | "camera",
    want: boolean,
  ): Promise<MediaStatus> {
    const page = this.mustPage();
    const titles =
      kind === "microphone"
        ? { on: TITLES.micOn, off: TITLES.micOff }
        : { on: TITLES.camOn, off: TITLES.camOff };
    const onButton = byTitle(page, titles.on);
    const offButton = byTitle(page, titles.off);
    await onButton
      .or(offButton)
      .or(ui.noPublish(page))
      .first()
      .waitFor({ state: "visible", timeout: CONTROL_TIMEOUT_MS })
      .catch(() => undefined);

    if (!want) {
      if (await onButton.count()) {
        await onButton.first().click({ timeout: CONTROL_TIMEOUT_MS }).catch((error) => {
          this.note(`[loadtest] could not turn off ${kind}: ${errorMessage(error)}`);
        });
      }
      return "not_requested";
    }
    if (await onButton.count()) return "pending";
    if (await offButton.count()) {
      await offButton.first().click({ timeout: CONTROL_TIMEOUT_MS });
      await onButton.first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);
      return (await onButton.count()) ? "pending" : "failed";
    }
    if (await ui.noPublish(page).count()) return "not_permitted";
    throw new ParticipantError("ui_not_found", `Could not find the ${kind} control in the meeting toolbar`);
  }

  private async sendChat() {
    await this.interaction("chat", async (page) => {
      const input = ui.chatInput(page);
      if (!(await input.isVisible())) {
        await byTitle(page, TITLES.chatPanel).click({ timeout: CONTROL_TIMEOUT_MS });
        await input.waitFor({ state: "visible", timeout: CONTROL_TIMEOUT_MS });
      }
      if (!(await input.isEnabled())) {
        this.interactions.chatBlocked++;
        return;
      }
      await input.fill(pick(this.deps.config.interactions.chat.messages));
      const send = ui.chatSend(page);
      if (!(await send.isVisible()) || !(await send.isEnabled())) {
        this.interactions.chatBlocked++;
        await input.fill("");
        return;
      }
      await send.click({ timeout: CONTROL_TIMEOUT_MS });
      this.interactions.chatSent++;
    });
  }

  private async toggleMicrophone() {
    await this.interaction("toggle microphone", async (page) => {
      const on = byTitle(page, TITLES.micOn);
      const button = (await on.count()) ? on : byTitle(page, TITLES.micOff);
      await button.first().click({ timeout: CONTROL_TIMEOUT_MS });
      this.interactions.micToggles++;
    });
  }

  private clickRaiseHand(): Promise<boolean> {
    return this.interaction("raise hand", (page) =>
      byTitle(page, TITLES.raiseHand).first().click({ timeout: CONTROL_TIMEOUT_MS }),
    );
  }

  /** Interaction failures are recorded but never end the session. */
  private async interaction(name: string, fn: (page: Page) => Promise<void>): Promise<boolean> {
    try {
      await fn(this.mustPage());
      return true;
    } catch (error) {
      this.interactions.errors++;
      this.note(`[loadtest] ${name} failed: ${errorMessage(error)}`);
      return false;
    }
  }

  // ---- measurement -----------------------------------------------------

  private async connectedPeerCount(): Promise<number> {
    return (await this.mustPage().evaluate(CONNECTED_COUNT_SCRIPT)) as number;
  }

  private async snapshot(): Promise<Snapshot> {
    const raw = (await this.mustPage().evaluate(STATS_SCRIPT)) as RawStats;
    return summarize(raw);
  }

  private async sample() {
    const next = await this.snapshot();
    if (this.lastSnapshot) this.samples.push(diff(this.lastSnapshot, next));
    this.lastSnapshot = next;
  }

  private async recordApi(request: Request, failed: boolean) {
    let pathname: string;
    try {
      pathname = new URL(request.url()).pathname;
    } catch {
      return;
    }
    if (!pathname.startsWith("/api/")) return;
    this.api.requests++;
    if (failed) {
      this.api.errorsByStatus.network = (this.api.errorsByStatus.network ?? 0) + 1;
      return;
    }
    const latency = request.timing().responseEnd;
    if (latency > 0 && this.api.latenciesMs.length < MAX_LATENCY_SAMPLES) {
      this.api.latenciesMs.push(Math.round(latency));
    }
    const status = (await request.response().catch(() => null))?.status();
    if (status && status >= 400) {
      this.api.errorsByStatus[status] = (this.api.errorsByStatus[status] ?? 0) + 1;
    }
  }

  // ---- failures --------------------------------------------------------

  private assertAlive() {
    if (this.deps.isBrowserCrashed()) {
      throw new ParticipantError("browser_crashed", "Chromium crashed during the session");
    }
    if (this.pageCrashed) {
      throw new ParticipantError("page_crashed", "The page's renderer process crashed");
    }
  }

  private async explainStuck(category: ErrorCategory, message: string): Promise<ParticipantError> {
    if (this.api.errorsByStatus["429"]) {
      return new ParticipantError(
        "rate_limited",
        `${message}: SheryMeet answered HTTP 429 ${this.api.errorsByStatus["429"]} time(s) (per-IP rate limit)`,
      );
    }
    const heading = await this.page
      ?.locator("h1, h2, h3")
      .first()
      .innerText({ timeout: 1_000 })
      .catch(() => "");
    return new ParticipantError(category, heading ? `${message} (page shows: "${heading.trim()}")` : message);
  }

  private async handleFailure(error: unknown) {
    let category: ErrorCategory;
    let message = errorMessage(error);
    if (error instanceof ParticipantError) {
      category = error.category;
    } else if (this.deps.isBrowserCrashed()) {
      category = "browser_crashed";
    } else if (this.pageCrashed) {
      category = "page_crashed";
    } else if (error instanceof Error && error.name === "TimeoutError") {
      category = "ui_not_found";
    } else {
      category = "unknown";
    }
    message = message.split("\n")[0] ?? message;
    this.failure = { category, message };
    if (!this.lifecycle.isTerminal) this.lifecycle.to("failed", `${category}: ${message}`);
    if (category !== "aborted") await this.captureArtifacts();
  }

  private async captureArtifacts() {
    const dir = this.deps.artifactsDir;
    const id = this.deps.plan.id;
    await mkdir(dir, { recursive: true });
    if (this.page && !this.pageCrashed && !this.deps.isBrowserCrashed()) {
      const file = path.join(dir, `${id}.png`);
      await this.page
        .screenshot({ path: file, timeout: 5_000 })
        .then(() => {
          this.artifacts.screenshot = path.relative(path.dirname(dir), file);
        })
        .catch(() => undefined);
    }
    if (this.consoleLines.length) {
      const file = path.join(dir, `${id}.log`);
      await writeFile(file, this.consoleLines.join("\n") + "\n");
      this.artifacts.consoleLog = path.relative(path.dirname(dir), file);
    }
  }

  private note(line: string) {
    if (this.consoleLines.length < MAX_CONSOLE_LINES) {
      this.consoleLines.push(`${new Date().toISOString()} ${line}`);
    }
  }

  private result(): ParticipantResult {
    const { plan } = this.deps;
    return {
      id: plan.id,
      index: plan.index,
      name: plan.name,
      profile: plan.profile,
      plan: { camera: plan.camera, microphone: plan.microphone },
      outcome:
        this.failure?.category === "aborted" ? "aborted" : this.failure ? "failed" : "completed",
      finalState: this.lifecycle.state,
      error: this.failure,
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
      timings: this.timings,
      connection: this.connection,
      publish: this.publish,
      subscribe: this.subscribe,
      interactions: this.interactions,
      api: this.api,
      leaveMethod: this.leaveMethod,
      samples: this.samples,
      transitions: this.lifecycle.transitions,
      artifacts: this.artifacts,
    };
  }
}
