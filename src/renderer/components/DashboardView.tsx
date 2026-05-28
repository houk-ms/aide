import React, { useState, useMemo } from 'react'
import { Check, Clock, Mail, Github, MessageSquare, Calendar, User, Zap, X } from 'lucide-react'
import { useTaskStore } from '../stores/taskStore'
import type { Task, TaskSource } from '@shared/types'

type TimeRange = 'week' | 'month' | 'custom'

export function DashboardView() {
  const { tasks, selectTask, completeTask } = useTaskStore()

  // Categorize tasks
  const newTasks = tasks.filter(t =>
    (t.status === 'pending' || t.status === 'in_progress') && t.seenAt === null
  )
  const inProgressTasks = tasks.filter(t =>
    (t.status === 'pending' || t.status === 'in_progress') && t.seenAt !== null
  )
  const allCompleted = tasks.filter(t => t.status === 'completed' || t.status === 'cancelled')

  // Time range filter for completed
  const [timeRange, setTimeRange] = useState<TimeRange>('week')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')

  const completedTasks = useMemo(() => {
    const now = new Date()
    let from: Date

    if (timeRange === 'week') {
      from = new Date(now)
      const day = from.getDay() || 7
      from.setDate(from.getDate() - day + 1)
      from.setHours(0, 0, 0, 0)
    } else if (timeRange === 'month') {
      from = new Date(now.getFullYear(), now.getMonth(), 1)
    } else {
      from = customFrom ? new Date(customFrom) : new Date(0)
    }

    const to = timeRange === 'custom' && customTo
      ? new Date(new Date(customTo).getTime() + 86400000)
      : new Date(now.getTime() + 86400000)

    return allCompleted.filter(t => {
      const d = new Date(t.completedAt || t.updatedAt)
      return d >= from && d < to
    })
  }, [allCompleted, timeRange, customFrom, customTo])

  const completedByDate = groupByDate(completedTasks)
  const dateKeys = Object.keys(completedByDate)

  return (
    <div className="flex-1 flex flex-col bg-surface-0 min-w-0 min-h-0">
      {/* Header */}
      <header className="shrink-0">
        <div className="h-[52px] flex items-center px-6 drag-region">
          <span className="text-[13px] font-medium text-text-secondary no-drag">任务总览</span>
        </div>
        <div className="h-px bg-edge" />
      </header>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto scrollbar-thin min-h-0">
        <div className="px-8 py-7 space-y-8">

          {/* ═══ Section: 新任务 ═══ */}
          <section>
            <SectionBar title="新任务" count={newTasks.length} variant="accent" />
            {newTasks.length > 0 ? (
              <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
                {newTasks.map(task => (
                  <NewTaskCard key={task.id} task={task} onSelect={() => selectTask(task.id)} />
                ))}
              </div>
            ) : (
              <EmptySection message="没有新到达的任务" />
            )}
          </section>

          {/* ═══ Section: 进行中 ═══ */}
          <section>
            <SectionBar title="进行中" count={inProgressTasks.length} variant="default" />
            {inProgressTasks.length > 0 ? (
              <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
                {inProgressTasks.map(task => (
                  <InProgressCard key={task.id} task={task} onSelect={() => selectTask(task.id)} />
                ))}
              </div>
            ) : (
              <EmptySection message="没有正在处理的任务" />
            )}
          </section>

          {/* ═══ Section: 已完成 ═══ */}
          <section>
            <div className="flex items-center justify-between">
              <SectionBar title="已完成" count={completedTasks.length} variant="muted" />
              <div className="flex items-center gap-1">
                <RangeTab label="本周" active={timeRange === 'week'} onClick={() => setTimeRange('week')} />
                <RangeTab label="本月" active={timeRange === 'month'} onClick={() => setTimeRange('month')} />
                <RangeTab label="自定义" active={timeRange === 'custom'} onClick={() => setTimeRange('custom')} />
              </div>
            </div>

            {/* Custom date range inputs */}
            {timeRange === 'custom' && (
              <div className="flex items-center gap-2 mt-3">
                <input
                  type="date"
                  value={customFrom}
                  onChange={e => setCustomFrom(e.target.value)}
                  className="text-[12px] text-text-secondary bg-surface-1 border border-edge rounded-lg px-2.5 py-1.5 outline-none focus:border-accent/40"
                />
                <span className="text-[11px] text-text-tertiary">至</span>
                <input
                  type="date"
                  value={customTo}
                  onChange={e => setCustomTo(e.target.value)}
                  className="text-[12px] text-text-secondary bg-surface-1 border border-edge rounded-lg px-2.5 py-1.5 outline-none focus:border-accent/40"
                />
              </div>
            )}

            {completedTasks.length > 0 ? (
              <div className="mt-4">
                <CompletedTimeline
                  dateKeys={dateKeys}
                  groupedTasks={completedByDate}
                  onSelect={selectTask}
                />
              </div>
            ) : (
              <EmptySection message="该时间段内没有已完成的任务" />
            )}
          </section>

        </div>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════
   Section Bar
   ═══════════════════════════════════════════ */

function SectionBar({ title, count, variant }: {
  title: string
  count: number
  variant: 'accent' | 'default' | 'muted'
}) {
  const barColor = {
    accent: 'bg-accent',
    default: 'bg-warning',
    muted: 'bg-success'
  }[variant]

  const countStyle = {
    accent: 'bg-accent/8 text-accent',
    default: 'bg-surface-2 text-text-secondary',
    muted: 'bg-surface-2 text-text-tertiary'
  }[variant]

  return (
    <div className="flex items-center gap-3">
      <div className={`w-[3px] h-[14px] rounded-full ${barColor}`} />
      <h2 className="text-[13px] font-semibold text-text-primary tracking-[-0.01em]">{title}</h2>
      <span className={`text-[11px] font-medium rounded-md px-1.5 py-[2px] min-w-[20px] text-center ${countStyle}`}>
        {count}
      </span>
    </div>
  )
}

/* ═══════════════════════════════════════════
   Empty Section Placeholder
   ═══════════════════════════════════════════ */

function RangeTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`text-[11px] font-medium px-2.5 py-1 rounded-md transition-colors ${
        active
          ? 'bg-surface-2 text-text-primary'
          : 'text-text-tertiary hover:text-text-secondary'
      }`}
    >
      {label}
    </button>
  )
}

