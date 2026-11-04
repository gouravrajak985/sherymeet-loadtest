import { parseArgs } from "node:util";
import { ConfigError, type TestConfig } from "./config/schema.js";
import { loadConfigFile } from "./config/load.js";
import { checkTargetSafety, safetyContextFromEnv } from "./config/safety.js";
import { checkMeetingCompatible, fetchMeetingInfo, type MeetingInfo } from "./config/preflight.js";
import { checkCapacity } from "./runner/capacity.js";
import { buildPlans, totalRunMs } from "./runner/plan.js";
import { runLoadTest } from "./runner/run.js";
import { summaryText } from "./report/report.js";
import { errorMessage, log } from "./log.js";

const HELP = `SheryMeet browser load tester

Usage:
  npm run validate -- --config <file> [options]   Check config, safety, capacity and the meeting; starts no browsers
  npm run run-test -- --config <file> [options]   Run the load test

Options:
  -c, --config <file>              Test configuration JSON (required)
      --meeting-url <url>          Override target.meetingUrl (participant join link)
      --confirm-production <host>  Required when target.environment is "production"
      --skip-resource-guard        Run even if this machine looks too small (results may be unreliable)
      --out <dir>                  Report directory (default: reports)
  -h, --help

Environment:
  LOADTEST_ALLOWED_HOSTS        Comma-separated hosts tests may target (required)
  LOADTEST_PRODUCTION_HARD_MAX  Participant ceiling for production targets (default 50)
  LOG_LEVEL                     debug | info | warn | error (default info)
`;

interface Prepared {
  config: TestConfig;
  meeting: MeetingInfo;
}

async function prepare(values: Record<string, string | boolean | undefined>): Promise<Prepared> {
  const configPath = values.config;
  if (typeof configPath !== "string") throw new ConfigError("--config <file> is required");

  const config = await loadConfigFile(configPath, {
    meetingUrl: typeof values["meeting-url"] === "string" ? values["meeting-url"] : undefined,
  });
  const safety = checkTargetSafety(
    config,
    safetyContextFromEnv(
      process.env,
      typeof values["confirm-production"] === "string" ? values["confirm-production"] : undefined,
    ),
  );
  for (const warning of safety.warnings) log("warn", warning);

  const capacity = checkCapacity(config);
  log("info", "capacity estimate", {
    memNeededMb: capacity.memNeededMb,
    cpuNeeded: capacity.cpuNeeded,
    freeMemMb: capacity.host.freeMemMb,
    cpus: capacity.host.cpus,
  });
  if (capacity.problems.length) {
    const message = `This machine looks too small for this test:\n  - ${capacity.problems.join("\n  - ")}`;
    if (!values["skip-resource-guard"]) {
      throw new ConfigError(`${message}\nReduce participants, or pass --skip-resource-guard to run anyway.`);
    }
    log("warn", message);
  }

  const meeting = await fetchMeetingInfo(config.target.meetingUrl);
  checkMeetingCompatible(meeting, config);

  const plans = buildPlans(config, "plan");
  const profiles: Record<string, number> = {};
  for (const plan of plans) profiles[plan.profile] = (profiles[plan.profile] ?? 0) + 1;
  log("info", "test plan", {
    name: config.name,
    meeting: { ...meeting },
    participants: config.participants.total,
    profiles,
    plannedSeconds: Math.round(totalRunMs(config) / 1000),
  });
  return { config, meeting };
}

async function main(): Promise<number> {
  try {
    process.loadEnvFile();
  } catch {
    // .env is optional
  }
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      "meeting-url": { type: "string" },
      "confirm-production": { type: "string" },
      "skip-resource-guard": { type: "boolean", default: false },
      out: { type: "string", default: "reports" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const command = positionals[0];
  if (values.help || !command || !["validate", "run"].includes(command)) {
    process.stdout.write(HELP);
    return values.help ? 0 : 2;
  }

  const prepared = await prepare(values);
  if (command === "validate") {
    log("info", "validation passed; no browsers were started");
    return 0;
  }

  const { report, reportDir } = await runLoadTest({ ...prepared, outDir: values.out! });
  process.stdout.write("\n" + summaryText(report, reportDir));
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    if (error instanceof ConfigError) {
      process.stderr.write(`\n${error.message}\n`);
      process.exit(2);
    }
    log("error", "load test crashed", { error: errorMessage(error), stack: (error as Error)?.stack });
    process.exit(1);
  });
