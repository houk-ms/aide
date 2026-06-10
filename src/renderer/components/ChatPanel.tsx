import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowUp, ChevronLeft, Check, X, Pencil, ChevronDown, ChevronRight, Paperclip, Copy, CheckCheck, Square, Loader2, Activity, FileText, FolderOpen, FileCode, FileArchive, FileVideo, FileAudio, File as FileIcon, AlertTriangle, Download } from 'lucide-react'
import { useTaskStore } from '../stores/taskStore'
import { useChatStore, GENERAL_KEY } from '../stores/chatStore'
import type { LiveStep } from '../stores/chatStore'
import type { ChatMessage, ChatAttachment, PendingAction, ModelInfo, TaskActivity, TurnStep, Task } from '@shared/types'

// Stable empty reference so the per-session live selector doesn't return a new
// array each render (which would thrash zustand's equality check).
const EMPTY_STEPS: LiveStep[] = []

// Agent-created files are referenced in chat as inline code, e.g.
// `session-state/.../files/Report.md` or a bare `Report.md`. We turn those into
// clickable chips. Detection is deliberately high-precision: either the text
// names the artifacts folder, or it's a single token with a known document
// extension. The chip itself confirms the file actually exists before becoming
// interactive (see FileChip), so a stray code reference never shows a dead link.
const ARTIFACT_EXT = /\.(md|markdown|txt|csv|tsv|json|ya?ml|pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|svg|html?|zip|log)$/i

function isArtifactCandidate(text: string): boolean {
  const t = text.trim()
  if (!t || /\n/.test(t)) return false
  if (/(^|[\\/])files[\\/]/.test(t) || /session-state/.test(t)) return true
  // Bare filename with a document-ish extension and no spaces.
  return !/\s/.test(t) && ARTIFACT_EXT.test(t)
}

// A clickable reference to an agent-created file. Resolves against the session's
// artifact sandbox; only renders interactive controls once existence is
// confirmed, otherwise falls back to plain inline code.
function FileChip({ taskId, refPath }: { taskId: string | null; refPath: string }) {
  const name = refPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || refPath
  const [exists, setExists] = useState(false)

  useEffect(() => {
    let alive = true
    window.aide.files.exists(taskId, refPath).then(ok => { if (alive) setExists(ok) }).catch(() => {})
    return () => { alive = false }
  }, [taskId, refPath])

  if (!exists) {
    return <code className="px-1 py-0.5 rounded bg-surface-2 text-[12px] text-text-secondary break-all">{refPath}</code>
  }

  return (
    <span className="inline-flex items-center gap-0.5 align-middle max-w-full">
      <button
        onClick={() => window.aide.files.open(taskId, refPath)}
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-surface-2 hover:bg-accent-muted text-accent text-[12px] font-medium transition-colors max-w-full"
        title={`Open ${name}`}
      >
        <FileText size={12} className="shrink-0" />
        <span className="truncate max-w-[220px]">{name}</span>
      </button>
      <button
        onClick={() => window.aide.files.reveal(taskId, refPath)}
        className="inline-flex items-center justify-center w-5 h-5 rounded text-text-tertiary hover:text-text-secondary hover:bg-surface-2 transition-colors shrink-0"
        title="Reveal in folder"
      >
        <FolderOpen size={11} />
      </button>
    </span>
  )
}

// Markdown component overrides bound to a session, so inline file references
// resolve against the right artifact sandbox. Cached per session: ReactMarkdown
// re-parses whenever the `components` prop identity changes, so handing it a new
// object on every keystroke would re-render all message markdown (visible fl
// flicker). The cache keeps the reference stable.
const mdComponentsCache = new Map<string, Components>()
function makeMarkdownComponents(taskId: string | null): Components {
  const key = taskId ?? '__general__'
  const cached = mdComponentsCache.get(key)
  if (cached) return cached
  const components: Components = {
    code({ className, children, ...props }) {
      const text = String(children ?? '')
      const isBlock = (className || '').includes('language-') || text.includes('\n')
      if (!isBlock && isArtifactCandidate(text)) {
        return <FileChip taskId={taskId} refPath={text.trim()} />
      }
      return <code className={className} {...props}>{children}</code>
    }
  }
  mdComponentsCache.set(key, components)
  return components
}

interface Attachment {
  id: string
  name: string
  type: string
  size: number
  dataUrl: string
}

