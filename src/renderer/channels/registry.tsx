// Channel registry — the single source of truth for delivery channels.
//
// A "channel" is a way Aide reaches the user and takes commands on the go
// (WeChat / WhatsApp / Telegram / Discord). Both the Settings drawer and the
// onboarding wizard render channels from this list, so adding a new channel
// only requires writing one hook + appending one `ChannelDef` here.
//
// Each channel encapsulates its own connection protocol behind a hook returning
// a `ChannelController`. The generic `ChannelCard` renders any channel from its
// controller, so protocol differences (QR scan vs token form) stay inside the
// channel and never leak into the shared UI.

import React, { useState, useEffect, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import { WeChatLogo, WhatsAppLogo, TelegramLogo, DiscordLogo } from '../brand/icons'
import type { ChannelId, WhatsAppStatus, TelegramStatus, DiscordStatus } from '@shared/types'

export interface ChannelController {
  connected: boolean
  connecting: boolean
  statusLabel: string
  error: string | null
  /** Button label shown when not connected (e.g. "Connect", "Save & Connect"). */
  actionLabel: string
  /** Channel-specific UI shown below the card body (QR code or config form). */
  extraContent?: ReactNode
  /** Reassuring one-liner shown below the card once connected. */
  connectedHint?: ReactNode
  connect: () => void
  disconnect: () => void
}

export interface ChannelDef {
  id: ChannelId
  name: string
  description: string
  icon: ReactNode
  /** Tailwind classes for the channel's icon badge. */
  accentClass: string
}

// === WeChat — QR scan ===

function useWeChatChannel(): ChannelController {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof window.aide.wechat.getStatus>> | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [qrImg, setQrImg] = useState<string | null>(null)

  useEffect(() => {
    window.aide.wechat.getStatus().then(setStatus)
  }, [])

  useEffect(() => {
    const handler = (event: any) => {
      if (event.type === 'wechat:qrcode') {
        setQrImg(event.imgContent)
      } else if (event.type === 'wechat:login-progress') {
        if (event.stage === 'confirmed') {
          setQrImg(null)
          setConnecting(false)
          window.aide.wechat.getStatus().then(setStatus)
        } else if (event.stage === 'expired' || event.stage === 'timeout') {
          setQrImg(null)
          setConnecting(false)
        }
      }
    }
    return window.aideEvents.on(handler)
  }, [])

  const connect = async () => {
    setConnecting(true)
    try {
      const result = await window.aide.wechat.connect()
      setStatus(result)
      if (result.connection !== 'connected' || result.lastError) {
        setQrImg(null)
        setConnecting(false)
      }
    } catch {
      setConnecting(false)
      window.aide.wechat.getStatus().then(setStatus)
    }
  }

  const disconnect = async () => {
    const result = await window.aide.wechat.disconnect()
    setStatus(result)
    setQrImg(null)
  }

  const connected = status?.connection === 'connected'

  return {
    connected,
    connecting,
    statusLabel: connected
      ? `Connected${status?.monitorActive ? ' · listening' : ''}`
      : connecting ? 'Waiting for scan…' : 'Not connected',
    error: status?.lastError ?? null,
    actionLabel: connecting ? 'Scanning…' : 'Connect',
    connectedHint: connected ? 'Say hi to the bot in WeChat to let Aide reach you.' : undefined,
    extraContent: qrImg && connecting ? (
      <QrFrame caption="Scan the QR code with WeChat to sign in">
        <img src={qrImg} alt="WeChat QR Code" className="w-48 h-48 rounded-md" />
      </QrFrame>
    ) : null,
    connect,
    disconnect,
  }
}

// === WhatsApp — Baileys QR scan ===

function useWhatsAppChannel(): ChannelController {
  const [status, setStatus] = useState<WhatsAppStatus | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [qrCode, setQrCode] = useState<string | null>(null)

  useEffect(() => {
    window.aide.whatsapp?.getStatus().then(setStatus)
  }, [])

  useEffect(() => {
    const handler = (event: any) => {
      if (event.type === 'whatsapp:qrcode') {
        setQrCode(event.qrCode)
      } else if (event.type === 'whatsapp:status') {
        setStatus(event.status)
        if (event.status.connection === 'connected') {
          setQrCode(null)
          setConnecting(false)
        } else if (event.status.connection === 'disconnected' || event.status.connection === 'error') {
          setConnecting(false)
        }
      }
    }
    return window.aideEvents.on(handler)
  }, [])

  const connect = async () => {
    setConnecting(true)
    try {
      await window.aide.whatsapp?.connect()
    } catch {
      setConnecting(false)
      window.aide.whatsapp?.getStatus().then(setStatus)
    }
  }

  const disconnect = async () => {
    const result = await window.aide.whatsapp?.disconnect(true)
    setStatus(result ?? null)
    setQrCode(null)
  }

  const connected = status?.connection === 'connected'

  return {
    connected,
    connecting,
    statusLabel: connected
      ? `Connected${status?.phoneNumber ? ` · ${status.phoneNumber}` : ''}`
      : connecting ? 'Waiting for scan…' : 'Not connected',
    error: status?.lastError ?? null,
    actionLabel: connecting ? 'Scanning…' : 'Connect',
    connectedHint: connected ? 'Message yourself in WhatsApp and Aide will pick it up.' : undefined,
    extraContent: qrCode && connecting && !connected ? (
      <QrFrame caption="Open WhatsApp → Linked Devices → Scan this code" white>
        <img src={qrCode} alt="WhatsApp QR Code" className="w-full h-full" />
      </QrFrame>
    ) : null,
    connect,
    disconnect,
  }
}

// === Telegram — bot token + chat id ===

function useTelegramChannel(): ChannelController {
  const [status, setStatus] = useState<TelegramStatus | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [showConfig, setShowConfig] = useState(false)
  const [botToken, setBotToken] = useState('')
  const [chatId, setChatId] = useState('')

  useEffect(() => {
    window.aide.telegram?.getStatus().then(setStatus)
  }, [])

  useEffect(() => {
    const handler = (event: any) => {
      if (event.type === 'telegram:status') setStatus(event.status)
    }
    return window.aideEvents.on(handler)
  }, [])

  const connect = async () => {
    if (!status?.chatId && !showConfig) { setShowConfig(true); return }
    if (showConfig) {
      if (!botToken.trim() || !chatId.trim()) return
      setConnecting(true)
      try {
        const result = await window.aide.telegram.connect({ botToken: botToken.trim(), chatId: chatId.trim() })
        setStatus(result)
        if (result.connection === 'connected') { setShowConfig(false); setBotToken(''); setChatId('') }
      } catch { window.aide.telegram?.getStatus().then(setStatus) }
      finally { setConnecting(false) }
    } else {
      setConnecting(true)
      try { const result = await window.aide.telegram.connect(); setStatus(result) }
      catch { window.aide.telegram?.getStatus().then(setStatus) }
      finally { setConnecting(false) }
    }
  }

  const disconnect = async () => {
    const result = await window.aide.telegram.disconnect(true)
    setStatus(result)
    setShowConfig(false)
  }

  const connected = status?.connection === 'connected'

  return {
    connected,
    connecting,
    statusLabel: connected
      ? `Connected${status?.botUsername ? ` · @${status.botUsername}` : ''}`
      : connecting ? 'Connecting…' : 'Not connected',
    error: status?.lastError ?? null,
    actionLabel: connecting ? 'Connecting…' : showConfig ? 'Save & Connect' : 'Connect',
    extraContent: showConfig && !connected ? (
      <ConfigForm
        help={
          <ol className="mt-2 ml-4 space-y-1 list-decimal text-[11px] text-text-tertiary">
            <li>Message <ExtLink href="https://t.me/BotFather">@BotFather</ExtLink> → /newbot → copy the token</li>
            <li>Start a chat with your new bot (send /start)</li>
            <li>Message <ExtLink href="https://t.me/userinfobot">@userinfobot</ExtLink> to get your Chat ID</li>
          </ol>
        }
        fields={[
          { label: 'Bot Token', type: 'password', value: botToken, onChange: setBotToken, placeholder: '123456:ABC-DEF1234ghIkl-zyx57W2v...' },
          { label: 'Chat ID', type: 'text', value: chatId, onChange: setChatId, placeholder: '123456789' },
        ]}
        onCancel={() => { setShowConfig(false); setBotToken(''); setChatId('') }}
      />
    ) : null,
    connect,
    disconnect,
  }
}

// === Discord — bot token + channel id ===

function useDiscordChannel(): ChannelController {
  const [status, setStatus] = useState<DiscordStatus | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [showConfig, setShowConfig] = useState(false)
  const [botToken, setBotToken] = useState('')
  const [channelId, setChannelId] = useState('')

  useEffect(() => {
    window.aide.discord?.getStatus().then(setStatus)
  }, [])

  useEffect(() => {
    const handler = (event: any) => {
      if (event.type === 'discord:status') setStatus(event.status)
    }
    return window.aideEvents.on(handler)
  }, [])

  const connect = async () => {
    if (!status?.channelId && !showConfig) { setShowConfig(true); return }
    if (showConfig) {
      if (!botToken.trim() || !channelId.trim()) return
      setConnecting(true)
      try {
        const result = await window.aide.discord.connect({ botToken: botToken.trim(), channelId: channelId.trim() })
        setStatus(result)
        if (result.connection === 'connected') { setShowConfig(false); setBotToken(''); setChannelId('') }
      } catch { window.aide.discord?.getStatus().then(setStatus) }
      finally { setConnecting(false) }
    } else {
      setConnecting(true)
      try { const result = await window.aide.discord.connect(); setStatus(result) }
      catch { window.aide.discord?.getStatus().then(setStatus) }
      finally { setConnecting(false) }
    }
  }

  const disconnect = async () => {
    const result = await window.aide.discord.disconnect(true)
    setStatus(result)
    setShowConfig(false)
  }

  const connected = status?.connection === 'connected'

  return {
    connected,
    connecting,
    statusLabel: connected
      ? `Connected${status?.botUsername ? ` · ${status.botUsername}` : ''}`
      : connecting ? 'Connecting…' : 'Not connected',
    error: status?.lastError ?? null,
    actionLabel: connecting ? 'Connecting…' : showConfig ? 'Save & Connect' : 'Connect',
    extraContent: showConfig && !connected ? (
      <ConfigForm
        help={
          <ol className="mt-2 ml-4 space-y-1 list-decimal text-[11px] text-text-tertiary">
            <li>Go to <ExtLink href="https://discord.com/developers/applications">Discord Developer Portal</ExtLink> → New Application</li>
            <li>Bot tab → Reset Token → copy it below</li>
            <li>Enable <strong>Message Content Intent</strong> under Privileged Gateway Intents</li>
            <li>OAuth2 → URL Generator → check <strong>bot</strong> → permissions: <strong>Send Messages</strong> + <strong>Read Message History</strong> → invite to your server</li>
            <li>Enable Developer Mode (Settings → Advanced), right-click channel → Copy Channel ID</li>
          </ol>
        }
        fields={[
          { label: 'Bot Token', type: 'password', value: botToken, onChange: setBotToken, placeholder: 'MTIzNDU2Nzg5MDEy...' },
          { label: 'Channel ID', type: 'text', value: channelId, onChange: setChannelId, placeholder: '1234567890123456789' },
        ]}
        onCancel={() => { setShowConfig(false); setBotToken(''); setChannelId('') }}
      />
    ) : null,
    connect,
    disconnect,
  }
}

// === Registry ===

export const CHANNELS: ChannelDef[] = [
  { id: 'wechat', name: 'WeChat', description: 'Connect by scanning a QR code', icon: <WeChatLogo size={18} />, accentClass: 'bg-[#07C160] text-white' },
  { id: 'whatsapp', name: 'WhatsApp', description: 'Connect by scanning a QR code', icon: <WhatsAppLogo size={18} />, accentClass: 'bg-[#25D366] text-white' },
  { id: 'telegram', name: 'Telegram', description: 'Connect with a bot token', icon: <TelegramLogo size={18} />, accentClass: 'bg-[#26A5E4] text-white' },
  { id: 'discord', name: 'Discord', description: 'Connect with a bot token', icon: <DiscordLogo size={18} />, accentClass: 'bg-[#5865F2] text-white' },
]

/**
 * Calls every channel hook in a fixed order (rules-of-hooks safe) and pairs
 * each controller with its definition. Both onboarding and Settings consume
 * this so the channel set — and its live connection state — stays in sync.
 */
export function useAllChannels(): Array<{ def: ChannelDef; ctrl: ChannelController }> {
  const wechat = useWeChatChannel()
  const whatsapp = useWhatsAppChannel()
  const telegram = useTelegramChannel()
  const discord = useDiscordChannel()
  const ctrls: Record<ChannelId, ChannelController> = { wechat, whatsapp, telegram, discord }
  return CHANNELS.map(def => ({ def, ctrl: ctrls[def.id] }))
}

// === Shared list — "pick one you check most" ===

/**
 * Renders all channels. When `emphasizePickOne` is set (onboarding), connecting
 * any single channel gently fades the rest, signalling that one is enough —
 * the user can always add more later in Settings.
 */
export function ChannelsList({ emphasizePickOne = false }: { emphasizePickOne?: boolean }) {
  const channels = useAllChannels()
  const anyConnected = channels.some(c => c.ctrl.connected)

  return (
    <div className="space-y-3">
      {channels.map(({ def, ctrl }) => (
        <ChannelCard
          key={def.id}
          channel={def}
          ctrl={ctrl}
          dimmed={emphasizePickOne && anyConnected && !ctrl.connected}
        />
      ))}
    </div>
  )
}

// === Pick-one selector — "choose where Aide reaches you" ===

/**
 * A compact icon switcher over a single detail card. Designed for onboarding,
 * where the goal is to pick ONE channel: only the selected channel's detail
 * (status, connect action, QR / token form) is shown at a time, so the layout
 * height stays bounded and switching tabs collapses the previous channel's form.
 * Connected channels show a check badge on their icon.
 */
export function ChannelPicker() {
  const channels = useAllChannels()
  const [selectedId, setSelectedId] = useState<ChannelId>(
    () => (channels.find(c => c.ctrl.connected) ?? channels[0]).def.id,
  )
  const selected = channels.find(c => c.def.id === selectedId) ?? channels[0]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-center gap-3">
        {channels.map(({ def, ctrl }) => {
          const active = def.id === selectedId
          return (
            <button
              key={def.id}
              type="button"
              onClick={() => setSelectedId(def.id)}
              title={def.name}
              aria-label={def.name}
              aria-pressed={active}
              className={`relative w-12 h-12 rounded-xl flex items-center justify-center transition-all duration-200 ${def.accentClass} ${
                active
                  ? 'ring-2 ring-accent ring-offset-2 ring-offset-surface-1 scale-105 shadow-sm'
                  : 'opacity-55 hover:opacity-100'
              }`}
            >
              {def.icon}
              {ctrl.connected && (
                <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-success border-2 border-surface-1 flex items-center justify-center">
                  <Check size={9} className="text-white" strokeWidth={3} />
                </span>
              )}
            </button>
          )
        })}
      </div>

      <ChannelCard channel={selected.def} ctrl={selected.ctrl} />
    </div>
  )
}

