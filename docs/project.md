# Project

Context for the user's work projects. A simple entity that gives the Agent background when handling a Task.

## Schema

```typescript
interface Project {
  id: string;
  name: string;
  description: string;       // One-line description of what the project is
  repoPath?: string;         // Local code repository path
  docsPath?: string;         // Docs directory path
  techStack?: string;        // Tech stack summary
  team?: string[];           // Core members
  notes?: string;            // Project notes added by the Agent/user
  createdAt: Date;
  updatedAt: Date;
}
```

## How the Agent uses Project

When the Agent handles a Task that's linked to a Project:
1. Inject `description` + `techStack` + `notes` into the context
2. If it needs to look at code, locate it via `repoPath`
3. If it needs to check docs, search via `docsPath`

## Decisions

- **No automatic indexing.** Store only paths; the Agent reads files on demand when needed. Avoids complex index maintenance.
- **Maintenance:** the user creates a Project and specifies paths manually in Settings. The Agent fills in soft information like `description`, `techStack`, and `notes` during day-to-day conversation.