export function ChatPanel() {
  const selectedTaskId = useTaskStore(s => s.selectedTaskId)
  const tasks = useTaskStore(s => s.tasks)
  const selectTask = useTaskStore(s => s.selectTask)
  const goHome = useTaskStore(s => s.goHome)
  const { messages, fetchHistory, sendMessage, stopStream, modifyDraft, setModifyDraft } = useChatStore()
  // Live turn state is per-session, so an in-flight turn in another conversation
  // keeps streaming in the background and this view always reflects the session
  // currently open — switching never looks interrupted.
  const sessionKey = selectedTaskId ?? GENERAL_KEY
  const liveSteps = useChatStore(s => s.liveStepsBySession[sessionKey] ?? EMPTY_STEPS)
  const isStreaming = useChatStore(s => s.streamingBySession[sessionKey] ?? false)
  const loadedSessionKey = useChatStore(s => s.loadedSessionKey)
  const [input, setInput] = useState('')
  const [models, setModels] = useState<ModelInfo[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [showOtherModels, setShowOtherModels] = useState(false)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const triggeredTasksRef = useRef<Set<string>>(new Set())

  const selectedTask = selectedTaskId ? tasks.find(t => t.id === selectedTaskId) : null

  useEffect(() => { fetchHistory(selectedTaskId) }, [selectedTaskId])
  // When entering a task/conversation, force-jump to the latest message so the
  // user lands at the tail (not the top of a long history).
  const justSwitchedRef = useRef(true)
  useEffect(() => { justSwitchedRef.current = true }, [selectedTaskId])
  // Auto-follow the tail, but don't fight the user: only scroll when they're
  // already near the bottom. During streaming use an instant jump (smooth
  // scrolling can't keep up with bursty token deltas and feels laggy).
  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    if (justSwitchedRef.current) {
      // Don't consume the jump until the freshly-loaded history for THIS session
      // has actually landed. fetchHistory is async, so right after a switch the
      // view may still be showing the previous session's messages — jumping then
      // would land on stale content and leave the new history scrolled up.
      if (loadedSessionKey !== sessionKey) return
      justSwitchedRef.current = false
      // Pin to the absolute bottom. Do it now (post-commit) and again over the
      // next frames, since markdown/code/images can grow content height after
      // first paint and async panels (task activity) expand a tick later.
      const pin = () => { el.scrollTop = el.scrollHeight }
      pin()
      requestAnimationFrame(pin)
      requestAnimationFrame(() => requestAnimationFrame(pin))
      setTimeout(pin, 60)
      setTimeout(pin, 160)
      return
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160
    if (nearBottom) {
      messagesEndRef.current?.scrollIntoView({ behavior: isStreaming ? 'auto' : 'smooth' })
    }
  }, [messages, liveSteps, isStreaming, selectedTaskId, loadedSessionKey])
  useEffect(() => { inputRef.current?.focus() }, [selectedTaskId])

  useEffect(() => {
    window.aide.models.list().then(ms => { console.log('[Models]', JSON.stringify(ms.map(m => m.id))); setModels(ms) })
    window.aide.models.getSelected().then(s => { console.log('[SelectedModel]', s); setSelectedModel(s) })
  }, [])

  useEffect(() => {
    if (selectedTaskId && !triggeredTasksRef.current.has(selectedTaskId)) {
      triggeredTasksRef.current.add(selectedTaskId)
      window.aide.chat.triggerFirstMessage(selectedTaskId)
    }
  }, [selectedTaskId])

  useEffect(() => {
    if (modifyDraft) {
      setInput(modifyDraft)
      setModifyDraft(null)
      inputRef.current?.focus()
    }
  }, [modifyDraft])

  const handleSend = useCallback(() => {
    const trimmed = input.trim()
    if (!trimmed || isStreaming) return
    const toSend = attachments.length > 0
      ? attachments.map(a => ({ name: a.name, type: a.type, dataUrl: a.dataUrl }))
      : undefined
    sendMessage(trimmed, selectedTaskId, toSend)
    setInput('')
    setAttachments([])
    if (inputRef.current) inputRef.current.style.height = 'auto'
  }, [input, isStreaming, selectedTaskId, sendMessage, attachments])

  const handleModelSelect = useCallback((modelId: string) => {
    setSelectedModel(modelId)
    setShowModelPicker(false)
    window.aide.models.setSelected(modelId)
  }, [])

  const handleFileSelect = useCallback((files: FileList | null) => {
    if (!files) return
    const rejected: string[] = []
    Array.from(files).forEach(file => {
      if (file.size > MAX_ATTACHMENT_BYTES) { rejected.push(file.name); return }
      const reader = new FileReader()
      reader.onload = () => {
        setAttachments(prev => [...prev, {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: file.name,
          type: file.type,
          size: file.size,
          dataUrl: reader.result as string
        }])
      }
      reader.readAsDataURL(file)
    })
    if (rejected.length > 0) {
      setAttachmentError(
        `${rejected.join(', ')} ${rejected.length > 1 ? 'exceed' : 'exceeds'} the ${formatBytes(MAX_ATTACHMENT_BYTES)} limit`
      )
    }
  }, [])

  // Auto-dismiss the attachment warning so it never lingers.
  useEffect(() => {
    if (!attachmentError) return
    const t = setTimeout(() => setAttachmentError(null), 4000)
    return () => clearTimeout(t)
  }, [attachmentError])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    const files: File[] = []
    for (const item of Array.from(items)) {
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (file) files.push(file)
      }
    }
    if (files.length > 0) {
      e.preventDefault()
      const dt = new DataTransfer()
      files.forEach(f => dt.items.add(f))
      handleFileSelect(dt.files)
    }
  }, [handleFileSelect])

  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id))
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }

  return (
    <div className="flex-1 flex flex-col bg-surface-0 min-w-0 min-h-0">
      {/* Header — drag region for frameless window */}
      {selectedTask ? (
        <TaskHeader task={selectedTask} onBack={() => goHome()} />
      ) : (
        <header className="shrink-0">
          <div className="h-[52px] flex items-center gap-2 px-5 drag-region">
            <button onClick={() => goHome()} className="w-7 h-7 rounded-md flex items-center justify-center text-text-tertiary hover:text-text-secondary hover:bg-surface-2 transition-colors no-drag" title="Back">
              <ChevronLeft size={16} strokeWidth={2} />
            </button>
            <span className="text-[13px] font-medium text-text-secondary no-drag">Aide</span>
          </div>
          <div className="h-px bg-edge" />
        </header>
      )}

      {/* Task status — pinned above messages */}
      {selectedTask && (
        <TaskStatusBar task={selectedTask} />
      )}

      {/* Messages */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto scrollbar-thin min-h-0">
        <div className="chat-content-width mx-auto px-6 py-6 space-y-5">

          {messages.length === 0 && !isStreaming && <EmptyState taskTitle={selectedTask?.title} />}

          {messages.map(msg => <MessageBubble key={msg.id} message={msg} />)}

          {/* Agent's current turn: live interleaved timeline (narration + tools) */}
          {(liveSteps.length > 0 || isStreaming) && (
            <div className="flex gap-3 anim-fade-up">
              <AgentAvatar />
              <div className="flex-1 min-w-0 pt-0.5">
                {liveSteps.length > 0 ? (
                  <Timeline steps={liveStepsToTimeline(liveSteps)} live={isStreaming} taskId={selectedTaskId} cap />
                ) : (
                  <TypingIndicator />
                )}
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input Area */}
      <div className="shrink-0">
        <div className="chat-content-width mx-auto px-6 py-3 pb-4">
          {/* Oversized-file warning (auto-dismisses) */}
          {attachmentError && (
            <div className="flex items-center gap-2 mb-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/25 text-[12px] text-amber-500 anim-fade-up">
              <AlertTriangle size={13} className="shrink-0" />
              <span className="flex-1 min-w-0 truncate">{attachmentError}</span>
              <button onClick={() => setAttachmentError(null)} className="text-amber-500/70 hover:text-amber-500 shrink-0">
                <X size={12} />
              </button>
            </div>
          )}
          {/* Attachment preview */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {attachments.map(a => (
                <div key={a.id} className="flex items-center gap-1.5 px-2.5 py-1 bg-surface-1 border border-edge rounded-lg text-[12px] text-text-secondary">
                  {a.type.startsWith('image/') ? (
                    <img src={a.dataUrl} className="w-5 h-5 rounded object-cover" alt="" />
                  ) : (
                    <AttachmentIcon kind={attachmentKind(a.type, a.name)} size={13} />
                  )}
                  <span className="max-w-[120px] truncate">{a.name}</span>
                  {a.size > 0 && <span className="text-[10.5px] text-text-tertiary">{formatBytes(a.size)}</span>}
                  <button onClick={() => removeAttachment(a.id)} className="text-text-tertiary hover:text-text-primary ml-0.5">
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Composer box */}
          <div className="bg-surface-1 rounded-2xl border border-edge transition-all focus-within:border-accent/40 focus-within:shadow-[0_0_0_3px_var(--color-accent-subtle)]">
            {/* Text area */}
            <div className="px-4 pt-3 pb-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder={selectedTask ? `About “${selectedTask.title}”…` : 'Message Aide…'}
                className="w-full bg-transparent text-[14px] text-text-primary placeholder:text-text-tertiary resize-none outline-none max-h-40 leading-[1.6]"
                rows={1}
                onInput={(e) => {
                  const t = e.target as HTMLTextAreaElement
                  t.style.height = 'auto'
                  t.style.height = Math.min(t.scrollHeight, 160) + 'px'
                }}
              />
            </div>

            {/* Bottom toolbar */}
            <div className="flex items-center justify-between px-3 pb-2.5">
              <div className="flex items-center gap-1">
                {/* Attachment button */}
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-7 h-7 rounded-lg flex items-center justify-center text-text-tertiary hover:text-text-secondary hover:bg-surface-2 transition-colors"
                  title="Add attachment (preview)"
                >
                  <Paperclip size={15} />
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={e => { handleFileSelect(e.target.files); e.target.value = '' }}
                />

                {/* Model selector */}
                <div className="relative">
                  <button
                    onClick={() => setShowModelPicker(!showModelPicker)}
                    className="h-7 px-2 rounded-lg flex items-center gap-1 text-[12px] text-text-tertiary hover:text-text-secondary hover:bg-surface-2 transition-colors"
                  >
                    {models.find(m => m.id === selectedModel)?.name || selectedModel || 'Model'}
                    <ChevronDown size={11} />
                  </button>
                  {showModelPicker && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setShowModelPicker(false)} />
                      <div className="absolute bottom-full left-0 mb-1.5 bg-surface-0 border border-edge rounded-xl shadow-lg py-1.5 min-w-[320px] w-max z-50">
                        {(() => {
                          const featured = ['claude-opus-4.8', 'claude-opus-4.7', 'claude-opus-4.6', 'gpt-5.5', 'gpt-5.4']
                          const featuredModels = featured
                            .map(id => models.find(m => m.id === id))
                            .filter((m): m is ModelInfo => !!m)
                          const otherModels = models.filter(m => !featured.includes(m.id))
                          return (
                            <>
                              {featuredModels.map(m => (
                                <button
                                  key={m.id}
                                  onClick={() => handleModelSelect(m.id)}
                                  className={`w-full text-left px-3 py-1.5 text-[13px] hover:bg-surface-1 transition-colors flex items-center gap-2 ${m.id === selectedModel ? 'text-accent font-medium' : 'text-text-secondary'}`}
                                >
                                  {m.id === selectedModel && <Check size={13} className="shrink-0" />}
                                  <span className={m.id === selectedModel ? '' : 'ml-[21px]'}>{m.name}</span>
                                </button>
                              ))}
                              {/* If selected model is not in featured, show it at top */}
                              {selectedModel && !featured.includes(selectedModel) && (
                                <button
                                  key={selectedModel}
                                  className="w-full text-left px-3 py-1.5 text-[13px] text-accent font-medium flex items-center gap-2"
                                >
                                  <Check size={13} className="shrink-0" />
                                  <span>{models.find(m => m.id === selectedModel)?.name || selectedModel}</span>
                                </button>
                              )}
                              {otherModels.length > 0 && (
                                <>
                                  <div className="my-1 border-t border-edge" />
                                  <button
                                    onClick={(e) => { e.stopPropagation(); setShowOtherModels(!showOtherModels) }}
                                    className="w-full text-left px-3 py-1.5 text-[13px] text-text-tertiary hover:text-text-secondary hover:bg-surface-1 transition-colors flex items-center gap-2"
                                  >
                                    <ChevronDown size={13} className={`shrink-0 transition-transform ${showOtherModels ? 'rotate-180' : ''}`} />
                                    <span>Other Models</span>
                                  </button>
                                  {showOtherModels && otherModels.map(m => (
                                    <button
                                      key={m.id}
                                      onClick={() => handleModelSelect(m.id)}
                                      className={`w-full text-left px-3 py-1.5 text-[13px] hover:bg-surface-1 transition-colors flex items-center gap-2 ${m.id === selectedModel ? 'text-accent font-medium' : 'text-text-secondary'}`}
                                    >
                                      {m.id === selectedModel && <Check size={13} className="shrink-0" />}
                                      <span className={m.id === selectedModel ? '' : 'ml-[21px]'}>{m.name}</span>
                                    </button>
                                  ))}
                                </>
                              )}
                            </>
                          )
                        })()}
                        {models.length === 0 && (
                          <p className="px-3 py-2 text-[12px] text-text-tertiary">Loading…</p>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Send / Stop button */}
              {isStreaming ? (
                <button
                  onClick={() => stopStream(selectedTaskId)}
                  className="w-8 h-8 rounded-lg flex items-center justify-center bg-surface-2 text-text-secondary hover:bg-surface-3 hover:text-text-primary transition-all shrink-0"
                  title="Stop generating"
                >
                  <Square size={14} fill="currentColor" />
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!input.trim() && attachments.length === 0}
                  className="w-8 h-8 rounded-lg flex items-center justify-center bg-accent text-white disabled:bg-surface-2 disabled:text-text-tertiary transition-all shrink-0"
                >
                  <ArrowUp size={16} strokeWidth={2.5} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/* === Task Header === */

function TaskHeader({ task, onBack }: {
  task: { id: string; title: string; status: string; priority: string; description: string; source: { type: string; externalUrl?: string }; dueDate: string | null; relatedRelationIds: string[]; projectIds: string[]; lastActivityAt?: string | null }
  onBack: () => void
}) {
  const { completeTask, cancelTask } = useTaskStore()
  const sourceLabel: Record<string, string> = { email: 'Email', github: 'GitHub', teams: 'Teams', calendar: 'Calendar', user: 'Manual', agent: 'Agent' }
  const statusLabel: Record<string, string> = { pending: 'Pending', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' }
  const isOpen = task.status === 'pending' || task.status === 'in_progress'

  return (
    <header className="shrink-0">
      <div className="flex items-center gap-2 px-5 h-[52px] drag-region">
        <button onClick={onBack} className="w-7 h-7 rounded-md flex items-center justify-center text-text-tertiary hover:text-text-secondary hover:bg-surface-2 transition-colors no-drag" title="Back">
          <ChevronLeft size={16} strokeWidth={2} />
        </button>
        <h2 className="text-[13px] font-medium text-text-primary truncate flex-1 no-drag">{task.title}</h2>
      </div>
      <div className="px-5 pb-2 flex items-center gap-2 text-[12px] text-text-tertiary flex-wrap">
        <PriorityBadge priority={task.priority} />
        <span className="text-edge">·</span>
        <span>{sourceLabel[task.source.type] || task.source.type}</span>
        {task.source.externalUrl && (
          <a href={task.source.externalUrl} className="text-accent hover:underline" target="_blank" rel="noopener">↗</a>
        )}
        <span className="text-edge">·</span>
        <span className={task.status === 'in_progress' ? 'text-accent' : ''}>{statusLabel[task.status] || task.status}</span>
        {task.dueDate && (
          <>
            <span className="text-edge">·</span>
            <span className={new Date(task.dueDate) < new Date() ? 'text-danger font-medium' : ''}>
              {getDueLabel(task.dueDate)}
            </span>
          </>
        )}
        {isOpen && (
          <div className="ml-auto flex items-center gap-1">
            <button onClick={() => cancelTask(task.id)} className="h-6 px-2 rounded-md text-[12px] text-text-tertiary hover:text-danger hover:bg-danger/8 transition-colors flex items-center gap-1">
              <X size={12} /> Cancel
            </button>
            <button onClick={() => completeTask(task.id)} className="h-6 px-2 rounded-md text-[12px] font-medium text-success hover:bg-success/10 transition-colors flex items-center gap-1">
              <Check size={12} /> Done
            </button>
          </div>
        )}
      </div>
      <div className="h-px bg-edge" />
    </header>
  )
}

/* === Task Status Bar — pinned section with working state + activity === */

function TaskStatusBar({ task }: { task: Task }) {
  const [stateExpanded, setStateExpanded] = useState(false)

  return (
    <div className="shrink-0 border-b border-edge">
      <div className="chat-content-width mx-auto px-6 py-3 space-y-2">
        {/* Working state card */}
        {task.workingState && (
          <div className="rounded-xl border border-edge bg-surface-1/50 overflow-hidden">
            <button
              onClick={() => setStateExpanded(v => !v)}
              className="w-full flex items-center gap-2.5 px-4 py-2.5 hover:bg-surface-2/50 transition-colors text-left"
            >
              <div className="w-6 h-6 rounded-md bg-surface-2 flex items-center justify-center shrink-0">
                <FileText size={13} className="text-text-secondary" strokeWidth={2} />
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-[12px] font-medium text-text-secondary">Current state</span>
                {!stateExpanded && (
                  <div className="text-[12px] text-text-tertiary truncate mt-0.5">
                    {task.workingState.split('\n')[0]}
                  </div>
                )}
              </div>
              <div className="shrink-0 text-text-tertiary">
                {stateExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </div>
            </button>
            {stateExpanded && (
              <div className="px-4 pb-3 pt-0">
                <div className="text-[12.5px] text-text-secondary leading-[1.6] whitespace-pre-wrap break-words select-text">
                  {task.workingState}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Activity timeline */}
        <TaskActivityPanel taskId={task.id} lastActivityAt={task.lastActivityAt} />
      </div>
    </div>
  )
}

/* === Task Activity Panel — prominent card at top of conversation === */

function TaskActivityPanel({ taskId, lastActivityAt }: { taskId: string; lastActivityAt?: string | null }) {
  const [activities, setActivities] = useState<TaskActivity[]>([])
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let alive = true
    window.aide.tasks.listActivities(taskId).then(a => { if (alive) setActivities(a) })
    return () => { alive = false }
  }, [taskId, lastActivityAt])

  if (activities.length === 0) return null

  const latest = activities[0]
  const typeMeta: Record<string, { label: string; dot: string; text: string }> = {
    progress: { label: 'Progress', dot: 'bg-accent', text: 'text-accent' },
    status_change: { label: 'Status', dot: 'bg-text-tertiary', text: 'text-text-secondary' },
    blocker: { label: 'Blocked', dot: 'bg-danger', text: 'text-danger' },
    comment: { label: 'Needs reply', dot: 'bg-success', text: 'text-success' },
    note: { label: 'Note', dot: 'bg-accent', text: 'text-accent' }
  }

  return (
    <div className="rounded-xl border border-accent/25 bg-accent/[0.04] overflow-hidden">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-2.5 px-4 py-2.5 hover:bg-accent/[0.06] transition-colors text-left"
      >
        <div className="w-6 h-6 rounded-md bg-accent/12 flex items-center justify-center shrink-0">
          <Activity size={13} className="text-accent" strokeWidth={2} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-semibold text-text-primary">Activity</span>
            <span className="text-[11px] font-medium text-accent bg-accent/12 rounded-full px-1.5 py-[1px]">{activities.length}</span>
          </div>
          {!expanded && latest && (
            <div className="text-[12px] text-text-secondary truncate mt-0.5">
              Latest · {latest.summary}
            </div>
          )}
        </div>
        <div className="shrink-0 text-text-tertiary">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-3 pt-1">
          <div className="relative pl-5">
            <div className="absolute left-[5px] top-1.5 bottom-1.5 w-px bg-edge" />
            <div className="space-y-3">
              {activities.map(a => {
                const m = typeMeta[a.type] || typeMeta.note
                return (
                  <div key={a.id} className="relative">
                    <div className={`absolute -left-5 top-1 w-[11px] h-[11px] rounded-full ring-2 ring-surface-0 ${m.dot}`} />
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className={`text-[11px] font-medium ${m.text}`}>{m.label}</span>
                      <span className="text-[11px] text-text-tertiary/70">{formatActivityTime(a.timestamp)}</span>
                    </div>
                    <div className="text-[12.5px] text-text-secondary leading-[1.55] break-words select-text">{a.summary}</div>
                    {a.sourceRef && (
                      <div className="inline-flex items-center mt-1 text-[10.5px] text-text-tertiary/70 bg-surface-1 border border-edge rounded px-1.5 py-[1px] font-mono max-w-full truncate">
                        {a.sourceRef}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function formatActivityTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}

/* === Message Bubble === */

// Per-file attachment ceiling. Each attachment is base64-inlined into the
// message and persisted, so an unbounded file would bloat the DB; 10 MB
// comfortably covers images and documents while keeping storage lean.
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

// Human-readable byte size for an attachment label.
function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
  const mb = kb / 1024
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

// Approximate the decoded byte size of a base64 data URL (display only).
function dataUrlBytes(dataUrl: string): number {
  const i = dataUrl.indexOf('base64,')
  if (i === -1) return 0
  const b64 = dataUrl.slice(i + 7)
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding)
}

// Classify an attachment from its MIME type, falling back to the filename
// extension when the type is missing or too generic to be useful.
type FileKind = 'image' | 'video' | 'audio' | 'pdf' | 'archive' | 'code' | 'doc' | 'file'
function attachmentKind(type: string, name: string): FileKind {
  const t = (type || '').toLowerCase()
  const ext = name.toLowerCase().split('.').pop() || ''
  if (t.startsWith('image/')) return 'image'
  if (t.startsWith('video/')) return 'video'
  if (t.startsWith('audio/')) return 'audio'
  if (t === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (/(zip|tar|gzip|x-7z|x-rar|compressed)/.test(t) || ['zip', 'tar', 'gz', 'tgz', 'rar', '7z'].includes(ext)) return 'archive'
  if (t.startsWith('text/') || ['js', 'ts', 'tsx', 'jsx', 'json', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'cs', 'php', 'sh', 'css', 'html', 'xml', 'yml', 'yaml', 'sql', 'md'].includes(ext)) return 'code'
  if (['doc', 'docx', 'rtf', 'odt', 'xls', 'xlsx', 'csv', 'ppt', 'pptx'].includes(ext) || /(word|excel|spreadsheet|presentation|officedocument)/.test(t)) return 'doc'
  return 'file'
}

function AttachmentIcon({ kind, size = 13 }: { kind: FileKind; size?: number }) {
  const cls = 'shrink-0 text-text-tertiary'
  switch (kind) {
    case 'video': return <FileVideo size={size} className={cls} />
    case 'audio': return <FileAudio size={size} className={cls} />
    case 'pdf': return <FileText size={size} className={cls} />
    case 'archive': return <FileArchive size={size} className={cls} />
    case 'code': return <FileCode size={size} className={cls} />
    case 'doc': return <FileText size={size} className={cls} />
    default: return <FileIcon size={size} className={cls} />
  }
}

// Full-screen image preview. Electron's renderer ignores target="_blank", so a
// thumbnail click opens this in-app lightbox instead. Dismiss via the close
// button, a backdrop click, or Esc.
function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
  }, [onClose])
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm anim-fade-in"
      onClick={onClose}
    >
      <div className="absolute top-4 right-4 flex items-center gap-2">
        <a
          href={src}
          download={alt}
          onClick={e => e.stopPropagation()}
          className="w-9 h-9 rounded-full flex items-center justify-center bg-white/10 hover:bg-white/20 text-white/90 transition-colors"
          title="Download"
        >
          <Download size={17} />
        </a>
        <button
          onClick={onClose}
          className="w-9 h-9 rounded-full flex items-center justify-center bg-white/10 hover:bg-white/20 text-white/90 transition-colors"
          title="Close (Esc)"
        >
          <X size={18} />
        </button>
      </div>
      <img
        src={src}
        alt={alt}
        onClick={e => e.stopPropagation()}
        className="max-w-[92vw] max-h-[92vh] object-contain rounded-lg shadow-2xl anim-zoom-in"
      />
    </div>
  )
}

// Renders the files a user attached to a message. Images become inline
// thumbnails (click to open a full-screen preview), audio/video get a compact
// inline player, and everything else a labeled chip (click to open/download) —
// so each kind reads at a glance.
function MessageAttachments({ attachments, isUser }: { attachments: ChatAttachment[]; isUser: boolean }) {
  const [preview, setPreview] = useState<ChatAttachment | null>(null)
  return (
    <div className={`mt-1.5 flex flex-wrap gap-2 ${isUser ? 'justify-end' : ''}`}>
      {attachments.map((a, i) => {
        const kind = attachmentKind(a.type, a.name)
        if (kind === 'image') {
          return (
            <button
              key={i}
              type="button"
              onClick={() => setPreview(a)}
              title={a.name}
              className="block rounded-xl overflow-hidden border border-edge hover:border-accent/50 transition-colors cursor-zoom-in"
            >
              <img
                src={a.dataUrl}
                alt={a.name}
                className="max-w-[220px] max-h-[220px] object-cover"
              />
            </button>
          )
        }
        if (kind === 'video') {
          return (
            <video
              key={i}
              src={a.dataUrl}
              controls
              className="max-w-[260px] max-h-[200px] rounded-xl border border-edge bg-black/40"
            />
          )
        }
        if (kind === 'audio') {
          return (
            <div key={i} className="flex flex-col gap-1.5 px-3 py-2 rounded-xl bg-surface-2 border border-edge-subtle max-w-[260px]">
              <div className="flex items-center gap-1.5 text-[12px] text-text-secondary">
                <FileAudio size={13} className="shrink-0 text-text-tertiary" />
                <span className="truncate" title={a.name}>{a.name}</span>
              </div>
              <audio src={a.dataUrl} controls className="w-full h-8" />
            </div>
          )
        }
        const sizeLabel = formatBytes(dataUrlBytes(a.dataUrl))
        return (
          <a
            key={i}
            href={a.dataUrl}
            target="_blank"
            rel="noreferrer"
            download={a.name}
            title={a.name}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-surface-2 border border-edge-subtle hover:border-edge transition-colors max-w-[240px]"
          >
            <AttachmentIcon kind={kind} size={16} />
            <span className="flex flex-col min-w-0">
              <span className="truncate text-[12px] text-text-secondary leading-tight">{a.name}</span>
              {sizeLabel && <span className="text-[10.5px] text-text-tertiary leading-tight">{sizeLabel}</span>}
            </span>
          </a>
        )
      })}
      {preview && (
        <ImageLightbox src={preview.dataUrl} alt={preview.name} onClose={() => setPreview(null)} />
      )}
    </div>
  )
}

function MessageBubbleInner({ message }: { message: ChatMessage }) {
  const confirmAction = useChatStore(s => s.confirmAction)
  const [copied, setCopied] = useState(false)
  const isUser = message.role === 'user'

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(message.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [message.content])

  return (
    <div className={`group flex gap-3 ${isUser ? 'flex-row-reverse' : ''} anim-fade-up`}>
      {!isUser && <AgentAvatar />}

      <div className={`max-w-[85%] min-w-0 ${isUser ? 'ml-auto' : ''}`}>
        {!isUser && message.process && message.process.length > 0 && (
          <ProcessTrail steps={message.process} taskId={message.taskId} />
        )}
        {message.content && (
          <div className={`relative text-[14px] leading-[1.7] ${
            isUser
              ? 'bg-accent-muted text-text-primary rounded-2xl rounded-br-md px-4 py-2.5'
              : 'text-text-secondary'
          }`}>
            {isUser ? (
              <div className="whitespace-pre-wrap break-words select-text">{message.content}</div>
            ) : (
              <div className="prose prose-sm max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 select-text">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={makeMarkdownComponents(message.taskId)}>{message.content}</ReactMarkdown>
              </div>
            )}
          </div>
        )}

        {message.attachments && message.attachments.length > 0 && (
          <MessageAttachments attachments={message.attachments} isUser={isUser} />
        )}

        {/* Copy + timestamp row */}
        {message.content && (
          <div className={`flex items-center gap-2 mt-1 ${isUser ? 'flex-row-reverse' : ''}`}>
            <button
              onClick={handleCopy}
              className="w-6 h-6 rounded-md flex items-center justify-center text-text-tertiary hover:text-text-secondary hover:bg-surface-2 transition-colors"
              title="Copy all"
            >
              {copied ? <CheckCheck size={13} className="text-success" /> : <Copy size={13} />}
            </button>
            <span className="text-[11px] text-text-tertiary">
              {new Date(message.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
        )}

        {message.pendingAction && message.pendingAction.status === 'pending' && (
          <ActionCard action={message.pendingAction} onConfirm={confirmAction} />
        )}
        {message.pendingAction && message.pendingAction.status !== 'pending' && (
          <p className="mt-1.5 text-[11px] text-text-tertiary">
            {message.pendingAction.status === 'confirmed' ? 'Confirmed' : 'Cancelled'}
          </p>
        )}
      </div>
    </div>
  )
}

// Memoized: keystrokes in the composer update ChatPanel state, which would
// otherwise re-render every bubble (each running ReactMarkdown). Message
// objects are stable references from the store, so memo skips all of them.
const MessageBubble = React.memo(MessageBubbleInner)

/* === Action Card === */

function ActionCard({ action, onConfirm }: { action: PendingAction; onConfirm: (id: string, decision: 'confirm' | 'modify' | 'cancel', mod?: string) => Promise<void> }) {
  const details = action.details || {}
  const toolName = action.toolName || String(details.kind || '')
  const d = (key: string): string => {
    const v = details[key]
    if (v == null) return ''
    return typeof v === 'string' ? v : JSON.stringify(v)
  }

  // Tool-type specific rendering
  const renderDetails = () => {
    // Email actions
    if (toolName.includes('send_email') || toolName.includes('reply_email') || toolName.includes('forward_email')) {
      return (
        <div className="mb-2.5 space-y-2 text-[13px]">
          {d('to') && <div className="flex gap-2"><span className="text-text-tertiary shrink-0 w-12">To</span><span className="text-text-primary font-medium">{d('to')}</span></div>}
          {d('cc') && <div className="flex gap-2"><span className="text-text-tertiary shrink-0 w-12">Cc</span><span className="text-text-secondary">{d('cc')}</span></div>}
          {d('subject') && <div className="flex gap-2"><span className="text-text-tertiary shrink-0 w-12">Subject</span><span className="text-text-primary">{d('subject')}</span></div>}
          {d('body') && (
            <div className="mt-2 p-3 rounded-lg bg-surface-2/60 border border-edge-subtle text-[13px] text-text-secondary leading-relaxed whitespace-pre-wrap max-h-[200px] overflow-y-auto">
              {d('body')}
            </div>
          )}
        </div>
      )
    }

    // Teams/chat actions
    if (toolName.includes('message_work_iq') || toolName.includes('teams')) {
      return (
        <div className="mb-2.5 space-y-2 text-[13px]">
          {(d('chatId') || d('channel')) && <div className="flex gap-2"><span className="text-text-tertiary shrink-0 w-12">Target</span><span className="text-text-primary font-medium">{d('channel') || d('chatId')}</span></div>}
          {d('content') && (
            <div className="mt-2 p-3 rounded-lg bg-surface-2/60 border border-edge-subtle text-[13px] text-text-secondary leading-relaxed whitespace-pre-wrap max-h-[200px] overflow-y-auto">
              {d('content')}
            </div>
          )}
        </div>
      )
    }

    // GitHub actions
    if (toolName.includes('issue_comment') || toolName.includes('pull_request_review') || toolName.includes('github')) {
      const eventVal = d('event')
      return (
        <div className="mb-2.5 space-y-2 text-[13px]">
          {d('repo') && <div className="flex gap-2"><span className="text-text-tertiary shrink-0 w-12">Repo</span><span className="text-text-primary font-mono text-[12px]">{d('repo')}</span></div>}
          {(d('issue_number') || d('pull_number')) && <div className="flex gap-2"><span className="text-text-tertiary shrink-0 w-12">Number</span><span className="text-text-primary">#{d('issue_number') || d('pull_number')}</span></div>}
          {eventVal && <div className="flex gap-2"><span className="text-text-tertiary shrink-0 w-12">Action</span><span className="text-text-primary">{eventVal === 'APPROVE' ? 'Approve' : eventVal === 'REQUEST_CHANGES' ? 'Request changes' : 'Comment'}</span></div>}
          {(d('body') || d('comment')) && (
            <div className="mt-2 p-3 rounded-lg bg-surface-2/60 border border-edge-subtle text-[13px] text-text-secondary leading-relaxed whitespace-pre-wrap max-h-[200px] overflow-y-auto">
              {d('body') || d('comment')}
            </div>
          )}
        </div>
      )
    }

    // Project/Relation management
    if (toolName.includes('manage_project') || toolName.includes('manage_relation')) {
      const entries = Object.entries(details).filter(([k]) => !['kind', 'id', 'action'].includes(k))
      const actionVal = d('action')
      return entries.length > 0 ? (
        <div className="mb-2.5 space-y-1.5 text-[13px]">
          {actionVal && <div className="flex gap-2"><span className="text-text-tertiary shrink-0 w-12">Action</span><span className="text-text-primary">{actionVal === 'create' ? 'Create' : 'Update'}</span></div>}
          {entries.map(([key, val]) => (
            <div key={key} className="flex gap-2">
              <span className="text-text-tertiary shrink-0 w-12">{key}</span>
              <span className="text-text-secondary break-all">{typeof val === 'string' ? val : JSON.stringify(val)}</span>
            </div>
          ))}
        </div>
      ) : null
    }

    // Fallback: generic key-value display (non-monospace)
    const entries = Object.entries(details).filter(([k]) => !['kind', 'id'].includes(k))
    return entries.length > 0 ? (
      <div className="mb-2.5 p-2.5 rounded-lg bg-surface-2/60 border border-edge-subtle text-[12px] text-text-tertiary space-y-1">
        {entries.map(([key, val]) => (
          <div key={key} className="flex gap-2">
            <span className="text-text-tertiary/70 shrink-0">{key}:</span>
            <span className="text-text-secondary break-all">{typeof val === 'string' ? val : JSON.stringify(val)}</span>
          </div>
        ))}
      </div>
    ) : null
  }

  // Context-aware button labels
  const confirmLabel = toolName.includes('email') || toolName.includes('forward') ? 'Confirm send'
    : toolName.includes('message') || toolName.includes('teams') ? 'Confirm send'
    : toolName.includes('review') || toolName.includes('comment') ? 'Confirm submit'
    : 'Confirm'

  return (
    <div className="mt-2.5 p-3.5 rounded-xl bg-surface-1 border border-edge">
      <p className="text-[13px] text-text-secondary mb-2.5 font-medium">{action.description}</p>
      {renderDetails()}
      <div className="flex items-center gap-2">
        <button onClick={() => onConfirm(action.id, 'confirm')} className="h-7 px-3 rounded-lg text-[12px] font-medium bg-success/12 text-success border border-success/15 hover:bg-success/18 transition-colors flex items-center gap-1.5">
          <Check size={12} /> {confirmLabel}
        </button>
        <button onClick={() => onConfirm(action.id, 'modify')} className="h-7 px-3 rounded-lg text-[12px] bg-surface-2 text-text-secondary border border-edge hover:bg-surface-3 transition-colors flex items-center gap-1.5">
          <Pencil size={11} /> Edit draft
        </button>
        <button onClick={() => onConfirm(action.id, 'cancel')} className="h-7 px-3 rounded-lg text-[12px] text-text-tertiary hover:text-danger hover:bg-danger/8 transition-colors">
          Cancel
        </button>
      </div>
    </div>
  )
}

/* === Small Components === */

function AgentAvatar() {
  return (
    <div className="w-7 h-7 rounded-lg overflow-hidden shrink-0 shadow-sm">
      <svg viewBox="0 0 512 512" className="w-full h-full">
        <defs><linearGradient id="aide-av" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse"><stop offset="0%" stopColor="#4A7FF7"/><stop offset="100%" stopColor="#3B5EE6"/></linearGradient></defs>
        <rect width="512" height="512" rx="108" fill="url(#aide-av)"/>
        <path d="M256 96 L384 416 L328 416 L298 332 L214 332 L184 416 L128 416 Z M256 192 L228 296 L284 296 Z" fill="white"/>
        <path d="M372 100 L386 132 L418 146 L386 160 L372 192 L358 160 L326 146 L358 132 Z" fill="white" opacity="0.92"/>
      </svg>
    </div>
  )
}

function TypingIndicator() {
  return (
    <div className="flex items-center gap-1 py-2">
      <span className="w-[5px] h-[5px] bg-text-tertiary rounded-full animate-bounce [animation-delay:0ms]" />
      <span className="w-[5px] h-[5px] bg-text-tertiary rounded-full animate-bounce [animation-delay:150ms]" />
      <span className="w-[5px] h-[5px] bg-text-tertiary rounded-full animate-bounce [animation-delay:300ms]" />
    </div>
  )
}

/* === Tool Calls Row (subtle, collapsible) === */

const TOOL_NAME_MAP: Record<string, string> = {
  powershell: 'PowerShell',
  shell: 'Shell',
  bash: 'Bash',
  terminal: 'Terminal',
  memory_write: 'Write memory',
  memory_search: 'Search memory',
  create_aide_task: 'Create task',
  update_aide_task: 'Update task',
  query_aide_tasks: 'Query tasks',
  query_projects: 'Query projects',
  query_relations: 'Query contacts',
  manage_project: 'Manage project',
  manage_relation: 'Manage contact',
  generate_report: 'Generate report',
  send_email_work_iq: 'Send email',
  reply_email_work_iq: 'Reply email',
  forward_email_work_iq: 'Forward email',
  send_message_work_iq: 'Send message',
  reply_message_work_iq: 'Reply message',
  search_emails_work_iq: 'Search emails',
  search_messages_work_iq: 'Search messages',
  get_calendar_work_iq: 'View calendar',
  create_issue_comment: 'Comment on Issue',
  create_pull_request_review: 'Submit review',
  list_notifications: 'View notifications',
  search_issues: 'Search issues',
}

function getToolLabel(name: string): string {
  return TOOL_NAME_MAP[name] || name.replace(/_/g, ' ')
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/* === Unified turn timeline (shared by live view + folded process trail) === */

// A normalized timeline step: narration text, or a tool call (running/done/error).
type TimelineStep =
  | { kind: 'text'; content: string }
  | { kind: 'tool'; toolName: string; status: 'running' | 'done' | 'error'; durationMs?: number; inputPreview?: string; resultPreview?: string }

// Convert the live store's steps into the shared timeline shape.
function liveStepsToTimeline(steps: LiveStep[]): TimelineStep[] {
  return steps.map(s =>
    s.kind === 'text'
      ? { kind: 'text', content: s.content }
      : {
          kind: 'tool',
          toolName: s.record.toolName,
          status: s.record.status,
          durationMs: s.record.durationMs,
          inputPreview: s.record.inputPreview,
          resultPreview: s.record.resultPreview
        }
  )
}

function ToolStepRow({ step }: { step: Extract<TimelineStep, { kind: 'tool' }> }) {
  const preview = step.inputPreview || step.resultPreview
  return (
    <div className="text-[10.5px] text-text-tertiary/80">
      <div className="flex items-center gap-1.5">
        {step.status === 'running' ? (
          <Loader2 size={9} className="animate-spin shrink-0 text-accent/70" />
        ) : step.status === 'error' ? (
          <X size={9} className="text-danger/70 shrink-0" />
        ) : (
          <Check size={9} className="text-text-tertiary/60 shrink-0" />
        )}
        <span className="truncate text-text-tertiary">{getToolLabel(step.toolName)}</span>
        {step.durationMs != null && (
          <span className="shrink-0 tabular-nums text-text-tertiary/50">{formatDuration(step.durationMs)}</span>
        )}
      </div>
      {preview && (
        <div className="ml-[15px] mt-0.5 truncate font-mono text-[10px] text-text-tertiary/55" title={preview}>
          {preview}
        </div>
      )}
    </div>
  )
}

// One rendered timeline row: narration, a single tool call, or a collapsed run
// of consecutive same-tool calls (e.g. 12 web fetches → one "Web fetch ×12" row).
type RenderItem =
  | { kind: 'text'; content: string }
  | { kind: 'tool'; step: Extract<TimelineStep, { kind: 'tool' }> }
  | { kind: 'toolGroup'; toolName: string; count: number; running: number; errors: number; totalMs: number }

// Collapse consecutive tool steps that share a tool name into a single grouped
// row. Keeps the trail compact when an agent fans out the same tool many times,
// while leaving narration and lone tool calls untouched.
function coalesceTimeline(steps: TimelineStep[]): RenderItem[] {
  const out: RenderItem[] = []
  let i = 0
  while (i < steps.length) {
    const s = steps[i]
    if (s.kind === 'text') {
      out.push({ kind: 'text', content: s.content })
      i++
      continue
    }
    const name = s.toolName
    const run: Extract<TimelineStep, { kind: 'tool' }>[] = []
    while (i < steps.length) {
      const t = steps[i]
      if (t.kind !== 'tool' || t.toolName !== name) break
      run.push(t)
      i++
    }
    if (run.length === 1) {
      out.push({ kind: 'tool', step: run[0] })
    } else {
      out.push({
        kind: 'toolGroup',
        toolName: name,
        count: run.length,
        running: run.filter(r => r.status === 'running').length,
        errors: run.filter(r => r.status === 'error').length,
        totalMs: run.reduce((a, r) => a + (r.durationMs || 0), 0)
      })
    }
  }
  return out
}

function ToolGroupRow({ item }: { item: Extract<RenderItem, { kind: 'toolGroup' }> }) {
  const status = item.running > 0 ? 'running' : item.errors > 0 ? 'error' : 'done'
  return (
    <div className="text-[10.5px] text-text-tertiary/80">
      <div className="flex items-center gap-1.5">
        {status === 'running' ? (
          <Loader2 size={9} className="animate-spin shrink-0 text-accent/70" />
        ) : status === 'error' ? (
          <X size={9} className="text-danger/70 shrink-0" />
        ) : (
          <Check size={9} className="text-text-tertiary/60 shrink-0" />
        )}
        <span className="truncate text-text-tertiary">{getToolLabel(item.toolName)}</span>
        <span className="shrink-0 px-1 rounded bg-surface-2 text-text-tertiary/70 tabular-nums">×{item.count}</span>
        {item.running > 0 && (
          <span className="shrink-0 text-text-tertiary">{item.running} running</span>
        )}
        {item.errors > 0 && (
          <span className="shrink-0 text-danger/70">{item.errors} failed</span>
        )}
        {item.totalMs > 0 && (
          <span className="shrink-0 tabular-nums text-text-tertiary/50">{formatDuration(item.totalMs)}</span>
        )}
      </div>
    </div>
  )
}

// The interleaved narration + tool timeline. Deliberately muted: this is the
// "work" trail, kept visually secondary so the final answer stands out. `live`
// adds a faint accent rail while the turn is still running. `cap` bounds the
// height and scrolls internally (the live view), so a long turn never pushes the
// whole page down — it auto-follows the newest row instead.
function Timeline({ steps, live, taskId, cap }: { steps: TimelineStep[]; live?: boolean; taskId: string | null; cap?: boolean }) {
  const items = useMemo(() => coalesceTimeline(steps), [steps])
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (cap && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [items, cap])

  const body = (
    <div className={`ml-0.5 border-l pl-2.5 space-y-1.5 ${live ? 'border-accent/20' : 'border-edge-subtle'}`}>
      {items.map((it, i) =>
        it.kind === 'text' ? (
          <div key={i} className="text-[12px] leading-[1.55] text-text-tertiary/85 prose prose-sm max-w-none [&_*]:!text-text-tertiary/85 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={makeMarkdownComponents(taskId)}>{it.content}</ReactMarkdown>
          </div>
        ) : it.kind === 'toolGroup' ? (
          <ToolGroupRow key={i} item={it} />
        ) : (
          <ToolStepRow key={i} step={it.step} />
        )
      )}
    </div>
  )

  if (cap) {
    return (
      <div ref={scrollRef} className="max-h-[260px] overflow-y-auto scrollbar-thin pr-1">
        {body}
      </div>
    )
  }
  return body
}

/* === Process Trail (folded "work" timeline on a finished reply) === */

function ProcessTrail({ steps, taskId }: { steps: TurnStep[]; taskId: string | null }) {
  const [open, setOpen] = useState(false)
  const toolCount = steps.reduce((n, s) => (s.kind === 'tool' ? n + 1 : n), 0)
  const summary = toolCount > 0
    ? `Worked through ${toolCount} step${toolCount > 1 ? 's' : ''}`
    : 'Thought it through'

  return (
    <div className="mb-1.5">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-[11px] text-text-tertiary hover:text-text-secondary transition-colors py-0.5"
      >
        <Activity size={11} />
        <span>{summary}</span>
        <ChevronRight size={10} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>

      {open && <div className="mt-1"><Timeline steps={steps as TimelineStep[]} taskId={taskId} cap /></div>}
    </div>
  )
}


/* === Empty State === */

function EmptyState({ taskTitle }: { taskTitle?: string }) {
  return (
    <div className="flex items-center justify-center min-h-[50vh]">
      <div className="text-center max-w-xs">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent/15 to-accent/5 border border-accent/10 flex items-center justify-center mx-auto mb-4">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-accent">
            <path d="M13 3L4 14h7l-1 7 9-11h-7l1-7z" fill="currentColor"/>
          </svg>
        </div>
        <p className="text-[14px] text-text-primary font-medium">
          {taskTitle ? `About “${taskTitle}”` : 'Hi there'}
        </p>
        <p className="text-[13px] text-text-tertiary mt-1 leading-relaxed">
          {taskTitle ? 'What would you like me to help with?' : 'How can I help you?'}
        </p>
      </div>
    </div>
  )
}

function PriorityBadge({ priority }: { priority: string }) {
  const styles = {
    p0: 'bg-danger/10 text-danger border-danger/15',
    p1: 'bg-warning/10 text-warning border-warning/15',
    p2: 'bg-surface-2 text-text-tertiary border-edge'
  }[priority] || 'bg-surface-2 text-text-tertiary border-edge'

  return <span className={`px-1.5 py-[1px] rounded-md text-[11px] font-medium border ${styles}`}>{priority.toUpperCase()}</span>
}

function getDueLabel(dueDate: string): string {
  const due = new Date(dueDate)
  const now = new Date()
  const diffMs = due.getTime() - now.getTime()
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays < 0) return `${Math.abs(diffDays)}d overdue`
  if (diffDays === 0) return 'Due today'
  if (diffDays === 1) return 'Due tomorrow'
  if (diffDays <= 7) return `Due in ${diffDays}d`
  return due.toLocaleDateString('en-US')
}
