import { create } from 'zustand'
import type { ChatMessage, PendingAction, ToolCallRecord } from '@shared/types'

/** One step in the live (in-progress) turn: streamed narration or a tool call.
 *  Kept in arrival order so the UI can interleave text and tools chronologically,
 *  matching how the turn is later persisted as a foldable process trail. */
export type LiveStep =
  | { kind: 'text'; content: string }
  | { kind: 'tool'; record: ToolCallRecord }

/** Sentinel key for the General chat (taskId === null). Live turn state is
 *  keyed by session id so each conversation streams independently in the
 *  background — switching away and back never interrupts an in-flight turn. */
export const GENERAL_KEY = '__general__'
export const keyOf = (taskId: string | null): string => taskId ?? GENERAL_KEY

interface ChatStore {
  messages: ChatMessage[]
  /** Session key the current `messages` belong to. Lets views reliably tell
   *  when a freshly-switched session's history has actually landed (fetchHistory
   *  is async), instead of guessing from message contents. */
  loadedSessionKey: string | null
  /** In-progress turn timeline, per session. A background session keeps
   *  accumulating here even while another session is being viewed. */
  liveStepsBySession: Record<string, LiveStep[]>
  /** Whether each session has a turn in flight, keyed by session. */
  streamingBySession: Record<string, boolean>
  loading: boolean
  modifyDraft: string | null // For the modify flow (#36)

  fetchHistory: (taskId: string | null, opts?: { clearLive?: boolean }) => Promise<void>
  sendMessage: (message: string, taskId: string | null, attachments?: { name: string; type: string; dataUrl: string }[]) => Promise<void>
  stopStream: (taskId: string | null) => Promise<void>
  appendStreamDelta: (taskId: string | null, delta: string) => void
  endStream: (taskId: string | null) => void
  clearLive: (taskId: string | null) => void
  addMessage: (msg: ChatMessage) => void
  addPendingAction: (action: PendingAction) => void
  updateToolCall: (taskId: string | null, record: ToolCallRecord) => void
  confirmAction: (actionId: string, decision: 'confirm' | 'modify' | 'cancel', modification?: string) => Promise<void>
  setModifyDraft: (text: string | null) => void
}

