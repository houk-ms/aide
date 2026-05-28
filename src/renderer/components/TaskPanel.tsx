import React, { useState, useRef, useEffect } from 'react'
import { Settings, Check, Clock, X, ChevronDown, ChevronUp, Zap } from 'lucide-react'
import { useTaskStore } from '../stores/taskStore'
import { useSettingsStore } from '../stores/settingsStore'
import type { Task } from '@shared/types'

export function TaskPanel() {
  const { tasks, selectedTaskId, selectTask, goHome } = useTaskStore()
  const setViewMode = useTaskStore(s => s.setViewMode)
  const openSettings = useSettingsStore(s => s.open)
  const [expanded, setExpanded] = useState(false)

  const newTasks = tasks.filter(t =>
    (t.status === 'pending' || t.status === 'in_progress') && t.seenAt === null
  )
  const activeTasks = tasks.filter(t =>
    (t.status === 'pending' || t.status === 'in_progress') && t.seenAt !== null
  )

  const VISIBLE_CAP = 10
  const visibleActive = expanded ? activeTasks : activeTasks.slice(0, VISIBLE_CAP)
  const overflowCount = activeTasks.length - VISIBLE_CAP

  return (
    <aside className="w-[260px] min-w-[260px] shrink-0 border-r border-edge flex flex-col bg-surface-1">
      {/* Title bar — drag region */}
      <header className="flex items-center justify-between px-4 h-[52px] shrink-0 drag-region">
        <button
          onClick={goHome}
          className="flex items-center gap-2.5 no-drag group"
          title="回到主页"
        >
          <div className="w-[22px] h-[22px] rounded-[6px] overflow-hidden shadow-sm group-hover:shadow-md transition-shadow">
            <svg viewBox="0 0 512 512" className="w-full h-full">
              <defs><linearGradient id="aide-hdr" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse"><stop offset="0%" stopColor="#4A7FF7"/><stop offset="100%" stopColor="#3B5EE6"/></linearGradient></defs>
              <rect width="512" height="512" rx="108" fill="url(#aide-hdr)"/>
              <path d="M256 96 L384 416 L328 416 L298 332 L214 332 L184 416 L128 416 Z M256 192 L228 296 L284 296 Z" fill="white"/>
              <path d="M372 100 L386 132 L418 146 L386 160 L372 192 L358 160 L326 146 L358 132 Z" fill="white" opacity="0.92"/>
            </svg>
          </div>
          <span className="text-[13px] font-semibold text-text-primary tracking-[-0.01em] group-hover:text-accent transition-colors">Aide</span>
        </button>
        <button
          onClick={() => openSettings()}
          className="w-7 h-7 rounded-md flex items-center justify-center text-text-tertiary hover:text-text-secondary hover:bg-surface-2 transition-colors no-drag"
          title="设置"
        >
          <Settings size={15} strokeWidth={1.75} />
        </button>
      </header>

      {/* Task list */}
      <div className="flex-1 overflow-y-auto scrollbar-thin py-1">
        {/* New tasks section — always visible */}
        <section className="px-2 mb-1">
          <div className="flex items-center gap-2 px-2.5 py-1.5">
            <span className="text-[11px] font-medium text-text-tertiary uppercase tracking-[0.04em]">新任务</span>
            <span className="text-[10px] font-medium text-accent bg-accent-subtle rounded-full px-1.5 py-[1px] min-w-[18px] text-center">
              {newTasks.length}
            </span>
          </div>
          {newTasks.length > 0 ? (
            <div className="space-y-0.5">
              {newTasks.map(task => (
                <SidebarTaskItem
                  key={task.id}
                  task={task}
                  selected={task.id === selectedTaskId}
                  onSelect={() => selectTask(task.id)}
                  isNew
                />
              ))}
            </div>
          ) : (
            <div className="px-3 py-2">
              <span className="text-[11px] text-text-tertiary/50">没有新到达的任务</span>
            </div>
          )}
        </section>

        {/* Active tasks section */}
        <section className="px-2">
          <div className="flex items-center gap-2 px-2.5 py-1.5">
            <span className="text-[11px] font-medium text-text-tertiary uppercase tracking-[0.04em]">处理中</span>
            <span className="text-[10px] text-text-tertiary">{activeTasks.length}</span>
          </div>
          {activeTasks.length > 0 ? (
            <div className="space-y-0.5">
              {visibleActive.map(task => (
                <SidebarTaskItem
                  key={task.id}
                  task={task}
                  selected={task.id === selectedTaskId}
                  onSelect={() => selectTask(task.id)}
                />
              ))}
              {!expanded && overflowCount > 0 && (
                <button onClick={() => setExpanded(true)} className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[12px] text-text-tertiary hover:text-text-secondary transition-colors">
                  <ChevronDown size={12} /> 还有 {overflowCount} 项
                </button>
              )}
              {expanded && overflowCount > 0 && (
                <button onClick={() => setExpanded(false)} className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[12px] text-text-tertiary hover:text-text-secondary transition-colors">
                  <ChevronUp size={12} /> 收起
                </button>
              )}
            </div>
          ) : (
            <div className="px-3 py-2">
              <span className="text-[11px] text-text-tertiary/50">没有处理中的任务</span>
            </div>
          )}
        </section>
      </div>

      {/* Chat entry — pinned bottom, matches right input area height */}
      <div className="px-3 pt-3 pb-4 shrink-0">
        <button
          onClick={() => setViewMode('chat')}
          className="w-full flex items-center justify-center gap-2.5 px-3.5 py-2.5 rounded-xl border border-accent/20 bg-accent/[0.03] text-text-secondary hover:border-accent/40 hover:bg-accent/[0.06] transition-all"
        >
          <Zap size={14} className="text-accent" />
          <span className="text-[13px] font-medium">有新想法？告诉 Aide</span>
        </button>
      </div>
    </aside>
  )
}