function EmptySection({ message }: { message: string }) {
  return (
    <div className="mt-3 rounded-xl border border-dashed border-edge bg-surface-0 py-8 flex items-center justify-center">
      <span className="text-[12px] text-text-tertiary/60">{message}</span>
    </div>
  )
}

/* ═══════════════════════════════════════════
   New Task Card — highest info density
   ═══════════════════════════════════════════ */

function NewTaskCard({ task, onSelect }: { task: Task; onSelect: () => void }) {
  const { completeTask } = useTaskStore()
  const priorityBorder = {
    high: 'border-l-danger',
    medium: 'border-l-warning',
    low: 'border-l-edge'
  }[task.priority]

  return (
    <div
      onClick={onSelect}
      className={`group relative bg-white border border-edge rounded-xl overflow-hidden cursor-pointer transition-all hover:shadow-[0_2px_8px_-2px_rgba(0,0,0,0.06)] border-l-[3px] ${priorityBorder}`}
    >
      <div className="px-4 py-3.5">
        {/* Title */}
        <h3 className="text-[14px] font-medium text-text-primary leading-[1.5] line-clamp-2 pr-16">
          {task.title}
        </h3>

        {/* Description — the key info */}
        {task.description && (
          <p className="text-[13px] text-text-secondary leading-[1.5] mt-2 line-clamp-2">
            {task.description}
          </p>
        )}

        {/* Subtle metadata footer */}
        <div className="flex items-center gap-3 mt-3 text-[11px] text-text-tertiary">
          <span className="inline-flex items-center gap-1">
            {getSourceIcon(task.source, 11)}
            {getSourceLabel(task.source)}
          </span>
          {task.dueDate && (
            <span className={isOverdue(task.dueDate) ? 'text-danger font-medium' : ''}>
              {getTimeText(task)}
            </span>
          )}
          <span className="ml-auto">{formatRelativeTime(task.createdAt)}</span>
        </div>
      </div>

      {/* Hover actions */}
      <div className="absolute right-3 top-3 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <ActionDot icon={<Check size={15} />} onClick={e => { e.stopPropagation(); completeTask(task.id) }} color="success" title="完成" />
        <ActionDot icon={<X size={15} />} onClick={e => { e.stopPropagation(); useTaskStore.getState().cancelTask(task.id) }} color="danger" title="忽略" />
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════
   In Progress Card — card style
   ═══════════════════════════════════════════ */

function InProgressCard({ task, onSelect }: { task: Task; onSelect: () => void }) {
  const { completeTask } = useTaskStore()

  return (
    <div
      onClick={onSelect}
      className="group relative bg-white border border-edge rounded-xl overflow-hidden cursor-pointer transition-all hover:shadow-[0_2px_8px_-2px_rgba(0,0,0,0.06)]"
    >
      <div className="px-4 py-3.5">
        {/* Title with live indicator */}
        <div className="flex items-center gap-2 pr-16">
          <div className="relative shrink-0">
            <div className={`w-2 h-2 rounded-full ${getPriorityColor(task.priority)}`} />
            {task.status === 'in_progress' && (
              <div className={`absolute inset-0 w-2 h-2 rounded-full ${getPriorityColor(task.priority)} animate-ping opacity-30`} />
            )}
          </div>
          <h3 className="text-[14px] font-medium text-text-primary leading-[1.5] line-clamp-2 flex-1">
            {task.title}
          </h3>
        </div>

        {/* Description — what's happening */}
        {task.description && (
          <p className="text-[13px] text-text-secondary leading-[1.5] mt-2 pl-[18px] line-clamp-2">
            {task.description}
          </p>
        )}

        {/* Subtle metadata footer */}
        <div className="flex items-center gap-3 mt-3 pl-[18px] text-[11px] text-text-tertiary">
          <span className="inline-flex items-center gap-1">
            {getSourceIcon(task.source, 11)}
            {getSourceLabel(task.source)}
          </span>
          <span>开始于 {formatRelativeTime(task.updatedAt)}</span>
          {task.dueDate && (
            <span className={isOverdue(task.dueDate) ? 'text-danger font-medium' : ''}>
              {getTimeText(task)}
            </span>
          )}
        </div>
      </div>

      {/* Hover actions */}
      <div className="absolute right-3 top-3 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <ActionDot icon={<Check size={15} />} onClick={e => { e.stopPropagation(); completeTask(task.id) }} color="success" title="完成" />
        <ActionDot icon={<X size={15} />} onClick={e => { e.stopPropagation(); useTaskStore.getState().cancelTask(task.id) }} color="danger" title="忽略" />
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════
   Completed Timeline
   ═══════════════════════════════════════════ */

function CompletedTimeline({ dateKeys, groupedTasks, onSelect }: {
  dateKeys: string[]
  groupedTasks: Record<string, Task[]>
  onSelect: (id: string) => void
}) {
  return (
    <div className="relative">
      {/* Vertical timeline line */}
      <div className="absolute left-[7px] top-2 bottom-2 w-px bg-edge" />

      <div className="space-y-5">
        {dateKeys.map(date => {
          const dayTasks = groupedTasks[date]
          return (
            <div key={date} className="relative pl-6">
              {/* Timeline node */}
              <div className="absolute left-[4px] top-[5px] w-[7px] h-[7px] rounded-full bg-success/60 border-2 border-surface-0" />

              {/* Date header */}
              <div className="flex items-baseline gap-2.5 mb-2">
                <span className="text-[12px] font-semibold text-text-secondary">{date}</span>
                <span className="text-[11px] text-text-tertiary">{dayTasks.length} 项完成</span>
              </div>

              {/* Tasks for this date */}
              <div className="space-y-1">
                {dayTasks.map(task => (
                  <div
                    key={task.id}
                    onClick={() => onSelect(task.id)}
                    className="flex items-center gap-2.5 py-[5px] px-2.5 -mx-1 rounded-lg cursor-pointer hover:bg-surface-1 transition-colors group"
                  >
                    <Check size={12} className="text-success/50 shrink-0" />
                    <span className="text-[13px] text-text-tertiary group-hover:text-text-secondary truncate flex-1 transition-colors">
                      {task.title}
                    </span>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[10px] text-text-tertiary/40">
                        {getSourceIcon(task.source, 10)}
                      </span>
                      <span className="text-[11px] text-text-tertiary/50 tabular-nums">
                        {task.completedAt
                          ? new Date(task.completedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
                          : ''
                        }
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════
   Small Components
   ═══════════════════════════════════════════ */

function ActionDot({ icon, onClick, color, title }: {
  icon: React.ReactNode
  onClick: (e: React.MouseEvent) => void
  color: 'success' | 'warning' | 'danger'
  title: string
}) {
  const styles = {
    success: 'hover:text-success hover:bg-success/10',
    warning: 'hover:text-warning hover:bg-warning/10',
    danger: 'hover:text-danger hover:bg-danger/10'
  }[color]

  return (
    <button
      onClick={onClick}
      className={`w-8 h-8 rounded-lg flex items-center justify-center text-text-tertiary transition-colors bg-white/90 backdrop-blur-sm border border-edge/50 shadow-sm ${styles}`}
      title={title}
    >
      {icon}
    </button>
  )
}

/* ═══════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════ */

function getPriorityColor(priority: string): string {
  return { high: 'bg-danger', medium: 'bg-warning', low: 'bg-text-tertiary' }[priority] || 'bg-text-tertiary'
}

function getSourceIcon(source: TaskSource, size = 12): React.ReactNode {
  const cls = "shrink-0"
  switch (source.type) {
    case 'email': return <Mail size={size} className={cls} />
    case 'github': return <Github size={size} className={cls} />
    case 'teams': return <MessageSquare size={size} className={cls} />
    case 'calendar': return <Calendar size={size} className={cls} />
    case 'user': return <User size={size} className={cls} />
    case 'agent': return <Zap size={size} className={cls} />
    default: return <User size={size} className={cls} />
  }
}

function getSourceLabel(source: TaskSource): string {
  const map: Record<string, string> = {
    email: '邮件', github: 'GitHub', teams: 'Teams',
    calendar: '日历', user: '自建', agent: 'Agent'
  }
  return map[source.type] || source.type
}

function getTimeText(task: Task): string | null {
  if (!task.dueDate) return null
  const diff = Math.ceil((new Date(task.dueDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
  if (diff < 0) return `逾期 ${Math.abs(diff)} 天`
  if (diff === 0) return '今天到期'
  if (diff === 1) return '明天到期'
  if (diff <= 7) return `${diff} 天后`
  return new Date(task.dueDate).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) + ' 到期'
}

function isOverdue(dateStr: string): boolean {
  return new Date(dateStr).getTime() < Date.now()
}

function formatRelativeTime(isoStr: string): string {
  const diffMs = Date.now() - new Date(isoStr).getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return '刚刚'
  if (diffMin < 60) return `${diffMin} 分钟前`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return `${diffH} 小时前`
  const diffD = Math.floor(diffH / 24)
  if (diffD === 1) return '昨天'
  if (diffD < 7) return `${diffD} 天前`
  return new Date(isoStr).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

function groupByDate(tasks: Task[]): Record<string, Task[]> {
  const groups: Record<string, Task[]> = {}
  const today = new Date().toLocaleDateString('zh-CN')
  const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('zh-CN')

  // Sort completed tasks by time descending
  const sorted = [...tasks].sort((a, b) => {
    const ta = a.completedAt || a.updatedAt
    const tb = b.completedAt || b.updatedAt
    return new Date(tb).getTime() - new Date(ta).getTime()
  })

  for (const task of sorted) {
    const d = task.completedAt
      ? new Date(task.completedAt).toLocaleDateString('zh-CN')
      : new Date(task.updatedAt).toLocaleDateString('zh-CN')
    const label = d === today ? '今天' : d === yesterday ? '昨天' : d
    if (!groups[label]) groups[label] = []
    groups[label].push(task)
  }
  return groups
}
