# Job

The scheduling subsystem. It drives the execution of timed tasks.

## Responsibility

Jobs are what make the system run proactively. Without Jobs, the system can only passively wait for the user to open a conversation.

## Built-in Jobs

Four jobs are seeded on first run (definitions are re-synced from code on every startup):

| Job (id) | Cron | What it does |
|----------|------|--------------|
| Daily morning briefing (`morning-briefing`) | `0 9 * * 1-5` | Pulls new email/Teams/GitHub since the last run plus today's calendar; creates Tasks for items needing action and gives a prioritized summary. Has a dedicated startup catch-up. |
| Periodic poll (`periodic-poll`) | `*/30 * * * *` | Every 30 minutes, checks for new information and creates/updates Tasks when found. |
| End-of-day review (`daily-reconcile`) | `0 18 * * 1-5` | Reviews the day's task statuses, marks confirmed-done tasks complete, suggests cleaning up stale P2 tasks, and generates a daily summary. |
| Projects sync (`world-sync`) | `0 10 * * 1` | Weekly (Monday) bootstrap/refresh of Projects. Also triggered once at the end of onboarding. |

## Execution model

Once a Job triggers, it needs an Agent (LLM) to analyze data and make decisions. The flow:

```
Job triggers (cron)
  → Create a temporary Agent session (no user interaction, pure background)
  → System prompt: "You are the Aide background scheduling Agent; your task is {job.instruction}"
  → Inject L0 Identity + relevant context
  → Agent calls tools (ask_work_iq / fetch_work_iq / GitHub tools)
  → Agent analyzes the results and decides to create/update Tasks and write to Memory
  → Session ends, resources released
```

**Key design: the Job session is non-interactive.** The Agent never asks the user questions; all write operations execute automatically (the Job's permission level is fixed at "notify" — after execution it shows a summary on the Dashboard).

### Cost control

Each Job execution = 1 LLM call. Control strategies:
- Periodic polling does rule-based pre-filtering first: an Agent session only starts when there's actually new data
- Morning aggregation and end-of-day reconciliation run once each per day, an acceptable cost
- Job sessions don't inject L1 retrieval results (saving tokens), only L0 + the job instruction

## Schema

```typescript
interface Job {
  id: string;
  name: string;
  cron: string;              // cron expression
  instruction: string;       // instruction for the Agent ("Check for new email, identify items I need to handle")
  enabled: boolean;
  deliveryTargets: DeliveryTarget[]; // where to send this job's summary when it finishes
  lastRunAt: Date | null;
  lastResult: 'success' | 'failed' | null;
  lastSummary: string | null; // summary of the last execution
}

type DeliveryTarget = 'desktop' | 'wechat'; // 'desktop' = Aide chat; 'wechat' = WeChat channel
```

## Result delivery (Channels)

When a Job finishes successfully, its summary is pushed to each Channel listed in `deliveryTargets`:

- `desktop` — posts the summary into the built-in Aide General chat (persisted, so it's there even if the user wasn't watching)
- `wechat` — sends the summary to the connected WeChat bot

Delivery is best-effort and per-target isolated: one channel failing (e.g. WeChat offline) never blocks the others and never fails the Job. An empty `deliveryTargets` means "don't push anywhere" (the result is still recorded as `lastSummary`). Of the built-in jobs, only the morning briefing ships with `['desktop','wechat']`; the rest default to `[]`. The delivery dispatcher lives in `src/main/jobs/delivery.ts` and is intentionally a small registry so new channels can be added without touching job logic.

## Implementation

For a local single-user app, a simple timer + cron parser is enough:
- A JobScheduler module in the main process loads all enabled jobs on startup
- On trigger: rule-based pre-filter → new data found → create Agent session → analyze → write Task/Memory
- Serial execution (no concurrency)
- Failures are logged and retried next time

## Decisions

- **When the app closes, Jobs stop and are not re-run.** The next time it opens, the morning aggregation naturally pulls in all unprocessed information, so there's no risk of anything being missed.
