import React, { useEffect, useRef, useState } from 'react'
import { TaskPanel } from './components/TaskPanel'
import { ChatPanel } from './components/ChatPanel'
import { DashboardView } from './components/DashboardView'
import { SettingsDrawer } from './components/SettingsDrawer'
import { OnboardingWizard } from './components/OnboardingWizard'
import { UpdateBanner } from './components/UpdateBanner'
import { useTaskStore } from './stores/taskStore'
import { useChatStore } from './stores/chatStore'
import { useSettingsStore } from './stores/settingsStore'
import type { AideEvent } from '@shared/types'

export default function App() {
  const [showOnboarding, setShowOnboarding] = useState<boolean | null>(null)
  const fetchTasks = useTaskStore(s => s.fetchTasks)
  const { appendStreamDelta, endStream, clearLive, fetchHistory, addMessage, addPendingAction, updateToolCall } = useChatStore()
  const selectedTaskIdRef = useRef<string | null>(null)

  // Keep ref in sync
  const selectedTaskId = useTaskStore(s => s.selectedTaskId)
  selectedTaskIdRef.current = selectedTaskId

  useEffect(() => {
    // Check if onboarding is needed
    window.aide?.preferences?.get().then(prefs => {
      setShowOnboarding(!prefs?.onboardingComplete)
    }).catch(() => setShowOnboarding(false))

    fetchTasks()

    // Periodic refresh for snoozed tasks becoming active (every 60s)
    const interval = setInterval(() => fetchTasks(), 60000)

    // Subscribe to all events from main process (one stable subscription)
    const unsubscribe = window.aideEvents.on((event: AideEvent) => {
      switch (event.type) {
        case 'task:created':
        case 'task:updated':
          fetchTasks()
          break
        case 'task:activity':
          fetchTasks()
          break
        case 'chat:message':
          if (event.message.taskId === selectedTaskIdRef.current) {
            addMessage(event.message)
          } else if (event.message.taskId === null && selectedTaskIdRef.current === null) {
            addMessage(event.message)
          }
          break
        case 'chat:stream':
          // Route to the session's own live buffer — a background session keeps
          // streaming so switching back to it resumes seamlessly.
          appendStreamDelta(event.taskId, event.delta)
          break
        case 'chat:stream-end':
          if (event.taskId === selectedTaskIdRef.current) {
            // Active session: atomic swap — stop the spinner, then replace the
            // live timeline with the freshly-persisted messages in one commit.
            endStream(event.taskId)
            fetchHistory(event.taskId, { clearLive: true })
          } else {
            // Background session: clear its live buffer now; the persisted reply
            // loads when the user next opens that session.
            clearLive(event.taskId)
          }
          break
        case 'chat:error':
          // Show agent errors as messages in the chat
          if (event.taskId === selectedTaskIdRef.current) {
            endStream(event.taskId)
            addMessage({
              id: `agent-err-${Date.now()}`,
              role: 'agent',
              content: `⚠️ Agent error: ${event.error}`,
              timestamp: new Date().toISOString(),
              taskId: event.taskId
            })
          }
          break
        case 'chat:pending-action':
          addPendingAction(event.action)
          break
        case 'chat:tool-use':
          // Route to the session's own live buffer (background sessions included).
          updateToolCall(event.taskId, event.record)
          break
        case 'job:completed':
          // Result delivery (desktop chat persistence, WeChat, …) is handled in
          // the main process via configurable delivery targets, which emit their
          // own chat:message events. Here we only refresh task state.
          fetchTasks()
          break
        case 'job:failed':
          // Surface job failure as a warning in General chat
          if (!selectedTaskIdRef.current) {
            addMessage({
              id: `job-err-${Date.now()}`,
              role: 'agent',
              content: `⚠️ Background job failed (${(event as any).jobId}): ${(event as any).error}\n\nPlease check your connection settings.`,
              timestamp: new Date().toISOString(),
              taskId: null
            })
          }
          break
        case 'connection:status':
          useSettingsStore.getState().fetchConnections()
          break
      }
    })

    return () => { unsubscribe(); clearInterval(interval) }
  }, []) // Empty deps — stable subscription using ref

  // Don't render until we know whether to show onboarding
  if (showOnboarding === null) {
    return <div className="flex h-screen w-screen bg-surface-0" />
  }

  if (showOnboarding) {
    return <OnboardingWizard onComplete={() => setShowOnboarding(false)} />
  }

  return (
    <div className="flex flex-col h-screen w-screen select-none overflow-hidden bg-surface-0 text-text-primary">
      <UpdateBanner />
      <div className="flex flex-1 min-h-0">
        <TaskPanel />
        <MainArea />
        <SettingsDrawer />
      </div>
    </div>
  )
}

function MainArea() {
  const selectedTaskId = useTaskStore(s => s.selectedTaskId)
  const viewMode = useTaskStore(s => s.viewMode)

  // Task selected → Task Chat
  if (selectedTaskId) {
    return (
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <ChatPanel />
      </div>
    )
  }

  // No task selected → Dashboard or General Chat
  if (viewMode === 'chat') {
    return (
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <ChatPanel />
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      <DashboardView />
    </div>
  )
}