/* === Sidebar Task Item === */

function SidebarTaskItem({ task, selected, onSelect, isNew }: {
  task: Task; selected: boolean; onSelect: () => void; isNew?: boolean
}) {
  const { completeTask, snooze } = useTaskStore()
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)

  const priorityStyles = { p0: 'bg-[oklch(0.35_0.05_270)] text-white', p1: 'bg-[oklch(0.93_0.03_160)] text-[oklch(0.38_0.05_160)]', p2: 'bg-[oklch(0.95_0_0)] text-[oklch(0.55_0_0)]' }[task.priority] || 'bg-[oklch(0.95_0_0)] text-[oklch(0.55_0_0)]'

  return (
    <>
      <div
        className={`group relative flex items-center gap-2 px-2.5 py-[7px] rounded-lg cursor-pointer transition-all ${
          selected ? 'bg-accent-subtle' : 'hover:bg-surface-2'
        }`}
        onClick={onSelect}
        onContextMenu={e => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY }) }}
      >
        <span className={`shrink-0 px-[4px] py-[1px] rounded text-[9px] font-semibold leading-none ${priorityStyles}`}>
          {task.priority.toUpperCase()}
        </span>
        {task.status === 'in_progress' && (
          <div className="relative shrink-0 -ml-0.5">
            <div className="w-[5px] h-[5px] rounded-full bg-accent" />
            <div className="absolute inset-0 w-[5px] h-[5px] rounded-full bg-accent animate-ping opacity-30" />
          </div>
        )}

        <span className={`text-[13px] leading-[1.4] truncate flex-1 ${
          selected ? 'text-text-primary font-medium' : 'text-text-secondary'
        }`}>{task.title}</span>

        {isNew && (
          <div className="w-[5px] h-[5px] rounded-full bg-accent shrink-0 anim-pulse-dot" />
        )}

        {!isNew && (
          <div className="flex items-center shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={e => { e.stopPropagation(); completeTask(task.id) }}
              className="w-5 h-5 rounded flex items-center justify-center text-text-tertiary hover:text-success hover:bg-success/10 transition-colors"
              title="完成"
            >
              <Check size={12} strokeWidth={2} />
            </button>
            <button
              onClick={e => {
                e.stopPropagation()
                const t = new Date()
                t.setDate(t.getDate() + 1)
                t.setHours(9, 0, 0, 0)
                snooze(task.id, t.toISOString())
              }}
              className="w-5 h-5 rounded flex items-center justify-center text-text-tertiary hover:text-warning hover:bg-warning/10 transition-colors"
              title="延后"
            >
              <Clock size={12} strokeWidth={2} />
            </button>
          </div>
        )}
      </div>

      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={() => setContextMenu(null)} task={task} />
      )}
    </>
  )
}

/* === Context Menu === */

function ContextMenu({ x, y, onClose, task }: { x: number; y: number; onClose: () => void; task: Task }) {
  const { completeTask, cancelTask, snooze, updateTask } = useTaskStore()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  const items = [
    { icon: <Check size={13} />, label: '完成', action: () => completeTask(task.id) },
    { icon: <X size={13} />, label: '取消', action: () => cancelTask(task.id) },
    { icon: <ChevronDown size={13} />, label: '降低优先级', action: () => updateTask(task.id, { priority: 'p2' }) },
    { icon: <Clock size={13} />, label: '延后到明天', action: () => { const t = new Date(); t.setDate(t.getDate() + 1); t.setHours(9, 0, 0, 0); snooze(task.id, t.toISOString()) } },
    { icon: <Clock size={13} />, label: '延后到下周一', action: () => { const t = new Date(); const daysUntilMon = ((8 - t.getDay()) % 7) || 7; t.setDate(t.getDate() + daysUntilMon); t.setHours(9, 0, 0, 0); snooze(task.id, t.toISOString()) } },
  ]

  return (
    <div ref={ref} className="fixed z-50 bg-surface-0 border border-edge rounded-xl shadow-xl py-1.5 min-w-[160px] anim-fade-up" style={{ left: x, top: y }}>
      {items.map((item, i) => (
        <button key={i} onClick={() => { item.action(); onClose() }} className="w-full flex items-center gap-2.5 px-3 py-[6px] text-[13px] text-text-secondary hover:text-text-primary hover:bg-surface-1 transition-colors">
          <span className="text-text-tertiary">{item.icon}</span>{item.label}
        </button>
      ))}
    </div>
  )
}
