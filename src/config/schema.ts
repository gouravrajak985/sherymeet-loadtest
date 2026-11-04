import { z } from "zod";

export class ConfigError extends Error {
  override name = "ConfigError";
}

const secondsRange = z
  .tuple([z.number().positive(), z.number().positive()])
  .refine(([min, max]) => min <= max, "range must be [min, max] with min <= max");

const DEFAULT_CHAT_MESSAGES = [
  "Hello from a load test participant",
  "Audio and video look fine on my side",
  "Quick question about the last point",
  "Thanks, this is helpful",
];

const participantsSchema = z
  .object({
    total: z.number().int().min(1).max(1000),
    publishers: z.number().int().min(0),
    subscribers: z.number().int().min(0),
    cameraPublishers: z.number().int().min(0),
    microphonePublishers: z.number().int().min(0),
    /** Share of subscribers that chat and raise hands; the rest only listen. */
    interactiveSubscriberRatio: z.number().min(0).max(1).default(0.2),
    namePrefix: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[\w -]+$/, "namePrefix may only contain letters, digits, spaces, _ and -")
      .default("LoadBot"),
  })
  .superRefine((p, ctx) => {
    if (p.publishers + p.subscribers !== p.total) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["subscribers"],
        message: `publishers (${p.publishers}) + subscribers (${p.subscribers}) must equal total (${p.total})`,
      });
    }
    if (Math.max(p.cameraPublishers, p.microphonePublishers) !== p.publishers) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["publishers"],
        message:
          "publishers must equal max(cameraPublishers, microphonePublishers): publisher #i sends camera when i < cameraPublishers and microphone when i < microphonePublishers",
      });
    }
  });

export const testConfigSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    target: z
      .object({
        meetingUrl: z.string().url(),
        environment: z.enum(["local", "staging", "production"]),
        /** SheryMeet's per-IP limits; used to plan a ramp-up that avoids HTTP 429s. */
        ipRateLimit: z
          .object({
            perMinute: z.number().int().positive(),
            burstPer10s: z.number().int().positive(),
          })
          .strict()
          .default({ perMinute: 500, burstPer10s: 125 }),
      })
      .strict(),
    participants: participantsSchema,
    execution: z
      .object({
        /** Steady-state time after ramp-up completes, before ramp-down starts. */
        durationMinutes: z.number().positive().max(240),
        rampUpSeconds: z.number().min(0).max(3600),
        rampDownSeconds: z.number().min(0).max(3600),
        maxBrowsersPerWorker: z.number().int().min(1).max(200),
        joinTimeoutSeconds: z.number().int().min(10).max(600).default(90),
        leaveTimeoutSeconds: z.number().int().min(5).max(120).default(15),
        headless: z.boolean().default(true),
      })
      .strict(),
    media: z
      .object({
        videoFile: z
          .string()
          .regex(/\.(y4m|mjpeg)$/i, "videoFile must be a .y4m or .mjpeg file")
          .optional(),
        audioFile: z.string().regex(/\.wav$/i, "audioFile must be a .wav file").optional(),
        /** Require each participant to receive remote audio or video from someone else. */
        expectRemoteMedia: z.boolean().default(true),
        verifyWindowSeconds: z.number().int().min(2).max(60).default(5),
      })
      .strict()
      .default({}),
    interactions: z
      .object({
        chat: z
          .object({
            enabled: z.boolean().default(true),
            everySeconds: secondsRange.default([60, 180]),
            messages: z
              .array(z.string().trim().min(1).max(200))
              .min(1)
              .default(DEFAULT_CHAT_MESSAGES),
          })
          .strict()
          .default({}),
        raiseHand: z
          .object({
            enabled: z.boolean().default(true),
            probability: z.number().min(0).max(1).default(0.2),
            holdSeconds: secondsRange.default([20, 60]),
          })
          .strict()
          .default({}),
        toggleMicrophone: z
          .object({
            enabled: z.boolean().default(true),
            everySeconds: secondsRange.default([45, 120]),
          })
          .strict()
          .default({}),
        statsEverySeconds: z.number().int().min(5).max(300).default(15),
      })
      .strict()
      .default({}),
    network: z
      .object({
        profile: z
          .enum(["none"], {
            errorMap: () => ({
              message:
                'only network.profile "none" is supported for now; real shaping needs tc/netem on the worker and comes in a later phase',
            }),
          })
          .default("none"),
      })
      .strict()
      .default({}),
  })
  .strict();

export type TestConfig = z.infer<typeof testConfigSchema>;
export type TestConfigInput = z.input<typeof testConfigSchema>;

export function parseConfig(raw: unknown): TestConfig {
  const result = testConfigSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new ConfigError(`Invalid test configuration:\n${lines.join("\n")}`);
  }
  return result.data;
}
