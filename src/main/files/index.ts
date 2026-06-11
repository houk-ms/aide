import { shell } from 'electron'
import { homedir } from 'node:os'
import { existsSync, statSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Agent-created files ("artifacts") live in the Copilot CLI session-state
// sandbox:
//   ~/.copilot/session-state/{sessionId}/files/{name}
// sessionId follows the convention defined in agent/index.ts:
//   task        -> "task-{taskId}-1"
//   general chat-> "general"
const SESSION_STATE_ROOT = path.join(homedir(), '.copilot', 'session-state')

function sessionIdForTask(taskId: string | null): string {
  return taskId ? `task-${taskId}-1` : 'general'
}

// Resolve an agent-reported file reference to a real, sandboxed absolute path.
// The reference the agent prints may be a full relative path
// ("session-state/{id}/files/x.md"), a truncated one
// ("session-state/.../files/x.md"), or a bare name ("x.md"). We resolve by
// (current session's files dir + basename), which is robust to the truncated
// middle. A path-traversal guard ensures the result never escapes the
// session-state root.
function resolveArtifact(taskId: string | null, ref: string): string | null {
  if (!ref) return null
  const base = path.basename(ref.replace(/\\/g, '/').trim())
  if (!base || base === '.' || base === '..') return null

  const filesDir = path.join(SESSION_STATE_ROOT, sessionIdForTask(taskId), 'files')
  const candidate = path.resolve(filesDir, base)

  // Sandbox: the resolved path must stay within the session-state root.
  const root = path.resolve(SESSION_STATE_ROOT)
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return null

  return existsSync(candidate) && statSync(candidate).isFile() ? candidate : null
}

export type ArtifactResult = { ok: boolean; error?: string }
export type ArtifactTextResult = ArtifactResult & { text?: string; name?: string; size?: number; modifiedAt?: string; baseUrl?: string }

const TEXT_PREVIEW_EXT = /\.(md|markdown|html?)$/i
const MAX_PREVIEW_BYTES = 5 * 1024 * 1024

export async function openArtifact(taskId: string | null, ref: string): Promise<ArtifactResult> {
  const abs = resolveArtifact(taskId, ref)
  if (!abs) return { ok: false, error: 'File not found' }
  const err = await shell.openPath(abs) // returns '' on success
  return err ? { ok: false, error: err } : { ok: true }
}

export function readArtifactText(taskId: string | null, ref: string): ArtifactTextResult {
  const abs = resolveArtifact(taskId, ref)
  if (!abs) return { ok: false, error: 'File not found' }
  const name = path.basename(abs)
  if (!TEXT_PREVIEW_EXT.test(name)) return { ok: false, error: 'Preview supports Markdown and HTML files only' }
  const st = statSync(abs)
  if (st.size > MAX_PREVIEW_BYTES) return { ok: false, error: 'File is too large to preview' }
  return {
    ok: true,
    text: readFileSync(abs, 'utf8'),
    name,
    size: st.size,
    modifiedAt: st.mtime.toISOString(),
    baseUrl: pathToFileURL(path.dirname(abs) + path.sep).toString()
  }
}

export function revealArtifact(taskId: string | null, ref: string): ArtifactResult {
  const abs = resolveArtifact(taskId, ref)
  if (!abs) return { ok: false, error: 'File not found' }
  shell.showItemInFolder(abs)
  return { ok: true }
}

// Whether a referenced artifact currently exists. The renderer uses this to
// decide between an interactive chip and plain text, so we never present a
// dead link.
export function artifactExists(taskId: string | null, ref: string): boolean {
  return resolveArtifact(taskId, ref) !== null
}

// A single file living in a task's artifact folder, surfaced in the task panel
// so the user can browse everything the agent (and their own attachments)
// produced without scrolling back through the conversation.
export type ArtifactFile = { name: string; size: number; modifiedAt: string }

// List every regular file in a task's session-state files folder, newest
// first. Hidden dotfiles are skipped (internal bookkeeping, never user-facing).
// Returns an empty list when the folder doesn't exist yet (no artifacts).
export function listArtifacts(taskId: string | null): ArtifactFile[] {
  const filesDir = path.join(SESSION_STATE_ROOT, sessionIdForTask(taskId), 'files')
  if (!existsSync(filesDir)) return []
  let entries: string[]
  try {
    entries = readdirSync(filesDir)
  } catch {
    return []
  }
  const out: ArtifactFile[] = []
  for (const name of entries) {
    if (name.startsWith('.')) continue
    try {
      const st = statSync(path.join(filesDir, name))
      if (!st.isFile()) continue
      out.push({ name, size: st.size, modifiedAt: st.mtime.toISOString() })
    } catch {
      // Skip entries that vanish or can't be stat'd between readdir and now.
    }
  }
  out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
  return out
}

// Open the task's artifact folder itself in the OS file manager — the single
// entry point to everything a task produced. Creates the folder on demand so
// the action never dead-ends, even before the first artifact is written.
export async function revealArtifactsFolder(taskId: string | null): Promise<ArtifactResult> {
  const filesDir = path.join(SESSION_STATE_ROOT, sessionIdForTask(taskId), 'files')
  try {
    mkdirSync(filesDir, { recursive: true })
    const err = await shell.openPath(filesDir) // returns '' on success
    return err ? { ok: false, error: err } : { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Failed to open folder' }
  }
}

// Reduce an arbitrary user filename to a safe basename: strip directory parts,
// allow only a conservative character set, and never let it start with a dot
// (which would hide it or, when empty, resolve to the dir itself).
function sanitizeFilename(name: string): string {
  const base = path.basename((name || 'attachment').replace(/\\/g, '/').trim())
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '')
  return cleaned || 'attachment'
}

// Persist a user-attached chat file into the session sandbox
//   ~/.copilot/session-state/{sessionId}/files/{name}
// so the agent can open it with its native file tools (instead of receiving an
// unreadable base64 blob inlined in the prompt). Returns the absolute path plus
// a sandbox-relative "files/{name}", or null if the data URL is malformed.
export function saveChatAttachment(
  taskId: string | null,
  name: string,
  dataUrl: string
): { absPath: string; relPath: string } | null {
  const comma = dataUrl.indexOf(',')
  if (comma === -1) return null
  const isBase64 = /;base64/i.test(dataUrl.slice(0, comma))
  const payload = dataUrl.slice(comma + 1)
  let buf: Buffer
  try {
    buf = isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8')
  } catch {
    return null
  }

  const filesDir = path.join(SESSION_STATE_ROOT, sessionIdForTask(taskId), 'files')
  mkdirSync(filesDir, { recursive: true })

  // De-dupe on collision so two "image.png" attachments don't clobber.
  const safe = sanitizeFilename(name)
  const ext = path.extname(safe)
  const stem = path.basename(safe, ext)
  let finalName = safe
  for (let n = 1; existsSync(path.join(filesDir, finalName)); n++) {
    finalName = `${stem}-${n}${ext}`
  }

  const absPath = path.join(filesDir, finalName)
  writeFileSync(absPath, buf)
  return { absPath, relPath: `files/${finalName}` }
}
