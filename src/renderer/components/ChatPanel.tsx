import React, { useEffect, useRef, useState, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowUp, ChevronLeft, Check, X, Pencil, ChevronDown, ChevronRight, Paperclip, Copy, CheckCheck, Square, Wrench, Loader2 } from 'lucide-react'
import { useTaskStore } from '../stores/taskStore'
import { useChatStore } from '../stores/chatStore'
import type { ChatMessage, PendingAction, ModelInfo, ToolCallRecord } from '@shared/types'

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
  const { messages, streamingContent, isStreaming, fetchHistory, sendMessage, stopStream, modifyDraft, setModifyDraft, toolCalls } = useChatStore()
  const [input, setInput] = useState('')
  const [models, setModels] = useState<ModelInfo[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [showOtherModels, setShowOtherModels] = useState(false)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const triggeredTasksRef = useRef<Set<string>>(new Set())

  const selectedTask = selectedTaskId ? tasks.find(t => t.id === selectedTaskId) : null

  useEffect(() => { fetchHistory(selectedTaskId) }, [selectedTaskId])
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, streamingContent])
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
    Array.from(files).forEach(file => {
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
  }, [])

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
            <button onClick={() => goHome()} className="w-7 h-7 rounded-md flex items-center justify-center text-text-tertiary hover:text-text-secondary hover:bg-surface-2 transition-colors no-drag" title="返回">
              <ChevronLeft size={16} strokeWidth={2} />
            </button>
            <span className="text-[13px] font-medium text-text-secondary no-drag">Aide</span>
          </div>
          <div className="h-px bg-edge" />
        </header>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto scrollbar-thin min-h-0">
        <div className="chat-content-width mx-auto px-6 py-6 space-y-5">
          {messages.length === 0 && !isStreaming && <EmptyState taskTitle={selectedTask?.title} />}

          {messages.map(msg => <MessageBubble key={msg.id} message={msg} />)}

          {/* Agent's current turn: tool calls + streaming content together */}
          {(toolCalls.length > 0 || isStreaming) && (
            <div className="flex gap-3 anim-fade-up">
              <AgentAvatar />
              <div className="flex-1 min-w-0 pt-0.5">
                {toolCalls.length > 0 && <ToolCallsRow calls={toolCalls} />}
                {isStreaming && streamingContent ? (
                  <div className="text-[14px] leading-[1.7] text-text-secondary prose prose-sm max-w-none mt-1.5">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingContent}</ReactMarkdown>
                  </div>
                ) : isStreaming && !streamingContent && toolCalls.every(c => c.status !== 'running') ? (
                  <TypingIndicator />
                ) : null}
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input Area */}
      <div className="shrink-0">
        <div className="chat-content-width mx-auto px-6 py-3 pb-4">
          {/* Attachment preview */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {attachments.map(a => (
                <div key={a.id} className="flex items-center gap-1.5 px-2.5 py-1 bg-surface-1 border border-edge rounded-lg text-[12px] text-text-secondary">
                  {a.type.startsWith('image/') ? (
                    <img src={a.dataUrl} className="w-5 h-5 rounded object-cover" alt="" />
                  ) : (
                    <Paperclip size={12} className="text-text-tertiary" />
                  )}
                  <span className="max-w-[120px] truncate">{a.name}</span>
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
                placeholder={selectedTask ? `关于「${selectedTask.title}」…` : '给 Aide 发消息…'}
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
                  title="添加附件（预览）"
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
                    {models.find(m => m.id === selectedModel)?.name || selectedModel || '模型'}
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
                          <p className="px-3 py-2 text-[12px] text-text-tertiary">加载中…</p>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Send / Stop button */}
              {isStreaming ? (
                <button
                  onClick={stopStream}
                  className="w-8 h-8 rounded-lg flex items-center justify-center bg-danger/12 text-danger hover:bg-danger/18 transition-all shrink-0"
                  title="停止生成"
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
  task: { id: string; title: string; status: string; priority: string; description: string; source: { type: string; externalUrl?: string }; dueDate: string | null; relatedRelationIds: string[]; projectId: string | null }
  onBack: () => void
}) {
  const { completeTask, cancelTask } = useTaskStore()

  const sourceLabel: Record<string, string> = { email: '邮件', github: 'GitHub', teams: 'Teams', calendar: '日历', user: '自建', agent: 'Agent' }
  const statusLabel: Record<string, string> = { pending: '待处理', in_progress: '处理中', completed: '已完成', cancelled: '已取消' }

  return (
    <header className="shrink-0">
      <div className="flex items-center gap-2 px-5 h-[52px] drag-region">
        <button onClick={onBack} className="w-7 h-7 rounded-md flex items-center justify-center text-text-tertiary hover:text-text-secondary hover:bg-surface-2 transition-colors no-drag" title="返回">
          <ChevronLeft size={16} strokeWidth={2} />
        </button>
        <h2 className="text-[13px] font-medium text-text-primary truncate flex-1 no-drag">{task.title}</h2>
        <div className="flex items-center gap-1 shrink-0 no-drag">
          <button onClick={() => completeTask(task.id)} className="h-7 px-2.5 rounded-md text-[12px] text-text-tertiary hover:text-success hover:bg-success/8 transition-colors flex items-center gap-1">
            <Check size={13} /> 完成
          </button>
          <button onClick={() => cancelTask(task.id)} className="w-7 h-7 rounded-md flex items-center justify-center text-text-tertiary hover:text-danger hover:bg-danger/8 transition-colors">
            <X size={14} />
          </button>
        </div>
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
      </div>
      <div className="h-px bg-edge" />
    </header>
  )
}

/* === Message Bubble === */

function MessageBubble({ message }: { message: ChatMessage }) {
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
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
              </div>
            )}
          </div>
        )}

        {/* Copy + timestamp row */}
        {message.content && (
          <div className={`flex items-center gap-2 mt-1 ${isUser ? 'flex-row-reverse' : ''}`}>
            <button
              onClick={handleCopy}
              className="w-6 h-6 rounded-md flex items-center justify-center text-text-tertiary hover:text-text-secondary hover:bg-surface-2 transition-colors"
              title="复制全部"
            >
              {copied ? <CheckCheck size={13} className="text-success" /> : <Copy size={13} />}
            </button>
            <span className="text-[11px] text-text-tertiary">
              {new Date(message.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
        )}

        {message.pendingAction && message.pendingAction.status === 'pending' && (
          <ActionCard action={message.pendingAction} onConfirm={confirmAction} />
        )}
        {message.pendingAction && message.pendingAction.status !== 'pending' && (
          <p className="mt-1.5 text-[11px] text-text-tertiary">
            {message.pendingAction.status === 'confirmed' ? '已确认' : '已取消'}
          </p>
        )}
      </div>
    </div>
  )
}

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
          {d('to') && <div className="flex gap-2"><span className="text-text-tertiary shrink-0 w-12">收件人</span><span className="text-text-primary font-medium">{d('to')}</span></div>}
          {d('cc') && <div className="flex gap-2"><span className="text-text-tertiary shrink-0 w-12">抄送</span><span className="text-text-secondary">{d('cc')}</span></div>}
          {d('subject') && <div className="flex gap-2"><span className="text-text-tertiary shrink-0 w-12">主题</span><span className="text-text-primary">{d('subject')}</span></div>}
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
          {(d('chatId') || d('channel')) && <div className="flex gap-2"><span className="text-text-tertiary shrink-0 w-12">目标</span><span className="text-text-primary font-medium">{d('channel') || d('chatId')}</span></div>}
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
          {d('repo') && <div className="flex gap-2"><span className="text-text-tertiary shrink-0 w-12">仓库</span><span className="text-text-primary font-mono text-[12px]">{d('repo')}</span></div>}
          {(d('issue_number') || d('pull_number')) && <div className="flex gap-2"><span className="text-text-tertiary shrink-0 w-12">编号</span><span className="text-text-primary">#{d('issue_number') || d('pull_number')}</span></div>}
          {eventVal && <div className="flex gap-2"><span className="text-text-tertiary shrink-0 w-12">操作</span><span className="text-text-primary">{eventVal === 'APPROVE' ? '批准' : eventVal === 'REQUEST_CHANGES' ? '请求修改' : '评论'}</span></div>}
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
          {actionVal && <div className="flex gap-2"><span className="text-text-tertiary shrink-0 w-12">操作</span><span className="text-text-primary">{actionVal === 'create' ? '新建' : '更新'}</span></div>}
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
  const confirmLabel = toolName.includes('email') || toolName.includes('forward') ? '确认发送'
    : toolName.includes('message') || toolName.includes('teams') ? '确认发送'
    : toolName.includes('review') || toolName.includes('comment') ? '确认提交'
    : '确认执行'

  return (
    <div className="mt-2.5 p-3.5 rounded-xl bg-surface-1 border border-edge">
      <p className="text-[13px] text-text-secondary mb-2.5 font-medium">{action.description}</p>
      {renderDetails()}
      <div className="flex items-center gap-2">
        <button onClick={() => onConfirm(action.id, 'confirm')} className="h-7 px-3 rounded-lg text-[12px] font-medium bg-success/12 text-success border border-success/15 hover:bg-success/18 transition-colors flex items-center gap-1.5">
          <Check size={12} /> {confirmLabel}
        </button>
        <button onClick={() => onConfirm(action.id, 'modify')} className="h-7 px-3 rounded-lg text-[12px] bg-surface-2 text-text-secondary border border-edge hover:bg-surface-3 transition-colors flex items-center gap-1.5">
          <Pencil size={11} /> 编辑草稿
        </button>
        <button onClick={() => onConfirm(action.id, 'cancel')} className="h-7 px-3 rounded-lg text-[12px] text-text-tertiary hover:text-danger hover:bg-danger/8 transition-colors">
          取消发送
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
  terminal: '终端',
  memory_write: '写入记忆',
  memory_search: '搜索记忆',
  create_task: '创建任务',
  update_task: '更新任务',
  query_tasks: '查询任务',
  query_projects: '查询项目',
  query_relations: '查询联系人',
  manage_project: '管理项目',
  manage_relation: '管理联系人',
  generate_report: '生成报告',
  send_email_work_iq: '发送邮件',
  reply_email_work_iq: '回复邮件',
  forward_email_work_iq: '转发邮件',
  send_message_work_iq: '发送消息',
  reply_message_work_iq: '回复消息',
  search_emails_work_iq: '搜索邮件',
  search_messages_work_iq: '搜索消息',
  get_calendar_work_iq: '查看日历',
  create_issue_comment: '评论 Issue',
  create_pull_request_review: '提交 Review',
  list_notifications: '查看通知',
  search_issues: '搜索 Issue',
}

function getToolLabel(name: string): string {
  return TOOL_NAME_MAP[name] || name.replace(/_/g, ' ')
}

function ToolCallsRow({ calls }: { calls: ToolCallRecord[] }) {
  const [expanded, setExpanded] = useState(false)
  const running = calls.filter(c => c.status === 'running')
  const latest = running[running.length - 1] || calls[calls.length - 1]
  const latestPreview = latest?.inputPreview
  const label = running.length > 0
    ? `${getToolLabel(latest.toolName)}${latestPreview ? ` · ${latestPreview}` : '…'}`
    : `${calls.length} 次工具调用${latestPreview ? ` · ${latestPreview}` : ''}`

  return (
    <div className="my-0.5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 text-[11px] text-text-tertiary hover:text-text-secondary transition-colors py-0.5"
      >
        {running.length > 0 ? (
          <Loader2 size={11} className="animate-spin" />
        ) : (
          <Wrench size={11} />
        )}
        <span className="truncate text-left">{label}</span>
        <ChevronRight size={10} className={`transition-transform ${expanded ? 'rotate-90' : ''}`} />
      </button>

      {expanded && (
        <div className="mt-1 ml-0.5 border-l border-edge-subtle pl-2.5 space-y-1.5">
          {calls.map(c => (
            <div key={c.id} className="text-[11px] text-text-tertiary">
              <div className="flex items-center gap-2">
                {c.status === 'running' ? (
                  <Loader2 size={10} className="animate-spin shrink-0" />
                ) : c.status === 'error' ? (
                  <X size={10} className="text-danger shrink-0" />
                ) : (
                  <Check size={10} className="text-success shrink-0" />
                )}
                <span className="truncate text-text-secondary">{getToolLabel(c.toolName)}</span>
                {c.durationMs != null && <span className="shrink-0 tabular-nums">{c.durationMs < 1000 ? `${c.durationMs}ms` : `${(c.durationMs / 1000).toFixed(1)}s`}</span>}
              </div>
              {(c.inputPreview || c.resultPreview) && (
                <div className="ml-[18px] mt-0.5 truncate font-mono text-[10.5px] text-text-tertiary/80" title={c.inputPreview || c.resultPreview}>
                  {c.inputPreview || c.resultPreview}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
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
          {taskTitle ? `关于「${taskTitle}」` : '你好'}
        </p>
        <p className="text-[13px] text-text-tertiary mt-1 leading-relaxed">
          {taskTitle ? '有什么需要帮你处理？' : '有什么可以帮你的？'}
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

  if (diffDays < 0) return `已逾期 ${Math.abs(diffDays)} 天`
  if (diffDays === 0) return '今天截止'
  if (diffDays === 1) return '明天截止'
  if (diffDays <= 7) return `${diffDays} 天后截止`
  return due.toLocaleDateString('zh-CN')
}
