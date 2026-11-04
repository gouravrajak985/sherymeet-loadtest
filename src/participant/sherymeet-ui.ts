import type { Locator, Page } from "playwright";

/**
 * SheryMeet's UI contract, located by visible text, titles and aria labels
 * because the app has no test IDs. When SheryMeet's UI copy changes, update
 * it here and nowhere else.
 */
export const TITLES = {
  prejoinMicOn: "Mute microphone",
  prejoinMicOff: "Unmute microphone",
  prejoinCamOn: "Turn off camera",
  prejoinCamOff: "Turn on camera",
  micOn: "Mute Mic",
  micOff: "Unmute Mic",
  camOn: "Stop Camera",
  camOff: "Start Camera",
  raiseHand: "Raise Hand",
  chatPanel: "Chat Panel",
  settings: "Settings & Layout",
  noPublishPrefix: "Not allowed without host permission",
} as const;

export const byTitle = (page: Page, title: string): Locator =>
  page.locator(`button[title="${title}"]`);

export const ui = {
  nameInput: (page: Page) => page.getByPlaceholder("Enter your name"),
  joinButton: (page: Page) => page.getByRole("button", { name: "Step into the room" }),
  /** Present only once the meeting room UI has mounted. */
  inMeeting: (page: Page) => byTitle(page, TITLES.chatPanel),
  chatInput: (page: Page) => page.getByLabel("Chat message"),
  chatSend: (page: Page) => page.getByRole("button", { name: "Send message" }),
  leaveMenuItem: (page: Page) => page.getByRole("button", { name: /Leave Meeting/ }),
  leaveConfirm: (page: Page) => page.getByRole("button", { name: "Leave", exact: true }),
  noPublish: (page: Page) => page.locator(`button[title^="${TITLES.noPublishPrefix}"]`),
};
