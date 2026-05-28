import React, { useEffect, useRef, useState } from 'react'
import { TaskPanel } from './components/TaskPanel'
import { ChatPanel } from './components/ChatPanel'
import { DashboardView } from './components/DashboardView'
import { SettingsDrawer } from './components/SettingsDrawer'
import { OnboardingWizard } from './components/OnboardingWizard'
import { useTaskStore } from './stores/taskStore'
import { useChatStore } from './stores/chatStore'
import { useSettingsStore } from './stores/settingsStore'
import type { AideEvent } from '@shared/types'

export default function App() {
  const [showOnboarding, setShowOnboarding] = useState<boolean | null>(null)
  const fetchTasks = useTaskStore(s => s.fetchTasks)
  const { appendStreamDelta, endStream, fetchHistory, addMessage, addPendingAction, updateToolCall } = useChatStore()
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
        case 'chat:message':
          if (event.message.taskId === selectedTaskIdRef.current) {
            addMessage(event.message)
          } else if (event.message.taskId === null && selectedTaskIdRef.current === null) {
            addMessage(event.message)
          }
          break
        case 'chat:stream':
          // Only show stream for the currently active context
          if (event.taskId === selectedTaskIdRef.current) {
            appendStreamDelta(event.delta)
          }
          break
        case 'chat:stream-end':
          // Only process stream-end for the currently active context
          if (event.taskId === selectedTaskIdRef.current) {
            endStream()
            fetchHistory(selectedTaskIdRef.current)
          }
          break
        case 'chat:pending-action':
          addPendingAction(event.action)
          break
        case 'chat:tool-use':
          updateToolCall(event.record)
          break
        case 'job:completed':
          fetchTasks()
          // If user is on General chat, inject job summary as a message
          if (!selectedTaskIdRef.current && event.summary) {
            addMessage({
              id: `job-${Date.now()}`,
              role: 'agent',
              content: `[自动任务完成] ${event.summary}`,
              timestamp: new Date().toISOString(),
              taskId: null
            })
          }
          break
        case 'job:failed':
          // Surface job failure as a warning in General chat
          if (!selectedTaskIdRef.current) {
            addMessage({
              id: `job-err-${Date.now()}`,
              role: 'agent',
              content: `⚠️ 后台任务执行失败（${(event as any).jobId}）：${(event as any).error}\n\n请检查连接设置是否正常。`,
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
    <div className="flex h-screen w-screen select-none overflow-hidden bg-surface-0 text-text-primary">
      <TaskPanel />
      <MainArea />
      <SettingsDrawer />
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
