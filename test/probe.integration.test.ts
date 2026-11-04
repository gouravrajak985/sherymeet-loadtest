import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { config } from "./fixtures.js";
import { chromiumLaunchOptions } from "../src/runner/browser-host.js";
import {
  CONNECTED_COUNT_SCRIPT,
  PROBE_SCRIPT,
  STATS_SCRIPT,
  diff,
  summarize,
  type RawStats,
} from "../src/participant/webrtc-probe.js";

// A page that publishes fake camera+mic over a local loopback peer connection,
// the way a real app would, without the page knowing about the probe.
const LOOPBACK_PAGE = `<!doctype html><html><body><script>
(async () => {
  const media = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
  b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
  b.ontrack = () => {};
  media.getTracks().forEach((t) => a.addTrack(t, media));
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription);
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription);
  window.started = true;
})().catch((e) => { window.startError = String(e); });
</script></body></html>`;

let server: Server;
let browser: Browser;
let url: string;

beforeAll(async () => {
  server = createServer((_, res) => res.writeHead(200, { "content-type": "text/html" }).end(LOOPBACK_PAGE));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://localhost:${(server.address() as AddressInfo).port}/`;
  browser = await chromium.launch(chromiumLaunchOptions(config()));
});

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

describe("WebRTC probe in real Chromium", () => {
  it("sees the app's peer connections and measures real media bytes", async () => {
    const context = await browser.newContext({ permissions: ["camera", "microphone"] });
    await context.addInitScript({ content: PROBE_SCRIPT });
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction("window.started || window.startError", undefined, { timeout: 15_000 });
    expect(await page.evaluate("window.startError || null")).toBeNull();

    await expect
      .poll(async () => page.evaluate(CONNECTED_COUNT_SCRIPT), { timeout: 15_000 })
      .toBe(2);

    const first = summarize((await page.evaluate(STATS_SCRIPT)) as RawStats);
    await page.waitForTimeout(3_000);
    const second = summarize((await page.evaluate(STATS_SCRIPT)) as RawStats);
    const d = diff(first, second);

    expect(d.out.audioBytes).toBeGreaterThan(0);
    expect(d.out.videoBytes).toBeGreaterThan(0);
    expect(d.in.audioBytes).toBeGreaterThan(0);
    expect(d.in.videoBytes).toBeGreaterThan(0);
    expect(second.out.videoWidth).toBeGreaterThan(0);
    expect(second.rttMs).not.toBeNull();
    await context.close();
  });

  it("reports nothing connected on a page without WebRTC", async () => {
    const context = await browser.newContext();
    await context.addInitScript({ content: PROBE_SCRIPT });
    const page = await context.newPage();
    await page.setContent("<p>no webrtc</p>");
    expect(await page.evaluate(CONNECTED_COUNT_SCRIPT)).toBe(0);
    await context.close();
  });
});
