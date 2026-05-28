import React, { useState, useEffect, useCallback } from 'react'
import { Sparkles, Github, Shield, Check, ArrowRight, ArrowLeft, Copy, Loader2 } from 'lucide-react'
import type { ConnectionStatus } from '@shared/types'

type Step = 'welcome' | 'github' | 'microsoft' | 'done'

interface Props {
  onComplete: () => void
}

export function OnboardingWizard({ onComplete }: Props) {
  const [step, setStep] = useState<Step>('welcome')
  const [connections, setConnections] = useState<ConnectionStatus[]>([])

  useEffect(() => {
    window.aide.connections.getStatus().then(setConnections)
  }, [])

  const isConnected = (type: string) => connections.find(c => c.type === type)?.authenticated ?? false

  const refreshConnections = useCallback(async () => {
    const status = await window.aide.connections.getStatus()
    setConnections(status)
  }, [])

  const finish = useCallback(async () => {
    await window.aide.preferences.set({ onboardingComplete: true })
    onComplete()
  }, [onComplete])

  const STEPS: Step[] = ['welcome', 'github', 'microsoft', 'done']
  const goBack = useCallback(() => {
    const idx = STEPS.indexOf(step)
    if (idx > 0) setStep(STEPS[idx - 1])
  }, [step])

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-surface-0">
      {/* Drag region for frameless window */}
      <div className="absolute top-0 left-0 right-0 h-[52px] drag-region" />

      <div className="w-full max-w-[480px] px-6">
        {/* Back button */}
        {step !== 'welcome' && (
          <button
            onClick={goBack}
            className="absolute top-6 left-6 flex items-center gap-1.5 text-[13px] text-text-tertiary hover:text-text-secondary transition-colors no-drag"
          >
            <ArrowLeft size={14} /> 返回
          </button>
        )}

        {step === 'welcome' && <WelcomeStep onNext={() => setStep('github')} />}
        {step === 'github' && (
          <GitHubStep
            connected={isConnected('github')}
            onRefresh={refreshConnections}
            onNext={() => setStep('microsoft')}
            onSkip={() => setStep('microsoft')}
          />
        )}
        {step === 'microsoft' && (
          <MicrosoftStep
            connected={isConnected('workiq')}
            onRefresh={refreshConnections}
            onNext={() => setStep('done')}
            onSkip={() => setStep('done')}
          />
        )}
        {step === 'done' && <DoneStep onFinish={finish} />}

        {/* Progress dots */}
        <div className="flex justify-center gap-2 mt-8">
          {(['welcome', 'github', 'microsoft', 'done'] as Step[]).map(s => (
            <div
              key={s}
              className={`w-2 h-2 rounded-full transition-colors ${
                s === step ? 'bg-accent' : 'bg-surface-2'
              }`}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

// === Welcome ===

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <div className="text-center">
      <div className="w-16 h-16 rounded-2xl bg-accent/10 flex items-center justify-center mx-auto mb-6">
        <Sparkles size={32} className="text-accent" />
      </div>
      <h1 className="text-[22px] font-bold text-text-primary mb-3">欢迎使用 Aide</h1>
      <p className="text-[14px] text-text-secondary leading-relaxed mb-8">
        帮你看清工作全貌、持续积累工作上下文、<br />
        辅助你处理散落在邮件、Teams、GitHub 中的任务。
      </p>
      <button
        onClick={onNext}
        className="inline-flex items-center gap-2 px-6 py-2.5 bg-accent text-white text-[14px] font-medium rounded-xl hover:bg-accent/90 transition-colors"
      >
        开始设置 <ArrowRight size={16} />
      </button>
      <p className="text-[12px] text-text-tertiary mt-4">大约 1 分钟完成</p>
    </div>
  )
}

// === GitHub (via gh CLI) ===

function GitHubStep({ connected, onRefresh, onNext, onSkip }: {
  connected: boolean
  onRefresh: () => Promise<void>
  onNext: () => void
  onSkip: () => void
}) {
  const [status, setStatus] = useState<'idle' | 'waiting' | 'success' | 'error'>('idle')
  const [userCode, setUserCode] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (connected) setStatus('success')
  }, [connected])

  // Listen for auth-progress and connection:status events
  useEffect(() => {
    if (status !== 'waiting') return
    const unsub = window.aideEvents.on((event) => {
      if (event.type === 'connection:auth-progress' && event.connectionType === 'github') {
        setUserCode(event.userCode)
        navigator.clipboard.writeText(event.userCode).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 3000)
        })
      }
      if (event.type === 'connection:status') {
        const gh = event.connections.find(c => c.type === 'github')
        if (gh?.authenticated) {
          setStatus('success')
          onRefresh()
        }
      }
    })
    return unsub
  }, [status, onRefresh])

  const startAuth = useCallback(async () => {
    setStatus('waiting')
    setUserCode(null)
    try {
      await window.aide.connections.authenticateGitHub()
      setStatus('success')
      await onRefresh()
    } catch {
      setStatus('error')
    }
  }, [onRefresh])

  const copyCode = useCallback(() => {
    if (userCode) {
      navigator.clipboard.writeText(userCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }, [userCode])

  return (
    <div className="text-center">
      <div className="w-14 h-14 rounded-2xl bg-zinc-800 flex items-center justify-center mx-auto mb-5">
        <Github size={28} className="text-white" />
      </div>
      <h2 className="text-[18px] font-bold text-text-primary mb-2">连接 GitHub</h2>
      <p className="text-[13px] text-text-secondary mb-6">
        追踪 Issue、PR 通知，让 Aide 知道你的代码工作动态。
      </p>

      {status === 'idle' && (
        <div className="space-y-3">
          <button
            onClick={startAuth}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-zinc-800 text-white text-[13px] font-medium rounded-xl hover:bg-zinc-700 transition-colors"
          >
            <Github size={16} /> 连接 GitHub
          </button>
          <p className="text-[11px] text-text-tertiary">
            浏览器将打开 GitHub 授权页面
          </p>
        </div>
      )}

      {status === 'waiting' && (
        <div className="space-y-4">
          {userCode ? (
            <>
              <p className="text-[13px] text-text-secondary">在浏览器中输入以下验证码：</p>
              <div className="flex items-center justify-center gap-3">
                <code className="text-[24px] font-mono font-bold text-text-primary tracking-[0.15em] bg-surface-1 px-5 py-2.5 rounded-xl border border-edge">
                  {userCode}
                </code>
                <button
                  onClick={copyCode}
                  className="w-9 h-9 rounded-lg flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-surface-1 transition-colors"
                  title="复制"
                >
                  {copied ? <Check size={16} className="text-success" /> : <Copy size={16} />}
                </button>
              </div>
              <p className="text-[11px] text-text-tertiary">
                {copied ? '✓ 已复制到剪贴板' : '验证码已自动复制到剪贴板'}
              </p>
            </>
          ) : (
            <p className="text-[13px] text-text-tertiary">正在启动认证…</p>
          )}
          <div className="flex items-center justify-center gap-2 text-[12px] text-text-tertiary">
            <Loader2 size={14} className="animate-spin" /> 等待授权完成…
          </div>
        </div>
      )}

      {status === 'success' && (
        <div className="space-y-4">
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-success/10 text-success rounded-xl text-[13px] font-medium">
            <Check size={16} /> GitHub 已连接
          </div>
          <div>
            <button
              onClick={onNext}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-accent text-white text-[13px] font-medium rounded-xl hover:bg-accent/90 transition-colors"
            >
              继续 <ArrowRight size={16} />
            </button>
          </div>
        </div>
      )}

      {status === 'error' && (
        <div className="space-y-3">
          <p className="text-[12px] text-danger">连接失败，请确保已安装 gh CLI。</p>
          <button
            onClick={() => { setStatus('idle'); setUserCode(null) }}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-zinc-800 text-white text-[13px] font-medium rounded-xl hover:bg-zinc-700 transition-colors"
          >
            <Github size={16} /> 重试
          </button>
        </div>
      )}

      {status !== 'success' && (
        <button onClick={onSkip} className="block mx-auto mt-5 text-[12px] text-text-tertiary hover:text-text-secondary transition-colors">
          稍后再说
        </button>
      )}
    </div>
  )
}

// === Microsoft 365 (via workiq CLI) ===

function MicrosoftStep({ connected, onRefresh, onNext, onSkip }: {
  connected: boolean
  onRefresh: () => Promise<void>
  onNext: () => void
  onSkip: () => void
}) {
  const [status, setStatus] = useState<'idle' | 'waiting' | 'success' | 'error'>('idle')
  const [userCode, setUserCode] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (connected) setStatus('success')
  }, [connected])

  // Listen for auth-progress and connection:status events
  useEffect(() => {
    if (status !== 'waiting') return
    const unsub = window.aideEvents.on((event) => {
      if (event.type === 'connection:auth-progress' && event.connectionType === 'workiq') {
        setUserCode(event.userCode)
        navigator.clipboard.writeText(event.userCode).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 3000)
        })
      }
      if (event.type === 'connection:status') {
        const ms = event.connections.find(c => c.type === 'workiq')
        if (ms?.authenticated) {
          setStatus(ms.verified ? 'success' : 'success')
          onRefresh()
        }
      }
    })
    return unsub
  }, [status, onRefresh])

  const startAuth = useCallback(async () => {
    setStatus('waiting')
    setUserCode(null)
    try {
      await window.aide.connections.authenticateMicrosoft()
      setStatus('success')
      await onRefresh()
    } catch {
      setStatus('error')
    }
  }, [onRefresh])

  const copyCode = useCallback(() => {
    if (userCode) {
      navigator.clipboard.writeText(userCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }, [userCode])

  return (
    <div className="text-center">
      <div className="w-14 h-14 rounded-2xl bg-blue-500/10 flex items-center justify-center mx-auto mb-5">
        <Shield size={28} className="text-blue-400" />
      </div>
      <h2 className="text-[18px] font-bold text-text-primary mb-2">连接 Microsoft 365</h2>
      <p className="text-[13px] text-text-secondary mb-6">
        读取邮件、日历和 Teams 消息，让 Aide 理解你的日程。
      </p>

      {status === 'idle' && (
        <div className="space-y-3">
          <button
            onClick={startAuth}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-500 text-white text-[13px] font-medium rounded-xl hover:bg-blue-600 transition-colors"
          >
            <Shield size={16} /> 使用 Microsoft 账号登录
          </button>
          <p className="text-[11px] text-text-tertiary">
            浏览器将打开 Microsoft 登录页面
          </p>
        </div>
      )}

      {status === 'waiting' && (
        <div className="space-y-4">
          {userCode ? (
            <>
              <p className="text-[13px] text-text-secondary">在浏览器中输入以下代码：</p>
              <div className="flex items-center justify-center gap-3">
                <code className="text-[24px] font-mono font-bold text-text-primary tracking-[0.15em] bg-surface-1 px-5 py-2.5 rounded-xl border border-edge">
                  {userCode}
                </code>
                <button
                  onClick={copyCode}
                  className="w-9 h-9 rounded-lg flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-surface-1 transition-colors"
                  title="复制"
                >
                  {copied ? <Check size={16} className="text-success" /> : <Copy size={16} />}
                </button>
              </div>
              <p className="text-[11px] text-text-tertiary">
                {copied ? '✓ 已复制到剪贴板' : '验证码已自动复制到剪贴板'}
              </p>
            </>
          ) : (
            <p className="text-[13px] text-text-tertiary">正在启动认证…</p>
          )}
          <div className="flex items-center justify-center gap-2 text-[12px] text-text-tertiary">
            <Loader2 size={14} className="animate-spin" /> 等待授权完成…
          </div>
        </div>
      )}

      {status === 'success' && (
        <div className="space-y-4">
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-success/10 text-success rounded-xl text-[13px] font-medium">
            <Check size={16} /> Microsoft 365 已连接
          </div>
          <div>
            <button
              onClick={onNext}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-accent text-white text-[13px] font-medium rounded-xl hover:bg-accent/90 transition-colors"
            >
              继续 <ArrowRight size={16} />
            </button>
          </div>
        </div>
      )}

      {status === 'error' && (
        <div className="space-y-3">
          <p className="text-[12px] text-danger">连接失败，请重试。</p>
          <button
            onClick={() => { setStatus('idle'); setUserCode(null) }}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-500 text-white text-[13px] font-medium rounded-xl hover:bg-blue-600 transition-colors"
          >
            重试
          </button>
        </div>
      )}

      {status !== 'success' && (
        <button onClick={onSkip} className="block mx-auto mt-5 text-[12px] text-text-tertiary hover:text-text-secondary transition-colors">
          稍后再说
        </button>
      )}
    </div>
  )
}

// === Done ===

function DoneStep({ onFinish }: { onFinish: () => void }) {
  return (
    <div className="text-center">
      <div className="w-16 h-16 rounded-2xl bg-success/10 flex items-center justify-center mx-auto mb-6">
        <Check size={32} className="text-success" />
      </div>
      <h2 className="text-[20px] font-bold text-text-primary mb-3">设置完成</h2>
      <p className="text-[14px] text-text-secondary leading-relaxed mb-8">
        Aide 已准备就绪。你随时可以在设置中修改连接配置。
      </p>
      <button
        onClick={onFinish}
        className="inline-flex items-center gap-2 px-6 py-2.5 bg-accent text-white text-[14px] font-medium rounded-xl hover:bg-accent/90 transition-colors"
      >
        开始使用 Aide <Sparkles size={16} />
      </button>
    </div>
  )
}
