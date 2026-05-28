import { create } from 'zustand'
import type { ChatMessage, PendingAction } from '@shared/types'

interface ChatStore {
  messages: ChatMessage[]
  streamingContent: string
  isStreaming: boolean
  loading: boolean
  modifyDraft: string | null // For the modify flow (#36)

  fetchHistory: (taskId: string | null) => Promise<void>
  sendMessage: (message: string, taskId: string | null, attachments?: { name: string; type: string; dataUrl: string }[]) => Promise<void>
  stopStream: () => Promise<void>
  appendStreamDelta: (delta: string) => void
  endStream: () => void
  addMessage: (msg: ChatMessage) => void
  addPendingAction: (action: PendingAction) => void
  confirmAction: (actionId: string, decision: 'confirm' | 'modify' | 'cancel', modification?: string) => Promise<void>
  setModifyDraft: (text: string | null) => void
}

export const useChatStore = create<ChatStore>((set, get) => ({
  messages: [],
  streamingContent: '',
  isStreaming: false,
  loading: false,
  modifyDraft: null,

  fetchHistory: async (taskId) => {
    set({ loading: true })
    const messages = await window.aide.chat.getHistory(taskId)
    set({ messages, loading: false })
  },

  sendMessage: async (message, taskId, attachments) => {
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
      isStreaming: true,
      streamingContent: ''
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
          content: `⚠️ ${err instanceof Error ? err.message : '请求失败'}`,
          timestamp: new Date().toISOString(),
          taskId
        }],
        isStreaming: false,
        streamingContent: ''
      }))
    }
  },

  stopStream: async () => {
    await window.aide.chat.stopStream()
    set({ isStreaming: false, streamingContent: '' })
  },

  appendStreamDelta: (delta) => {
    set(state => ({ streamingContent: state.streamingContent + delta }))
  },

  endStream: () => {
    set({ isStreaming: false })
  },

  addMessage: (msg) => {
    set(state => ({ messages: [...state.messages, msg] }))
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