// === Generic card ===

/**
 * Renders a single channel from its controller. Used by both the Settings
 * drawer and the onboarding wizard so the two stay in sync automatically.
 */
export function ChannelCard({ channel, ctrl, dimmed = false }: { channel: ChannelDef; ctrl: ChannelController; dimmed?: boolean }) {
  return (
    <div
      className={`p-4 rounded-xl border text-left transition-all duration-300 ${
        ctrl.connected ? 'bg-success/[0.04] border-success/25' : 'bg-surface-0 border-edge'
      } ${dimmed ? 'opacity-50 hover:opacity-100' : 'opacity-100'}`}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-3">
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${channel.accentClass}`}>
            {channel.icon}
          </div>
          <div>
            <p className="text-[13px] font-medium text-text-primary">{channel.name}</p>
            <p className="text-[12px] text-text-tertiary mt-0.5">{channel.description}</p>
            <div className="flex items-center gap-1.5 mt-1.5">
              <div className={`w-[6px] h-[6px] rounded-full ${ctrl.connected ? 'bg-success' : 'bg-text-tertiary'}`} />
              <span className={`text-[11px] ${ctrl.connected ? 'text-success' : 'text-text-tertiary'}`}>
                {ctrl.statusLabel}
              </span>
            </div>
            {ctrl.error && <p className="text-[11px] text-danger mt-1">{ctrl.error}</p>}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {ctrl.connected ? (
            <button
              onClick={ctrl.disconnect}
              className="h-7 px-3 rounded-lg text-[12px] font-medium inline-flex items-center gap-1.5 transition-colors bg-danger/10 text-danger hover:bg-danger/15 border border-danger/15"
            >
              Disconnect
            </button>
          ) : (
            <button
              onClick={ctrl.connect}
              disabled={ctrl.connecting}
              className="h-7 px-3 rounded-lg text-[12px] font-medium inline-flex items-center gap-1.5 transition-colors bg-surface-2 text-text-secondary hover:bg-surface-3 border border-edge disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {ctrl.actionLabel}
            </button>
          )}
        </div>
      </div>

      {ctrl.connected && ctrl.connectedHint && (
        <p className="mt-3 text-[11px] text-text-tertiary">{ctrl.connectedHint}</p>
      )}

      {ctrl.extraContent}
    </div>
  )
}

// === Small shared building blocks ===

function QrFrame({ children, caption, white = false }: { children: ReactNode; caption: string; white?: boolean }) {
  return (
    <div className="mt-4 flex flex-col items-center gap-2 p-4 rounded-lg bg-surface-2 border border-edge anim-fade-up">
      <div className={`w-48 h-48 flex items-center justify-center rounded-md ${white ? 'bg-white p-2' : ''}`}>
        {children}
      </div>
      <p className="text-[11px] text-text-tertiary">{caption}</p>
    </div>
  )
}

function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} className="text-accent hover:underline" target="_blank" rel="noreferrer">{children}</a>
}

interface ConfigField {
  label: string
  type: 'text' | 'password'
  value: string
  onChange: (v: string) => void
  placeholder?: string
}

function ConfigForm({ help, fields, onCancel }: { help: ReactNode; fields: ConfigField[]; onCancel: () => void }) {
  return (
    <div className="mt-4 space-y-3 p-3 rounded-lg bg-surface-2 border border-edge anim-fade-up">
      <details className="text-[11px] text-text-tertiary">
        <summary className="cursor-pointer hover:text-text-secondary">How do I get these values?</summary>
        {help}
      </details>
      {fields.map(f => (
        <div key={f.label}>
          <label className="text-[11px] font-medium text-text-secondary block mb-1">{f.label}</label>
          <input
            type={f.type}
            value={f.value}
            onChange={e => f.onChange(e.target.value)}
            placeholder={f.placeholder}
            className="w-full h-8 px-2.5 text-[12px] rounded-md bg-surface-0 border border-edge text-text-primary placeholder:text-text-tertiary/50 focus:border-accent focus:outline-none"
          />
        </div>
      ))}
      <button onClick={onCancel} className="text-[11px] text-text-tertiary hover:text-text-secondary">Cancel</button>
    </div>
  )
}
