import React, { useEffect, useRef, useState, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import { ArrowUp, ChevronLeft, Check, X, Pencil, ChevronDown, Paperclip, Copy, CheckCheck, Square } from 'lucide-react'
import { useTaskStore } from '../stores/taskStore'
import { useChatStore } from '../stores/chatStore'
import type { ChatMessage, PendingAction, ModelInfo } from '@shared/types'

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
  const { messages, streamingContent, isStreaming, fetchHistory, sendMessage, stopStream, modifyDraft, setModifyDraft } = useChatStore()
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
    window.aide.models.list().then(setModels)
    window.aide.models.getSelected().then(setSelectedModel)
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

          {isStreaming && (
            <div className="flex gap-3 anim-fade-up">
              <AgentAvatar />
              <div className="flex-1 min-w-0 pt-0.5">
                {streamingContent ? (
                  <div className="text-[14px] leading-[1.7] text-text-secondary prose prose-sm max-w-none">
                    <ReactMarkdown>{streamingContent}</ReactMarkdown>
                  </div>
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
                          const featured = ['claude-opus-4.6', 'claude-opus-4.7', 'gpt-5.5', 'gpt-5.4']
                          const featuredModels = models.filter(m => featured.includes(m.id))
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
  task: { id: string; title: string; status: string; priority: string; description: string; source: { type: string; externalUrl?: string }; dueDate: string | null; relatedRelationIds: string[] }
  onBack: () => void
}) {
  const { completeTask, cancelTask } = useTaskStore()

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
        <span>{task.source.type}</span>
        {task.source.externalUrl && (
          <a href={task.source.externalUrl} className="text-accent hover:underline" target="_blank" rel="noopener">↗</a>
        )}
        {task.dueDate && (
          <>
            <span className="text-edge">·</span>
            <span className={new Date(task.dueDate) < new Date() ? 'text-danger' : ''}>
              {new Date(task.dueDate).toLocaleDateString('zh-CN')}
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
              <div className="whitespace-pre-wrap break-words">{message.content}</div>
            ) : (
              <div className="prose prose-sm max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                <ReactMarkdown>{message.content}</ReactMarkdown>
              </div>
            )}
          </div>
        )}

        {/* Copy + timestamp row */}
        {message.content && (
          <div className={`flex items-center gap-2 mt-1 ${isUser ? 'flex-row-reverse' : ''}`}>
            <button
              onClick={handleCopy}
              className="opacity-0 group-hover:opacity-100 w-6 h-6 rounded-md flex items-center justify-center text-text-tertiary hover:text-text-secondary hover:bg-surface-2 transition-all"
              title="复制"
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
  const detailEntries = Object.entries(details).filter(([k]) => !['kind', 'id'].includes(k))

  return (
    <div className="mt-2.5 p-3 rounded-xl bg-surface-1 border border-edge">
      <p className="text-[13px] text-text-secondary mb-1.5">{action.description}</p>
      {detailEntries.length > 0 && (
        <div className="mb-2.5 p-2 rounded-lg bg-surface-2/60 border border-edge-subtle text-[12px] text-text-tertiary space-y-0.5 font-mono">
          {detailEntries.map(([key, val]) => (
            <div key={key} className="flex gap-2">
              <span className="text-text-tertiary/70 shrink-0">{key}:</span>
              <span className="text-text-secondary break-all">{typeof val === 'string' ? val : JSON.stringify(val)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <button onClick={() => onConfirm(action.id, 'confirm')} className="h-7 px-3 rounded-lg text-[12px] font-medium bg-success/12 text-success border border-success/15 hover:bg-success/18 transition-colors flex items-center gap-1.5">
          <Check size={12} /> 确认
        </button>
        <button onClick={() => onConfirm(action.id, 'modify')} className="h-7 px-3 rounded-lg text-[12px] bg-surface-2 text-text-secondary border border-edge hover:bg-surface-3 transition-colors flex items-center gap-1.5">
          <Pencil size={11} /> 修改
        </button>
        <button onClick={() => onConfirm(action.id, 'cancel')} className="h-7 px-3 rounded-lg text-[12px] text-text-tertiary hover:text-danger hover:bg-danger/8 transition-colors">
          取消
        </button>
      </div>
    </div>
  )
}

/* === Small Components === */

function AgentAvatar() {
  return (
    <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-accent/20 to-accent/10 flex items-center justify-center shrink-0 border border-accent/15">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-accent">
        <path d="M13 3L4 14h7l-1 7 9-11h-7l1-7z" fill="currentColor"/>
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
    high: 'bg-danger/10 text-danger border-danger/15',
    medium: 'bg-warning/10 text-warning border-warning/15',
    low: 'bg-surface-2 text-text-tertiary border-edge'
  }[priority] || 'bg-surface-2 text-text-tertiary border-edge'

  return <span className={`px-1.5 py-[1px] rounded-md text-[11px] font-medium border ${styles}`}>{priority}</span>
}
