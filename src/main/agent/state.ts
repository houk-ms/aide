// Shared mutable state for agent sessions.
// Tracks whether the current execution context is a job (background) session
// and which task IDs were created during this session (to prevent self-completion).

export let isJobSession = false
export const jobCreatedTaskIds = new Set<string>()

export function setJobSession(value: boolean): void {
  isJobSession = value
  if (value) jobCreatedTaskIds.clear()
}
