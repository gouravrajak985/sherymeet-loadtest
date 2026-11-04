import { parseConfig, type TestConfig, type TestConfigInput } from "../src/config/schema.js";

export function baseInput(): TestConfigInput {
  return {
    name: "unit test",
    target: { meetingUrl: "https://meet.example.com/meet/room-123", environment: "staging" },
    participants: {
      total: 10,
      publishers: 3,
      subscribers: 7,
      cameraPublishers: 2,
      microphonePublishers: 3,
    },
    execution: {
      durationMinutes: 5,
      rampUpSeconds: 60,
      rampDownSeconds: 30,
      maxBrowsersPerWorker: 20,
    },
  };
}

export function config(patch: (input: TestConfigInput) => void = () => undefined): TestConfig {
  const input = baseInput();
  patch(input);
  return parseConfig(input);
}
