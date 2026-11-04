# SheryMeet load tester

Real Chromium participants join a real SheryMeet meeting through its normal UI,
publish and receive media over WebRTC, chat and raise hands, then leave. This
is Phase 1: a single worker machine, run from the command line, writing a
JSON/CSV report.

A participant only counts as:

- **connected** once one of its RTCPeerConnections reaches `connected`;
- **publishing** a track once `getStats()` shows that track's outbound bytes increasing;
- **receiving** once inbound audio or video bytes increase.

Button state and UI text are never treated as proof.

## Setup

```bash
npm install
npm run install-browser        # Chromium for Playwright
cp .env.example .env           # then set LOADTEST_ALLOWED_HOSTS
```

## Running a test

1. Create an **anonymous** meeting or webinar in SheryMeet and **start it as host**.
   Registration-required webinars are not supported yet (bots can't do Google sign-in).
2. Copy the **participant join link** (`https://<host>/meet/<roomId>`, not the host start link).
3. Validate first. This checks the config, safety rules, machine capacity, and that the meeting is live, without starting browsers:

```bash
npm run validate -- -c configs/scenario-a-basic.json \
  --meeting-url https://<host>/meet/<roomId> --confirm-production <host>
```

4. Run it (replace `validate` with `run-test`). Press Ctrl+C once to stop
   gracefully (everyone leaves through the UI); press it twice to force-quit.

Reports go to `reports/<run-id>/`:

| File | Contents |
| --- | --- |
| `summary.txt` | Human-readable results |
| `report.json` | Aggregates: success rate, join-time percentiles, publish/receive verification, RTT, jitter, loss, reconnects, API errors, worker load |
| `participants.csv` / `participants.json` | One row per participant, including every lifecycle transition and stats sample |
| `events.ndjson` | Timeline of transitions and status counts |
| `artifacts/` | Screenshot and browser console log for each failed participant |

Metrics this version cannot measure are listed under `unavailableMetrics`
rather than reported as zero.

## Configuration

See `configs/` for examples. Notable rules:

- `publishers + subscribers = total`, and `publishers = max(cameraPublishers, microphonePublishers)`.
  Publisher #i sends camera when `i < cameraPublishers` and microphone when `i < microphonePublishers`.
- `durationMinutes` is the steady-state time after ramp-up; participants leave across `rampDownSeconds`.
- Anonymous webinar attendees can't publish, so webinar configs need `publishers: 0`; the host presents.
- `media.videoFile` (`.y4m`/`.mjpeg`) and `media.audioFile` (`.wav`) replace Chromium's synthetic
  test pattern and beep. The flags apply to the whole browser, so all publishers send the same file.
- `media.expectRemoteMedia: false` skips receive verification (for example, when nobody is publishing).

Profiles: publishers with a camera are `presenter`; microphone-only publishers are `active`
(they chat and raise hands). Of the subscribers, `interactiveSubscriberRatio` become `webinarViewer`
(chat and raise hands); the rest are passive `listener`s.

## Safety rails

- Only hosts listed in `LOADTEST_ALLOWED_HOSTS` can be targeted, and remote targets must use https.
- `environment: "production"` needs `--confirm-production=<host>` and is capped at
  `LOADTEST_PRODUCTION_HARD_MAX` participants (default 50). Bots share LiveKit capacity with
  real meetings while the test runs.
- The test refuses to start unless the meeting is already live, so bots never wait in the lobby polling the API.
- A hard deadline stops the run if it overruns its plan.

## Limits to know about

**Per-IP rate limit.** Every participant on one machine shares an IP. SheryMeet allows 500
requests/minute and 125 per 10 seconds per IP by default (`IP_RATE_LIMIT_PER_MINUTE` /
`IP_RATE_LIMIT_BURST_PER_10S` on the server). Each join makes about 2 API calls, so 50 participants
can join at once and 250 need at least ~60s of ramp-up. If the server uses different limits, set
`target.ipRateLimit` to match. `validate` warns when the ramp is too fast. Joins that hit
the limit fail as `rate_limited`, which is a real finding about SheryMeet, not a tool bug.

**Machine capacity.** Rough cost per participant: ~300 MB RAM and ~0.5 CPU core for a publisher,
~150 MB and ~0.2 cores for a subscriber, plus ~400 MB for Chromium. The tool refuses tests that don't
fit (override: `--skip-resource-guard`). An 8-core laptop with 5 GB free handles roughly 20 listeners.
Larger tests need the multi-worker phase.

**UI coupling.** SheryMeet has no test IDs, so controls are found by their visible text, titles, and
aria labels, all kept in `src/participant/sherymeet-ui.ts`. If SheryMeet's button text changes,
update that file.

## Docker

```bash
docker compose build
docker compose run --rm worker run -c configs/scenario-a-basic.json \
  --meeting-url https://<host>/meet/<roomId> --confirm-production <host>
```

## Running on an AWS cluster

`loadtest-cluster.sh` launches several EC2 machines (default 4 × m6i.8xlarge, 200 browsers each) and runs
the test on all of them at once.

```bash
./loadtest-cluster.sh deploy                          # pick a region, launch, set up (~5 min)
./loadtest-cluster.sh status                          # wait until every node is "ready"
./loadtest-cluster.sh run https://sherymeet.pugly.in/meet/<room>
./loadtest-cluster.sh watch                           # live logs (another terminal)
./loadtest-cluster.sh cleanup                         # terminate nodes, delete security group
```

**Region.** By default (`--region auto`) the script uses the first region in
`ap-south-1 ap-southeast-1 ap-south-2` (Mumbai, Singapore, Hyderabad) that is enabled, offers the instance
type and has enough free On-Demand vCPU quota for `count × vCPUs`. Hyderabad is last on purpose: the SFU
servers under test run there, and load generators would use up the quota the SFU needs to scale out.
Force a region with `--region ap-south-1`, or change the order with `LOADTEST_REGION_PREFERENCE`.

**Network.** The script launches into a public subnet (default route to an internet gateway, public IPs on
launch) that it finds in the chosen region. Pass `--subnet subnet-…` (or `LOADTEST_SUBNET_ID`) to choose one.

The region of the running cluster is saved in `loadtest-region.txt`, so `status`, `run`, `ssh`, `logs` and
`cleanup` use it automatically. The SSH key is per region (`sherymeet-loadtest-key-<region>.pem`) and is
git-ignored. Options can go before or after the command, e.g. `deploy --count 6 --region ap-south-1`.

## Development

```bash
npm run typecheck
npm test            # unit tests + a real-Chromium WebRTC probe test
npm run test:unit   # unit tests only
```

## Roadmap

- **Phase 2:** distributed workers (Redis + BullMQ), controller API, MongoDB history, worker heartbeats,
  scenarios D–E.
- **Phase 3:** dashboard, network shaping with tc/netem, reconnection scenario, Prometheus/Grafana,
  LiveKit server metrics, optional AI behavior and AI report analysis.
