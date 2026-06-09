import React, { useState, useEffect, useCallback } from 'react'
import { Sparkles, Github, Shield, Check, ArrowRight, ArrowLeft, Copy, Loader2, Send } from 'lucide-react'
import { ChannelPicker } from '../channels/registry'
import { MicrosoftLogo } from '../brand/icons'
import type { ConnectionStatus, AideEvent } from '@shared/types'

type Step = 'welcome' | 'sources' | 'channels' | 'done'
const STEPS: Step[] = ['welcome', 'sources', 'channels', 'done']

interface Props {
  onComplete: () => void
}

export function OnboardingWizard({ onComplete }: Props) {
  const [step, setStep] = useState<Step>('welcome')
  const [connections, setConnections] = useState<ConnectionStatus[]>([])
  const [cliStatus, setCliStatus] = useState<{ gh: boolean; npx: boolean }>({ gh: true, npx: true })

  useEffect(() => {
    window.aide.connections.getStatus().then(setConnections)
    window.aide.connections.checkCli().then(setCliStatus)
    // Keep in sync as the real MCP servers settle connection state in the background.
    const unsub = window.aideEvents.on((event) => {
      if (event.type === 'connection:status') {
        window.aide.connections.getStatus().then(setConnections)
      }
    })
    return unsub
  }, [])

  const isVerified = (type: string) => connections.find(c => c.type === type)?.verified ?? false

  const refreshConnections = useCallback(async () => {
    setConnections(await window.aide.connections.getStatus())
  }, [])

  const finish = useCallback(async () => {
    await window.aide.preferences.set({ onboardingComplete: true })
    // Trigger world-sync immediately to bootstrap relations & projects
    window.aide.jobs.run('world-sync').catch(() => {})
    onComplete()
  }, [onComplete])

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
            <ArrowLeft size={14} /> Back
          </button>
        )}

        {step === 'welcome' && <WelcomeStep onNext={() => setStep('sources')} />}
        {step === 'sources' && (
          <SourcesStep
            connections={connections}
            ghInstalled={cliStatus.gh}
            onRefresh={refreshConnections}
            onNext={() => setStep('channels')}
          />
        )}
        {step === 'channels' && (
          <ChannelsStep
            onNext={() => setStep('done')}
            onSkip={() => setStep('done')}
          />
        )}
        {step === 'done' && <DoneStep onFinish={finish} anyVerified={isVerified('github') || isVerified('workiq')} />}

        {/* Progress dots */}
        <div className="flex justify-center gap-2 mt-8">
          {STEPS.map(s => (
            <div
              key={s}
              className={`w-2 h-2 rounded-full transition-colors ${s === step ? 'bg-accent' : 'bg-surface-2'}`}
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
    <div className="text-center anim-fade-up">
      <div className="w-16 h-16 rounded-2xl overflow-hidden mx-auto mb-6 shadow-md">
        <svg viewBox="0 0 512 512" className="w-full h-full">
          <defs><linearGradient id="aide-ob" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse"><stop offset="0%" stopColor="#4A7FF7"/><stop offset="100%" stopColor="#3B5EE6"/></linearGradient></defs>
          <rect width="512" height="512" rx="108" fill="url(#aide-ob)"/>
          <path d="M256 96 L384 416 L328 416 L298 332 L214 332 L184 416 L128 416 Z M256 192 L228 296 L284 296 Z" fill="white"/>
          <path d="M372 100 L386 132 L418 146 L386 160 L372 192 L358 160 L326 146 L358 132 Z" fill="white" opacity="0.92"/>
        </svg>
      </div>
      <h1 className="text-[22px] font-bold text-text-primary mb-3">Welcome to Aide</h1>
      <p className="text-[14px] text-text-secondary leading-relaxed mb-8">
        See the full picture of your work and get help with<br />
        tasks scattered across everything you work with.
      </p>
      <button
        onClick={onNext}
        className="inline-flex items-center gap-2 px-6 py-2.5 bg-accent text-white text-[14px] font-medium rounded-xl hover:bg-accent/90 transition-colors"
      >
        Get started <ArrowRight size={16} />
      </button>
      <p className="text-[12px] text-text-tertiary mt-4">Takes about 1 minute</p>
    </div>
  )
}

// === Sources (connect everything) ===

interface SourceDef {
  type: 'github' | 'workiq'
  name: string
  description: string
  icon: React.ReactNode
  accentClass: string
  authenticate: () => Promise<void>
}

const SOURCES: SourceDef[] = [
  {
    type: 'github',
    name: 'GitHub',
    description: 'Issues, pull requests, and repos',
    icon: <Github size={18} className="text-white" />,
    accentClass: 'bg-zinc-800 text-white',
    authenticate: () => window.aide.connections.authenticateGitHub(),
  },
  {
    type: 'workiq',
    name: 'Microsoft 365',
    description: 'Email, calendar, Teams, and OneDrive',
    icon: <MicrosoftLogo size={18} />,
    accentClass: 'bg-blue-500/10',
    authenticate: () => window.aide.connections.authenticateMicrosoft(),
  },
]

function SourcesStep({ connections, ghInstalled, onRefresh, onNext }: {
  connections: ConnectionStatus[]
  ghInstalled: boolean
  onRefresh: () => Promise<void>
  onNext: () => void
}) {
  const connectedCount = SOURCES.filter(s => connections.find(c => c.type === s.type)?.authenticated).length

  return (
    <div className="text-center anim-fade-up">
      <div className="w-14 h-14 rounded-2xl bg-accent/10 flex items-center justify-center mx-auto mb-5">
        <Sparkles size={26} className="text-accent" />
      </div>
      <h2 className="text-[18px] font-bold text-text-primary mb-2">Connect your work</h2>
      <p className="text-[13px] text-text-secondary mb-6">
        The more Aide can see, the more it can help. Connect everything you work with.
      </p>

      <div className="space-y-3 text-left">
        {SOURCES.map(source => (
          <SourceCard
            key={source.type}
            source={source}
            connection={connections.find(c => c.type === source.type) ?? null}
            ghInstalled={ghInstalled}
            onRefresh={onRefresh}
          />
        ))}
      </div>

      <button
        onClick={onNext}
        className="inline-flex items-center gap-2 px-6 py-2.5 mt-6 bg-accent text-white text-[13px] font-medium rounded-xl hover:bg-accent/90 transition-colors"
      >
        Continue <ArrowRight size={16} />
      </button>
      <p className="mt-4 text-[12px] text-text-tertiary">
        {connectedCount === SOURCES.length
          ? 'All sources connected — nice.'
          : connectedCount > 0
          ? 'You can connect the rest now or anytime in Settings.'
          : 'You can also do this later in Settings.'}
      </p>
    </div>
  )
}

function SourceCard({ source, connection, ghInstalled, onRefresh }: {
  source: SourceDef
  connection: ConnectionStatus | null
  ghInstalled: boolean
  onRefresh: () => Promise<void>
}) {
  const [phase, setPhase] = useState<'idle' | 'waiting' | 'error'>('idle')
  const [userCode, setUserCode] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const connected = connection?.authenticated ?? false
  const verified = connection?.verified ?? false
  const activeAccount = connection?.activeAccount ?? null
  const noCli = source.type === 'github' && !ghInstalled

  // While waiting, capture the device code and watch for the connection to settle.
  useEffect(() => {
    if (phase !== 'waiting') return
    const unsub = window.aideEvents.on((event: AideEvent) => {
      if (event.type === 'connection:auth-progress' && event.connectionType === source.type) {
        setUserCode(event.userCode)
        navigator.clipboard.writeText(event.userCode).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 3000)
        }).catch(() => {})
      }
      if (event.type === 'connection:status') {
        const c = event.connections.find(x => x.type === source.type)
        if (c?.authenticated) {
          setPhase('idle')
          setUserCode(null)
          onRefresh()
        }
      }
    })
    return unsub
  }, [phase, source.type, onRefresh])

  const startAuth = useCallback(async () => {
    setPhase('waiting')
    setUserCode(null)
    try {
      await source.authenticate()
      await onRefresh()
      setPhase('idle')
    } catch {
      setPhase('error')
    }
  }, [source, onRefresh])

  const copyCode = useCallback(() => {
    if (!userCode) return
    navigator.clipboard.writeText(userCode).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [userCode])

  const statusLabel = connected
    ? verified
      ? `Connected${activeAccount ? ` · ${activeAccount}` : ''}`
      : 'Signed in · verifying permissions'
    : phase === 'waiting'
    ? 'Waiting for authorization…'
    : noCli
    ? 'GitHub CLI required'
    : 'Recommended'

  const statusColor = connected
    ? verified ? 'text-success' : 'text-warning'
    : noCli ? 'text-danger' : 'text-accent'

  const dotColor = connected
    ? verified ? 'bg-success' : 'bg-warning'
    : noCli ? 'bg-danger' : 'bg-accent'

  return (
    <div
      className={`p-4 rounded-xl border transition-all duration-300 ${
        connected
          ? verified ? 'bg-success/[0.04] border-success/25' : 'bg-warning/[0.04] border-warning/25'
          : 'bg-surface-0 border-edge'
      }`}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-3">
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${source.accentClass}`}>
            {source.icon}
          </div>
          <div>
            <p className="text-[13px] font-medium text-text-primary">{source.name}</p>
            <p className="text-[12px] text-text-tertiary mt-0.5">{source.description}</p>
            <div className="flex items-center gap-1.5 mt-1.5">
              <div className={`w-[6px] h-[6px] rounded-full ${dotColor}`} />
              <span className={`text-[11px] ${statusColor}`}>{statusLabel}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {connected ? (
            <span className="inline-flex items-center gap-1 text-[12px] font-medium text-success">
              {verified ? <Check size={15} /> : <Shield size={14} />}
            </span>
          ) : noCli ? null : phase === 'waiting' ? (
            <span className="inline-flex items-center gap-1.5 text-[12px] text-text-tertiary">
              <Loader2 size={13} className="animate-spin" />
            </span>
          ) : (
            <button
              onClick={startAuth}
              className="h-7 px-3 rounded-lg text-[12px] font-medium inline-flex items-center gap-1.5 transition-colors bg-accent text-white hover:bg-accent/90"
            >
              {phase === 'error' ? 'Retry' : 'Connect'}
            </button>
          )}
        </div>
      </div>

      {/* Device code */}
      {phase === 'waiting' && userCode && (
        <div className="mt-3 flex items-center justify-between gap-3 p-3 rounded-lg bg-surface-2 border border-edge anim-fade-up">
          <div className="text-left">
            <p className="text-[11px] text-text-tertiary mb-1">Enter this code in your browser:</p>
            <code className="text-[18px] font-mono font-bold text-text-primary tracking-[0.12em]">{userCode}</code>
          </div>
          <button
            onClick={copyCode}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-text-tertiary hover:text-text-primary hover:bg-surface-1 transition-colors shrink-0"
            title="Copy"
          >
            {copied ? <Check size={15} className="text-success" /> : <Copy size={15} />}
          </button>
        </div>
      )}

      {/* Partial — signed in, permissions not verified */}
      {connected && !verified && (
        <p className="mt-3 text-[11px] text-text-tertiary">
          Signed in, but Aide can't sync your data automatically yet. You can keep going and retry later in Settings.
        </p>
      )}

      {/* Error */}
      {phase === 'error' && !connected && (
        <p className="mt-3 text-[11px] text-danger">Connection failed. Please try again.</p>
      )}

      {/* GitHub CLI missing */}
      {noCli && !connected && (
        <div className="mt-3 p-3 rounded-lg bg-surface-2 border border-edge text-left">
          <p className="text-[12px] text-text-secondary leading-relaxed mb-2">
            Aide connects to GitHub through the <code className="text-[11px] bg-surface-1 px-1 py-0.5 rounded">gh</code> command-line tool. Install it first:
          </p>
          <div className="space-y-1 text-[11px] text-text-secondary">
            <p>• Windows: <code className="bg-surface-1 px-1 py-0.5 rounded text-[11px]">winget install GitHub.cli</code></p>
            <p>• macOS: <code className="bg-surface-1 px-1 py-0.5 rounded text-[11px]">brew install gh</code></p>
            <p>• Or visit <a href="https://cli.github.com" className="text-accent hover:underline" onClick={e => { e.preventDefault(); window.open('https://cli.github.com') }}>cli.github.com</a></p>
          </div>
          <p className="mt-2 text-[11px] text-text-tertiary">Restart Aide after installing to connect.</p>
        </div>
      )}
    </div>
  )
}

// === Channels (pick one you check most) ===

function ChannelsStep({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  return (
    <div className="text-center anim-fade-up">
      <div className="w-14 h-14 rounded-2xl bg-accent/10 flex items-center justify-center mx-auto mb-5">
        <Send size={26} className="text-accent" />
      </div>
      <h2 className="text-[18px] font-bold text-text-primary mb-2">Stay in the loop</h2>
      <p className="text-[13px] text-text-secondary mb-6">
        Pick the one you check most — that's where Aide will reach you with briefings and take your commands.
      </p>

      <ChannelPicker />

      <button
        onClick={onNext}
        className="inline-flex items-center gap-2 px-6 py-2.5 mt-6 bg-accent text-white text-[13px] font-medium rounded-xl hover:bg-accent/90 transition-colors"
      >
        Continue <ArrowRight size={16} />
      </button>
      <button onClick={onSkip} className="block mx-auto mt-4 text-[12px] text-text-tertiary hover:text-text-secondary transition-colors">
        Skip for now
      </button>
    </div>
  )
}

// === Done ===

function DoneStep({ onFinish, anyVerified }: { onFinish: () => void; anyVerified: boolean }) {
  return (
    <div className="text-center anim-fade-up">
      <div className="w-16 h-16 rounded-2xl bg-success/10 flex items-center justify-center mx-auto mb-6">
        <Check size={32} className="text-success" />
      </div>
      <h2 className="text-[20px] font-bold text-text-primary mb-3">Setup complete</h2>
      <p className="text-[14px] text-text-secondary leading-relaxed mb-8">
        {anyVerified
          ? 'Aide is ready. You can change connections anytime in Settings.'
          : 'Basic setup is done. You can add or retry connections later in Settings.'}
      </p>
      <button
        onClick={onFinish}
        className="inline-flex items-center gap-2 px-6 py-2.5 bg-accent text-white text-[14px] font-medium rounded-xl hover:bg-accent/90 transition-colors"
      >
        Start using Aide <Sparkles size={16} />
      </button>
    </div>
  )
}
