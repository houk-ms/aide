# Task

The central entity. Everything in the system revolves around the Task.

## Task sources

| Source | Trigger | Example |
|------|---------|------|
| Connection poll | A Job pulls info on a schedule → Agent identifies a task | An email that needs a reply |
| User conversation | The user tells the agent directly | "Write me a PR review" |
| Meeting notes | A Job pulls meeting records → Agent extracts action items | "You follow up on the API change" |
| Agent self-discovery | The agent finds a related task while working | While fixing a bug, it notices the docs need updating |

## State machine

```
pending
  → in_progress   -- Agent starts handling it, or the user marks it
  → cancelled     -- User cancels, or the Agent decides no action is needed

in_progress
  → completed     -- Handling finished
  → pending       -- Parked for later

completed / cancelled → irreversible
```

## Schema

```typescript
interface Task {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority: 'p0' | 'p1' | 'p2';   // p0 = highest

  // Source tracing
  source: {
    type: 'email' | 'teams' | 'github' | 'calendar' | 'chat';
    connectionId?: string;
    externalId?: string;      // ID in the original system
    externalUrl?: string;     // Link back to the original system
  };

  // Associations
  projectId?: string;

  // Time
  createdAt: Date;
  updatedAt: Date;
  dueDate?: Date;
  completedAt?: Date;

  // UI state
  seenAt?: Date;              // First time the user viewed it (null = •new badge)
  snoozedUntil?: Date;        // Snooze until this time, then reappear in Active

  // Agent processing record
  sessionId?: string;         // Associated Copilot SDK session
  result?: string;            // Summary of the result

  // Progress timeline
  lastActivityAt?: string;    // Newest activity; drives the sidebar activity dot
}
```

> Times are stored as ISO 8601 strings, and nullable fields are `null` (not `undefined`) in the actual `Task` type.

## Activity timeline

Each Task carries an append-only list of `TaskActivity` entries surfaced in the Task chat's activity panel:

```typescript
interface TaskActivity {
  id: string;
  taskId: string;
  timestamp: string;
  type: 'progress' | 'status_change' | 'comment' | 'blocker' | 'note';
  summary: string;
  statusFrom?: TaskStatus | null;
  statusTo?: TaskStatus | null;
  sourceRef?: string | null;   // e.g. a backing email/PR reference
}
```

When `lastActivityAt` is newer than `seenAt`, the task floats to the top of the sidebar with an activity dot.

## Deduplication

The same thing may arrive from multiple channels (an email and a Teams message about the same item):
- Exact dedup by `externalId` (the same email won't create two Tasks)
- Fuzzy dedup by content similarity: before creating a Task, the Agent queries existing Tasks to check for duplicates

## Prioritization

The Agent sorts automatically based on:
- Whether there's an explicit deadline
- Whether it's been chased
- The importance of the associated project

The user can manually override the priority.