export const useChatStore = create<ChatStore>((set, get) => ({
  messages: [],
  loadedSessionKey: null,
  liveStepsBySession: {},
  streamingBySession: {},
  loading: false,
  modifyDraft: null,

  fetchHistory: async (taskId, opts) => {
    set({ loading: true })
    const messages = await window.aide.chat.getHistory(taskId)
    const key = keyOf(taskId)
    // Switching into a session must NOT touch its live buffer — an in-flight
    // turn keeps rendering seamlessly. Only when a turn *ends* (opts.clearLive)
    // do we swap the live timeline for the freshly-persisted messages in the
    // SAME commit, so the just-finished turn never flashes out of existence.
    set(state => {
      if (opts?.clearLive) {
        return {
          messages,
          loadedSessionKey: key,
          loading: false,
          liveStepsBySession: { ...state.liveStepsBySession, [key]: [] },
          streamingBySession: { ...state.streamingBySession, [key]: false }
        }
      }
      return { messages, loadedSessionKey: key, loading: false }
    })
  },

  sendMessage: async (message, taskId, attachments) => {
    const key = keyOf(taskId)
    const msgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const userMsg: ChatMessage = {
      id: msgId,
      role: 'user',
      content: message,
      timestamp: new Date().toISOString(),
      taskId
    }
    set(state => ({
      messages: [...state.messages, userMsg],
      streamingBySession: { ...state.streamingBySession, [key]: true },
      liveStepsBySession: { ...state.liveStepsBySession, [key]: [] }
    }))

    try {
      await window.aide.chat.send(message, taskId, attachments)
      // Don't append here — stream-end event triggers fetchHistory which gets the final state from DB
    } catch (err) {
      // On error, add error message
      set(state => ({
        messages: [...state.messages, {
          id: `err-${Date.now()}`,
          role: 'agent' as const,
          content: `⚠️ ${err instanceof Error ? err.message : 'Request failed'}`,
          timestamp: new Date().toISOString(),
          taskId
        }],
        streamingBySession: { ...state.streamingBySession, [key]: false },
        liveStepsBySession: { ...state.liveStepsBySession, [key]: [] }
      }))
    }
  },

  stopStream: async (taskId) => {
    await window.aide.chat.stopStream()
    const key = keyOf(taskId)
    set(state => ({
      streamingBySession: { ...state.streamingBySession, [key]: false },
      liveStepsBySession: { ...state.liveStepsBySession, [key]: [] }
    }))
  },

  appendStreamDelta: (taskId, delta) => {
    const key = keyOf(taskId)
    set(state => {
      const steps = (state.liveStepsBySession[key] ?? []).slice()
      const last = steps[steps.length - 1]
      if (last && last.kind === 'text') {
        steps[steps.length - 1] = { kind: 'text', content: last.content + delta }
      } else {
        steps.push({ kind: 'text', content: delta })
      }
      // Any live activity means this session has a turn in flight, however it was
      // started (manual send, triggerFirstMessage, background job). Mark it so
      // the sidebar "working" dot reflects reality — not just renderer-initiated sends.
      return {
        liveStepsBySession: { ...state.liveStepsBySession, [key]: steps },
        streamingBySession: { ...state.streamingBySession, [key]: true }
      }
    })
  },

  endStream: (taskId) => {
    const key = keyOf(taskId)
    set(state => ({ streamingBySession: { ...state.streamingBySession, [key]: false } }))
  },

  clearLive: (taskId) => {
    const key = keyOf(taskId)
    set(state => ({
      streamingBySession: { ...state.streamingBySession, [key]: false },
      liveStepsBySession: { ...state.liveStepsBySession, [key]: [] }
    }))
  },

  addMessage: (msg) => {
    set(state => ({ messages: [...state.messages, msg] }))
  },

  updateToolCall: (taskId, record) => {
    const key = keyOf(taskId)
    set(state => {
      const steps = (state.liveStepsBySession[key] ?? []).slice()
      const idx = steps.findIndex(s => s.kind === 'tool' && s.record.id === record.id)
      if (idx >= 0) {
        const prev = steps[idx] as { kind: 'tool'; record: ToolCallRecord }
        steps[idx] = { kind: 'tool', record: { ...prev.record, ...record } }
      } else {
        steps.push({ kind: 'tool', record })
      }
      // Tool activity also means the turn is live — keep the session marked working.
      return {
        liveStepsBySession: { ...state.liveStepsBySession, [key]: steps },
        streamingBySession: { ...state.streamingBySession, [key]: true }
      }
    })
  },

  addPendingAction: (action) => {
    // Add as a new action message at the bottom (not attached to old messages)
    const actionMsg: ChatMessage = {
      id: `action-${action.id}`,
      role: 'agent',
      content: '',
      timestamp: new Date().toISOString(),
      taskId: get().messages[get().messages.length - 1]?.taskId || null,
      pendingAction: action
    }
    set(state => ({ messages: [...state.messages, actionMsg] }))
  },

  confirmAction: async (actionId, decision, modification) => {
    if (decision === 'modify') {
      // Set draft for user to edit, then they'll send it as new message
      const pending = get().messages.find(m => m.pendingAction?.id === actionId)
      const desc = pending?.pendingAction?.description || ''
      set({ modifyDraft: modification || desc })
    }
    await window.aide.chat.confirmAction(actionId, decision, modification)
    // Update the action status in local state
    set(state => ({
      messages: state.messages.map(m => {
        if (m.pendingAction?.id === actionId) {
          return { ...m, pendingAction: { ...m.pendingAction, status: decision === 'confirm' ? 'confirmed' as const : 'cancelled' as const } }
        }
        return m
      })
    }))
  },

  setModifyDraft: (text) => set({ modifyDraft: text })
}))
