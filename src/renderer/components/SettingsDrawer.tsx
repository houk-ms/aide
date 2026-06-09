import React, { useEffect, useState, useRef } from 'react'
import { X, Link2, FolderOpen, Users, Timer, Brain, Sliders, Trash2, Plus, Save, Check, Github, Send, RefreshCw, Download, CheckCircle2, AlertCircle, Sparkles, AlertTriangle, Search } from 'lucide-react'
import { WeChatLogo, TelegramLogo, DiscordLogo } from '../brand/icons'
import { useSettingsStore } from '../stores/settingsStore'
import type { Project, Relation, Job, ConnectionStatus, MemoryEntry, WeChatStatus, TelegramStatus, DiscordStatus, DeliveryTarget, UpdateState, Skill, BrowsableSkill } from '@shared/types'
import { ChannelsList } from '../channels/registry'

function MicrosoftIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 21 21" fill="none">
      <rect x="1" y="1" width="9" height="9" fill="#F25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  )
}

export function SettingsDrawer() {
  const { isOpen, activeTab, close, setTab, projects, jobs, connections,
    fetchProjects, fetchRelations, fetchJobs, fetchConnections } = useSettingsStore()

  useEffect(() => {
    if (isOpen) { fetchProjects(); fetchRelations(); fetchJobs(); fetchConnections() }
  }, [isOpen])

  if (!isOpen) return null

  const tabs: Array<{ id: typeof activeTab; label: string; icon: React.ReactNode }> = [
    { id: 'connections', label: 'Connections', icon: <Link2 size={14} /> },
    { id: 'jobs', label: 'Jobs', icon: <Timer size={14} /> },
    { id: 'projects', label: 'Projects', icon: <FolderOpen size={14} /> },
    { id: 'memory', label: 'Memory', icon: <Brain size={14} /> },
    { id: 'skills', label: 'Skills', icon: <Sparkles size={14} /> },
    { id: 'preferences', label: 'Preferences', icon: <Sliders size={14} /> },
  ]

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={close} />

      {/* Panel */}
      <div className="absolute right-0 top-0 bottom-0 w-[720px] max-w-[94vw] bg-surface-1 border-l border-edge shadow-2xl flex flex-col anim-slide-in">
        {/* Header */}
        <div className="shrink-0 bg-surface-0">
          <div className="flex items-center pl-5 pr-5 h-[52px]">
            <h2 className="text-[13px] font-semibold text-text-primary">Manage</h2>
          </div>
          <div className="h-px bg-edge" />
        </div>

        {/* Tabs */}
        <nav className="flex border-b border-edge px-4 gap-0.5 shrink-0">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setTab(tab.id)}
              className={`flex items-center gap-1.5 px-2.5 py-2.5 text-[12px] font-medium whitespace-nowrap transition-colors border-b-2 -mb-px ${
                activeTab === tab.id
                  ? 'text-text-primary border-accent'
                  : 'text-text-tertiary border-transparent hover:text-text-secondary'
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </nav>

        {/* Content */}
        <div className="flex-1 overflow-y-auto scrollbar-thin p-5">
          {activeTab === 'connections' && <ConnectionsTab connections={connections} />}
          {activeTab === 'projects' && <ProjectsTab projects={projects} onRefresh={fetchProjects} />}
          {activeTab === 'jobs' && <JobsTab jobs={jobs} onRefresh={fetchJobs} />}
          {activeTab === 'memory' && <MemoryTab />}
          {activeTab === 'skills' && <SkillsTab />}
          {activeTab === 'preferences' && <PreferencesTab />}
        </div>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════
   Connections Tab
   ═══════════════════════════════════════════ */

function ConnectionsTab({ connections }: { connections: ConnectionStatus[] }) {
  const disconnect = useSettingsStore(s => s.disconnect)
  const [cliStatus, setCliStatus] = useState<{ gh: boolean; npx: boolean } | null>(null)
  const [ghAccounts, setGhAccounts] = useState<{ account: string; active: boolean }[]>([])
  const [switching, setSwitching] = useState(false)
  const [connecting, setConnecting] = useState<string | null>(null)

  useEffect(() => {
    window.aide.connections.checkCli().then(setCliStatus)
    window.aide.connections.listGhAccounts().then(setGhAccounts)
  }, [])

  const handleSwitchAccount = async (account: string) => {
    setSwitching(true)
    try {
      await window.aide.connections.switchGhAccount(account)
      const accs = await window.aide.connections.listGhAccounts()
      setGhAccounts(accs)
    } finally {
      setSwitching(false)
    }
  }

  const isCliMissing = (type: string) => {
    if (!cliStatus) return false
    if (type === 'github') return !cliStatus.gh
    return false // workiq uses npx auto-download
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <SectionLabel title="Sources" desc="Where Aide reads your work from — email, calendar, issues, and more." />
        <div className="space-y-4">
      {connections.map(conn => (
        <Card key={conn.id}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3 flex-1 min-w-0">
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                conn.type === 'workiq' ? 'bg-blue-500/10 text-blue-400' : 'bg-zinc-500/10 text-text-secondary'
              }`}>
                {conn.type === 'workiq' ? <MicrosoftIcon /> : <Github size={18} />}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-medium text-text-primary">
                  {conn.type === 'workiq' ? 'Microsoft 365' : 'GitHub'}
                </p>
                <p className="text-[12px] text-text-tertiary mt-0.5">
                  {conn.type === 'workiq' ? 'Email · Calendar · Teams · OneDrive' : 'Issues · Pull Requests · Repos'}
                </p>
                <div className="flex items-center gap-1.5 mt-1.5">
                  <div className={`w-[6px] h-[6px] rounded-full ${
                    conn.checking ? 'bg-text-tertiary animate-pulse' : conn.verified ? 'bg-success' : conn.authenticated ? 'bg-warning' : 'bg-text-tertiary'
                  }`} />
                  <span className={`text-[11px] ${
                    conn.checking ? 'text-text-tertiary' : conn.verified ? 'text-success' : conn.authenticated ? 'text-warning' : 'text-text-tertiary'
                  }`}>
                    {conn.checking
                      ? 'Checking connection…'
                      : conn.verified
                      ? `Connected${conn.activeAccount ? ` · ${conn.activeAccount}` : ''}`
                      : conn.authenticated ? 'Signed in · verifying permissions' : 'Not connected'}
                  </span>
                </div>
                {conn.lastError && <p className="text-[11px] text-danger mt-1">{conn.lastError}</p>}
                {conn.type === 'github' && conn.authenticated && ghAccounts.length > 1 && (
                  <div className="mt-2">
                    <p className="text-[10px] text-text-tertiary mb-1">Switch account:</p>
                    <div className="flex flex-wrap gap-1">
                      {ghAccounts.map(acc => (
                        <button
                          key={acc.account}
                          disabled={acc.active || switching}
                          onClick={() => handleSwitchAccount(acc.account)}
                          className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
                            acc.active
                              ? 'bg-accent/15 text-accent font-medium cursor-default'
                              : 'bg-surface-2 text-text-secondary hover:bg-surface-2/80 hover:text-text-primary'
                          } ${switching ? 'opacity-50' : ''}`}
                        >
                          {acc.account}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {isCliMissing(conn.type) && !conn.authenticated && (
                  <div className="mt-2 p-2.5 rounded-lg bg-surface-2/60 border border-edge-subtle">
                    <p className="text-[11px] text-text-secondary mb-1">Install the <code className="bg-surface-2 px-1 rounded text-[10px]">gh</code> CLI first:</p>
                    <p className="text-[11px] text-text-tertiary">
                      <code className="bg-surface-2 px-1 rounded text-[10px]">winget install GitHub.cli</code>
                      {' · '}
                      <a href="https://cli.github.com" className="text-accent hover:underline" onClick={e => { e.preventDefault(); window.open('https://cli.github.com') }}>Download</a>
                    </p>
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {conn.authenticated && (
                <Btn variant="danger" onClick={() => disconnect(conn.type)}>Disconnect</Btn>
              )}
              {!isCliMissing(conn.type) && (
                <Btn
                  disabled={connecting === conn.type}
                  onClick={async () => {
                    setConnecting(conn.type)
                    try {
                      if (conn.type === 'github') await window.aide.connections.authenticateGitHub()
                      else await window.aide.connections.authenticateMicrosoft()
                    } catch { /* handled via event */ }
                    finally { setConnecting(null) }
                  }}
                >
                  {connecting === conn.type ? 'Connecting…' : conn.authenticated ? 'Reauthorize' : 'Connect'}
                </Btn>
              )}
            </div>
          </div>
        </Card>
      ))}
        </div>
      </section>

      <section className="space-y-3">
        <SectionLabel title="Channels" desc="Pick the one you check most — that's where Aide reaches you." />
        <ChannelsList />
      </section>
    </div>
  )
}

/* ═══════════════════════════════════════════
   Projects Tab
   ═══════════════════════════════════════════ */

function ProjectsTab({ projects, onRefresh }: { projects: Project[]; onRefresh: () => void }) {
  const [adding, setAdding] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Desc>The projects you follow, so Aide can help more precisely.</Desc>
        <Btn onClick={() => setAdding(true)}><Plus size={12} /> Add</Btn>
      </div>

      {adding && (
        <ProjectForm
          onSave={async (data) => { await window.aide.projects.create(data); setAdding(false); onRefresh() }}
          onCancel={() => setAdding(false)}
        />
      )}

      {projects.length === 0 && !adding && <Empty>No projects yet. Click “Add” above to start.</Empty>}

      {projects.map(p => editId === p.id ? (
        <ProjectForm
          key={p.id}
          initial={p}
          onSave={async (data) => { await window.aide.projects.update(p.id, data); setEditId(null); onRefresh() }}
          onCancel={() => setEditId(null)}
          onDelete={async () => { await window.aide.projects.delete(p.id); setEditId(null); onRefresh() }}
        />
      ) : (
        <Card key={p.id} className="group">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-[13px] font-medium text-text-primary">{p.name}</p>
              {p.description && <p className="text-[12px] text-text-tertiary mt-0.5">{p.description}</p>}
              <div className="flex items-center gap-3 mt-2 text-[11px] text-text-tertiary">
                {p.repoPath && <span className="flex items-center gap-1"><FolderOpen size={11} /> {p.repoPath}</span>}
                {p.techStack && <span>{p.techStack}</span>}
                {p.team.length > 0 && <span className="flex items-center gap-1"><Users size={11} /> {p.team.length}</span>}
              </div>
            </div>
            <button onClick={() => setEditId(p.id)} className="text-[12px] text-text-tertiary hover:text-text-secondary opacity-0 group-hover:opacity-100 transition-all">
              Edit
            </button>
          </div>
        </Card>
      ))}
    </div>
  )
}

function ProjectForm({ initial, onSave, onCancel, onDelete }: {
  initial?: Partial<Project>; onSave: (data: any) => Promise<void>; onCancel: () => void; onDelete?: () => Promise<void>
}) {
  const [name, setName] = useState(initial?.name || '')
  const [description, setDescription] = useState(initial?.description || '')
  const [repoPath, setRepoPath] = useState(initial?.repoPath || '')

  return (
    <FormCard>
      <Field label="Name" value={name} onChange={setName} placeholder="Project name" required />
      <Field label="Repository" value={repoPath} onChange={setRepoPath} placeholder="owner/repo or local path (optional)" />
      <Field label="One-line description" value={description} onChange={setDescription} placeholder="What's this project about? (optional)" multiline />
      <FormHint>Aide keeps details like tech stack, team, and docs up to date on its own as you work.</FormHint>
      <FormActions
        onSave={() => onSave({ name, description, repoPath: repoPath || undefined })}
        onCancel={onCancel}
        onDelete={onDelete}
        disabled={!name.trim()}
      />
    </FormCard>
  )
}

/* ═══════════════════════════════════════════
   Relations Tab
   ═══════════════════════════════════════════ */

function RelationsTab({ relations, onRefresh }: { relations: Relation[]; onRefresh: () => void }) {
  const [adding, setAdding] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Desc>Key people you work with, so Aide can prioritize their messages.</Desc>
        <Btn onClick={() => setAdding(true)}><Plus size={12} /> Add</Btn>
      </div>

      {adding && (
        <RelationForm onSave={async (data) => { await window.aide.relations.create(data); setAdding(false); onRefresh() }} onCancel={() => setAdding(false)} />
      )}

      {relations.length === 0 && !adding && <Empty>No contacts yet.</Empty>}

      {relations.map(r => editId === r.id ? (
        <RelationForm key={r.id} initial={r} onSave={async (data) => { await window.aide.relations.update(r.id, data); setEditId(null); onRefresh() }} onCancel={() => setEditId(null)} onDelete={async () => { await window.aide.relations.delete(r.id); setEditId(null); onRefresh() }} />
      ) : (
        <Card key={r.id} className="group">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2">
                <p className="text-[13px] font-medium text-text-primary">{r.name}</p>
                <RoleBadge role={r.role} />
              </div>
              <p className="text-[12px] text-text-tertiary mt-0.5">
                {[r.title, r.org].filter(Boolean).join(' · ') || 'Not set'}
              </p>
              {r.expertise.length > 0 && (
                <div className="flex gap-1 mt-1.5 flex-wrap">
                  {r.expertise.map((e, i) => <Tag key={i}>{e}</Tag>)}
                </div>
              )}
            </div>
            <button onClick={() => setEditId(r.id)} className="text-[12px] text-text-tertiary hover:text-text-secondary opacity-0 group-hover:opacity-100 transition-all">Edit</button>
          </div>
        </Card>
      ))}
    </div>
  )
}

function RelationForm({ initial, onSave, onCancel, onDelete }: {
  initial?: Partial<Relation>; onSave: (data: any) => Promise<void>; onCancel: () => void; onDelete?: () => Promise<void>
}) {
  const [name, setName] = useState(initial?.name || '')
  const [role, setRole] = useState<string>(initial?.role || 'peer')
  const [notes, setNotes] = useState(initial?.notes || '')

  return (
    <FormCard>
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="Name" value={name} onChange={setName} placeholder="Name" required />
        <div>
          <label className="text-[11px] text-text-tertiary font-medium block mb-1">Role</label>
          <select value={role} onChange={e => setRole(e.target.value)} className="w-full bg-surface-0 border border-edge rounded-lg px-2.5 py-[7px] text-[13px] text-text-primary outline-none focus:border-accent/50 transition-colors appearance-none">
            <option value="manager">Manager</option>
            <option value="peer">Peer</option>
            <option value="report">Report</option>
            <option value="external">External</option>
            <option value="stakeholder">Stakeholder</option>
          </select>
        </div>
      </div>
      <Field label="Notes" value={notes} onChange={setNotes} placeholder="Why they matter or how you work together (optional)" multiline />
      <FormHint>Aide picks up details like email, Teams handle, title, and working style on its own as you interact.</FormHint>
      <FormActions
        onSave={() => onSave({ name, role, notes: notes || undefined })}
        onCancel={onCancel}
        onDelete={onDelete}
        disabled={!name.trim()}
      />
    </FormCard>
  )
}

/* ═══════════════════════════════════════════
   Jobs Tab
   ═══════════════════════════════════════════ */

function JobsTab({ jobs, onRefresh }: { jobs: Job[]; onRefresh: () => void }) {
  const [adding, setAdding] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Desc>Tasks Aide runs automatically on a schedule to keep you up to date.</Desc>
        <Btn onClick={() => { setAdding(true); setEditId(null) }}><Plus size={12} /> New</Btn>
      </div>

      {adding && (
        <JobForm
          onSave={async (data) => { await window.aide.jobs.create(data); setAdding(false); onRefresh() }}
          onCancel={() => setAdding(false)}
        />
      )}

      {jobs.length === 0 && !adding && <Empty>No scheduled jobs yet. Click “New” above to create one.</Empty>}

      {jobs.map(job => editId === job.id ? (
        <JobForm
          key={job.id}
          initial={job}
          managed={job.isBuiltin}
          onSave={async (data) => { await window.aide.jobs.update(job.id, data); setEditId(null); onRefresh() }}
          onCancel={() => setEditId(null)}
          onDelete={job.isBuiltin ? undefined : async () => { await window.aide.jobs.delete(job.id); setEditId(null); onRefresh() }}
        />
      ) : (
        <Card key={job.id} className="group">
          <div className="flex items-center justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-[13px] font-medium text-text-primary truncate">{job.name}</p>
                {job.isBuiltin && (
                  <span className="text-[10px] text-text-tertiary border border-edge rounded px-1 py-px shrink-0">Built-in</span>
                )}
                {job.lastResult && (
                  <div className={`w-[6px] h-[6px] rounded-full shrink-0 ${job.lastResult === 'success' ? 'bg-success' : 'bg-danger'}`} />
                )}
              </div>
              <p className="text-[11px] text-text-tertiary mt-0.5">{describeCron(job.cron)}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => setEditId(job.id)} className="text-[12px] text-text-tertiary hover:text-text-secondary opacity-0 group-hover:opacity-100 transition-all">
                Edit
              </button>
              <Toggle checked={job.enabled} onChange={async v => { await window.aide.jobs.toggle(job.id, v); onRefresh() }} />
            </div>
          </div>

          {/* Instruction preview */}
          <p className="text-[12px] text-text-tertiary mt-1.5 line-clamp-1">{job.instruction}</p>

          {job.deliveryTargets.length > 0 && (
            <div className="flex items-center gap-1.5 mt-2">
              <Send size={11} className="text-text-tertiary shrink-0" />
              <span className="text-[11px] text-text-tertiary">{job.deliveryTargets.map(t => DELIVERY_LABELS[t]).join(' · ')}</span>
            </div>
          )}

          {/* Last run info */}
          {job.lastRunAt && (
            <div className="mt-2.5 pt-2.5 border-t border-edge-subtle">
              <div className="flex items-center gap-2">
                <span className={`text-[11px] ${job.lastResult === 'success' ? 'text-success' : 'text-danger'}`}>
                  {job.lastResult === 'success' ? 'Last run succeeded' : 'Last run failed'}
                </span>
                <span className="text-[11px] text-text-tertiary">{formatRelativeTime(job.lastRunAt)}</span>
                {job.lastSummary && (
                  <button onClick={() => setExpandedId(expandedId === job.id ? null : job.id)} className="text-[11px] text-text-tertiary hover:text-text-secondary transition-colors ml-auto">
                    {expandedId === job.id ? 'Collapse' : 'Details'}
                  </button>
                )}
              </div>
              {expandedId === job.id && job.lastSummary && (
                <pre className="mt-2 text-[12px] text-text-tertiary bg-surface-0 rounded-lg p-3 whitespace-pre-wrap overflow-x-auto leading-relaxed max-h-[200px] overflow-y-auto scrollbar-thin">{job.lastSummary}</pre>
              )}
            </div>
          )}
        </Card>
      ))}
    </div>
  )
}

function JobForm({ initial, managed, onSave, onCancel, onDelete }: {
  initial?: Partial<Job>; managed?: boolean; onSave: (data: { name: string; cron: string; instruction: string; deliveryTargets: DeliveryTarget[] }) => Promise<void>; onCancel: () => void; onDelete?: () => Promise<void>
}) {
  const [name, setName] = useState(initial?.name || '')
  const [instruction, setInstruction] = useState(initial?.instruction || '')
  const [deliveryTargets, setDeliveryTargets] = useState<DeliveryTarget[]>(initial?.deliveryTargets || [])

  const toggleTarget = (t: DeliveryTarget) =>
    setDeliveryTargets(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t])

  // Parse initial cron into structured schedule
  const parsed = parseCronToSchedule(initial?.cron || '*/15 * * * *')
  const [schedType, setSchedType] = useState<'interval' | 'daily' | 'weekly' | 'monthly'>(parsed.type)
  const [interval, setInterval] = useState(parsed.interval)
  const [hour, setHour] = useState(parsed.hour)
  const [minute, setMinute] = useState(parsed.minute)
  const [weekdays, setWeekdays] = useState<number[]>(parsed.weekdays)
  const [monthDay, setMonthDay] = useState(parsed.monthDay)

  const cron = buildCron(schedType, interval, hour, minute, weekdays, monthDay)

  const selectCls = "bg-surface-0 border border-edge rounded-lg px-3 py-[7px] text-[13px] text-text-primary outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20 transition-all appearance-none pr-7"
  const selectStyle = { backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2.5'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 8px center' }

  const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const toggleDay = (d: number) => setWeekdays(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d].sort())

  // Built-in jobs are managed by Aide: name/schedule/instruction are owned by the
  // app (re-synced each launch), so only the delivery target is editable here.
  if (managed) {
    return (
      <FormCard>
        <div>
          <label className="text-[11px] text-text-tertiary font-medium block mb-1.5">Job name</label>
          <p className="text-[13px] text-text-primary">{name}</p>
        </div>
        <div>
          <label className="text-[11px] text-text-tertiary font-medium block mb-1.5">Frequency</label>
          <p className="text-[13px] text-text-secondary">{describeCron(initial?.cron || cron)}</p>
        </div>
        <div>
          <label className="text-[11px] text-text-tertiary font-medium block mb-1.5">Instruction</label>
          <p className="text-[12px] text-text-tertiary whitespace-pre-wrap leading-relaxed">{instruction}</p>
        </div>
        <div>
          <label className="text-[11px] text-text-tertiary font-medium block mb-1.5">Deliver result to</label>
          <div className="flex gap-1.5">
            {DELIVERY_OPTIONS.map(opt => {
              const active = deliveryTargets.includes(opt.value)
              return (
                <button
                  key={opt.value}
                  onClick={() => toggleTarget(opt.value)}
                  className={`px-2.5 py-1 rounded-md text-[12px] transition-colors ${
                    active ? 'bg-accent text-white' : 'bg-surface-0 text-text-tertiary border border-edge hover:text-text-secondary'
                  }`}
                >
                  {opt.label}
                </button>
              )
            })}
          </div>
          <p className="text-[11px] text-text-tertiary/80 mt-1.5">This is a built-in Aide job. You can change where its summary is delivered or turn it off.</p>
        </div>
        <FormActions onSave={() => onSave({ name, cron, instruction, deliveryTargets })} onCancel={onCancel} disabled={false} />
      </FormCard>
    )
  }

  return (
    <FormCard>
      <Field label="Job name" value={name} onChange={setName} placeholder="e.g. Check unread email" required />

      <div>
        <label className="text-[11px] text-text-tertiary font-medium block mb-1.5">Frequency</label>
        <div className="flex items-center gap-2 flex-wrap">
          <select value={schedType} onChange={e => setSchedType(e.target.value as any)} className={selectCls} style={selectStyle}>
            <option value="interval">Every</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>

          {schedType === 'interval' && (
            <>
              <select value={interval} onChange={e => setInterval(+e.target.value)} className={`${selectCls} w-[80px]`} style={selectStyle}>
                {[5, 10, 15, 20, 30, 60].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
              <span className="text-[13px] text-text-secondary">minutes</span>
            </>
          )}

          {(schedType === 'daily' || schedType === 'weekly' || schedType === 'monthly') && (
            <>
              {schedType === 'monthly' && (
                <>
                  <select value={monthDay} onChange={e => setMonthDay(+e.target.value)} className={`${selectCls} w-[72px]`} style={selectStyle}>
                    {Array.from({ length: 28 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
                  </select>
                  <span className="text-[13px] text-text-secondary">of the month</span>
                </>
              )}
              <select value={hour} onChange={e => setHour(+e.target.value)} className={`${selectCls} w-[72px]`} style={selectStyle}>
                {Array.from({ length: 24 }, (_, i) => <option key={i} value={i}>{String(i).padStart(2, '0')}</option>)}
              </select>
              <span className="text-[13px] text-text-tertiary">:</span>
              <select value={minute} onChange={e => setMinute(+e.target.value)} className={`${selectCls} w-[72px]`} style={selectStyle}>
                {[0, 5, 10, 15, 20, 30, 45].map(m => <option key={m} value={m}>{String(m).padStart(2, '0')}</option>)}
              </select>
            </>
          )}
        </div>

        {schedType === 'weekly' && (
          <div className="flex gap-1 mt-2">
            {dayNames.map((d, i) => {
              const dayNum = i + 1 // 1=Mon ... 7=Sun
              const active = weekdays.includes(dayNum)
              return (
                <button
                  key={dayNum}
                  onClick={() => toggleDay(dayNum)}
                  className={`w-7 h-7 rounded-md text-[12px] font-medium transition-colors ${
                    active ? 'bg-accent text-white' : 'bg-surface-0 text-text-tertiary border border-edge hover:text-text-secondary'
                  }`}
                >
                  {d}
                </button>
              )
            })}
          </div>
        )}
      </div>

      <Field label="Instruction" value={instruction} onChange={setInstruction} placeholder="Tell Aide what to do, e.g. Check my unread email and flag anything urgent" required multiline />

      <div>
        <label className="text-[11px] text-text-tertiary font-medium block mb-1.5">Deliver result to</label>
        <div className="flex gap-1.5">
          {DELIVERY_OPTIONS.map(opt => {
            const active = deliveryTargets.includes(opt.value)
            return (
              <button
                key={opt.value}
                onClick={() => toggleTarget(opt.value)}
                className={`px-2.5 py-1 rounded-md text-[12px] transition-colors ${
                  active ? 'bg-accent text-white' : 'bg-surface-0 text-text-tertiary border border-edge hover:text-text-secondary'
                }`}
              >
                {opt.label}
              </button>
            )
          })}
        </div>
        <p className="text-[11px] text-text-tertiary/80 mt-1.5">Where to send this job's summary when it finishes. Leave empty for none.</p>
      </div>

      <FormActions onSave={() => onSave({ name, cron, instruction, deliveryTargets })} onCancel={onCancel} onDelete={onDelete} disabled={!name.trim() || !cron.trim() || !instruction.trim()} />
    </FormCard>
  )
}

const DELIVERY_OPTIONS: { value: DeliveryTarget; label: string }[] = [
  { value: 'desktop', label: 'Aide chat' },
  { value: 'wechat', label: 'WeChat' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'discord', label: 'Discord' },
]

const DELIVERY_LABELS: Record<DeliveryTarget, string> = {
  desktop: 'Aide chat',
  wechat: 'WeChat',
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  discord: 'Discord',
}

function parseCronToSchedule(cron: string) {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return { type: 'interval' as const, interval: 60, hour: 9, minute: 0, weekdays: [1, 2, 3, 4, 5], monthDay: 1 }

  const [min, hr, dom, , dow] = parts

  // */N pattern (e.g. */15 * * * *)
  if (min.startsWith('*/')) {
    return { type: 'interval' as const, interval: parseInt(min.slice(2)) || 15, hour: 9, minute: 0, weekdays: [1, 2, 3, 4, 5], monthDay: 1 }
  }

  // Hourly pattern: fixed minute, hour is * (e.g. 0 * * * *, 30 * * * *)
  if (hr === '*' && dom === '*') {
    return { type: 'interval' as const, interval: 60, hour: 9, minute: parseInt(min) || 0, weekdays: [1, 2, 3, 4, 5], monthDay: 1 }
  }

  const hour = parseInt(hr.split(',')[0]) || 0
  const minute = min === '*' ? 0 : parseInt(min) || 0

  // Monthly
  if (dom !== '*') {
    return { type: 'monthly' as const, interval: 60, hour, minute, weekdays: [1, 2, 3, 4, 5], monthDay: parseInt(dom) || 1 }
  }

  // Weekly
  if (dow !== '*') {
    const weekdays = dow.split(',').flatMap(seg => {
      if (seg.includes('-')) {
        const [a, b] = seg.split('-').map(Number)
        return Array.from({ length: b - a + 1 }, (_, i) => a + i)
      }
      return [parseInt(seg)]
    }).filter(n => n >= 1 && n <= 7)
    return { type: 'weekly' as const, interval: 60, hour, minute, weekdays: weekdays.length ? weekdays : [1, 2, 3, 4, 5], monthDay: 1 }
  }

  // Daily
  return { type: 'daily' as const, interval: 60, hour, minute, weekdays: [1, 2, 3, 4, 5], monthDay: 1 }
}

function buildCron(type: string, interval: number, hour: number, minute: number, weekdays: number[], monthDay: number): string {
  switch (type) {
    case 'interval':
      if (interval >= 60) return `${minute} * * * *`
      return `*/${interval} * * * *`
    case 'daily': return `${minute} ${hour} * * *`
    case 'weekly': {
      const sorted = [...weekdays].sort((a, b) => a - b)
      // Use range notation if consecutive (e.g. 1,2,3,4,5 → 1-5)
      const isConsecutive = sorted.length > 1 && sorted[sorted.length - 1] - sorted[0] === sorted.length - 1
      const dowStr = sorted.length === 0 ? '1-5' : isConsecutive ? `${sorted[0]}-${sorted[sorted.length - 1]}` : sorted.join(',')
      return `${minute} ${hour} * * ${dowStr}`
    }
    case 'monthly': return `${minute} ${hour} ${monthDay} * *`
    default: return '*/15 * * * *'
  }
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

/* ═══════════════════════════════════════════
   Skills Tab
   ═══════════════════════════════════════════ */

function SkillsTab() {
  const [skills, setSkills] = useState<Skill[]>([])
  const [browsableSkills, setBrowsableSkills] = useState<BrowsableSkill[]>([])
  const [browseLoading, setBrowseLoading] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [installedOnly, setInstalledOnly] = useState(false)
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [detail, setDetail] = useState<BrowsableSkill | null>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)

  // Reset pagination whenever the search query or filter changes.
  useEffect(() => { setLimit(PAGE_SIZE) }, [search, installedOnly])

  useEffect(() => {
    loadSkills()
    loadBrowsableSkills()
  }, [])

  const loadSkills = async () => {
    try {
      const list = await window.aide.skills.list()
      setSkills(list)
    } catch (err) {
      console.error('Failed to load skills:', err)
    }
  }

  const loadBrowsableSkills = async () => {
    setBrowseLoading(true)
    try {
      const list = await window.aide.marketplace.browse()
      setBrowsableSkills(list)
    } catch (err) {
      console.error('Failed to browse skills:', err)
    }
    setBrowseLoading(false)
  }

  const handleInstall = async (skill: BrowsableSkill) => {
    setInstalling(`${skill.sourceId}:${skill.path}`)
    try {
      await window.aide.marketplace.install(skill.sourceId, skill.path)
      await loadSkills()
      await loadBrowsableSkills()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to install skill')
    }
    setInstalling(null)
  }

  const handleToggle = async (skill: Skill) => {
    try {
      await window.aide.skills.toggle(skill.id, !skill.enabled)
      loadSkills()
    } catch (err) {
      console.error('Toggle failed:', err)
    }
  }

  const handleDelete = async (skill: Skill) => {
    if (!confirm(`Delete skill "${skill.name}"? This cannot be undone.`)) return
    try {
      await window.aide.skills.delete(skill.id)
      await loadSkills()
      await loadBrowsableSkills()
    } catch (err) {
      console.error('Delete failed:', err)
    }
  }

  // Match a marketplace skill to its installed record. Backend installs derive the
  // skill's directory id from sanitizeSkillName(name), so match on that first (mirrors
  // browseSkills' installed check) and fall back to the display name.
  const installedById = new Map(skills.map(s => [s.id, s]))
  const installedByName = new Map(skills.map(s => [s.name.toLowerCase().trim(), s]))
  const findInstalled = (name: string) =>
    installedById.get(sanitizeSkillName(name)) || installedByName.get(name.toLowerCase().trim())

  // Filter the marketplace by search.
  const q = search.trim().toLowerCase()
  const searched = q
    ? browsableSkills.filter(s =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q)
      )
    : browsableSkills
  const filtered = installedOnly
    ? searched.filter(s => findInstalled(s.name))
    : searched

  // Local / orphan skills that aren't represented in the marketplace list.
  const marketplaceNames = new Set(browsableSkills.map(s => s.name.toLowerCase().trim()))
  const localSkills = skills.filter(s => !marketplaceNames.has(s.name.toLowerCase().trim()))
  const localSearched = q
    ? localSkills.filter(s => s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q))
    : localSkills
  // Local skills are installed-only items, so they appear only under the Installed filter.
  const localFiltered = installedOnly ? localSearched : []

  const installedCount = skills.length

  // Only render a paged slice of the (huge) marketplace; scrolling near the bottom loads the next page.
  const visible = filtered.slice(0, limit)
  const hasMore = filtered.length > visible.length

  // Auto-load the next page when the sentinel scrolls into view.
  useEffect(() => {
    if (!hasMore) return
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver(entries => {
      if (entries[0]?.isIntersecting) setLimit(l => l + PAGE_SIZE)
    }, { rootMargin: '200px' })
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, filtered.length])

  return (
    <div className="space-y-3">
      {/* Search */}
      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search skills"
          className="w-full bg-surface-0 border border-edge rounded-lg pl-9 pr-3 py-[7px] text-[13px] text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20 transition-all"
        />
      </div>

      {/* Result count + installed filter */}
      {!browseLoading && (browsableSkills.length > 0 || skills.length > 0) && (
        <div className="flex items-center justify-between px-0.5">
          <span className="text-[11.5px] text-text-tertiary">
            {installedOnly
              ? `${filtered.length + localFiltered.length} installed`
              : q
                ? `${filtered.length} result${filtered.length === 1 ? '' : 's'}`
                : `${filtered.length} skills available`}
          </span>
          <button
            onClick={() => setInstalledOnly(v => !v)}
            className={`h-6 px-2.5 rounded-md text-[11.5px] font-medium transition-colors ${
              installedOnly
                ? 'bg-accent-muted text-accent'
                : 'text-text-tertiary hover:text-text-secondary hover:bg-surface-1'
            }`}
          >
            Installed{installedCount > 0 ? ` (${installedCount})` : ''}
          </button>
        </div>
      )}

      {browseLoading && browsableSkills.length === 0 ? (
        <div className="text-[12px] text-text-tertiary text-center py-10">Loading…</div>
      ) : filtered.length === 0 && localFiltered.length === 0 ? (
        <Empty>{installedOnly ? 'No skills installed yet.' : 'No skills found.'}</Empty>
      ) : (
        <>
        <div className="grid grid-cols-2 gap-2">
          {visible.map(skill => {
            const installed = findInstalled(skill.name)
            const isInstalling = installing === `${skill.sourceId}:${skill.path}`
            const dimmed = installed && !installed.enabled
            return (
              <div
                key={`${skill.sourceId}:${skill.path}`}
                onClick={() => setDetail(skill)}
                className="group flex flex-col p-3 rounded-lg border border-edge bg-surface-0 hover:border-accent/30 hover:bg-surface-1 transition-colors cursor-pointer"
              >
                <div className={`flex items-start gap-2.5 ${dimmed ? 'opacity-50' : ''}`}>
                  <SkillAvatar name={skill.name} dimmed={!!dimmed} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[13px] font-semibold text-text-primary truncate">{skill.name}</span>
                      {dimmed && <Tag>Off</Tag>}
                    </div>
                    {skill.category && (
                      <span className="text-[10.5px] text-text-tertiary capitalize">{skill.category}</span>
                    )}
                  </div>
                </div>
                {skill.description && (
                  <p className="text-[11.5px] leading-snug text-text-tertiary mt-2 line-clamp-2">{skill.description}</p>
                )}
                <SkillBadges skill={skill} />
                <div className="flex-1 min-h-3" />
                <div className="flex items-center justify-end gap-1.5 pt-3 border-t border-edge-subtle">
                  {installed ? (
                    <>
                      <span className="mr-auto text-[11px] font-medium text-text-tertiary inline-flex items-center gap-1"><CheckCircle2 size={12} className="text-accent" /> Installed</span>
                      <Toggle checked={installed.enabled} onChange={() => handleToggle(installed)} />
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDelete(installed) }}
                        className="w-7 h-7 rounded-lg flex items-center justify-center text-text-tertiary hover:text-danger hover:bg-danger/8 transition-all"
                        title="Uninstall"
                      >
                        <Trash2 size={13} />
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleInstall(skill) }}
                      disabled={isInstalling}
                      className="h-7 px-3 rounded-lg text-[12px] font-medium bg-surface-2 text-text-secondary border border-edge hover:bg-surface-3 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5"
                    >
                      {isInstalling ? 'Installing…' : <><Download size={12} /> Install</>}
                    </button>
                  )}
                </div>
              </div>
            )
          })}

          {/* Locally-installed skills not present in the marketplace */}
          {localFiltered.map(skill => (
            <div
              key={skill.id}
              onClick={() => setDetail({
                name: skill.name,
                description: skill.description || '',
                sourceId: 'local',
                sourceName: 'Local',
                sourceType: 'local',
                path: skill.id,
                installed: true,
                source: 'local'
              })}
              className="group flex flex-col p-3 rounded-lg border border-edge bg-surface-0 hover:border-accent/30 hover:bg-surface-1 transition-colors cursor-pointer"
            >
              <div className={`flex items-start gap-2.5 ${skill.enabled ? '' : 'opacity-50'}`}>
                <SkillAvatar name={skill.name} dimmed={!skill.enabled} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[13px] font-semibold text-text-primary truncate">{skill.name}</span>
                    <span className="shrink-0 px-1.5 py-0.5 text-[10px] rounded-md bg-surface-2 text-text-tertiary font-medium">Local</span>
                    {!skill.enabled && <Tag>Off</Tag>}
                  </div>
                  {skill.description && (
                    <p className="text-[11.5px] leading-snug text-text-tertiary mt-1 line-clamp-2">{skill.description}</p>
                  )}
                </div>
              </div>
              <div className="flex-1 min-h-3" />
              <div className="flex items-center justify-end gap-1.5 pt-3 border-t border-edge-subtle">
                <Toggle checked={skill.enabled} onChange={() => handleToggle(skill)} />
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(skill) }}
                  className="w-7 h-7 rounded-lg flex items-center justify-center text-text-tertiary hover:text-danger hover:bg-danger/8 transition-all"
                  title="Uninstall"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>

        {hasMore && (
          <div ref={sentinelRef} className="py-4 text-center text-[11.5px] text-text-tertiary">
            Loading more…
          </div>
        )}
        </>
      )}

      {detail && (
        <SkillDetailModal
          skill={detail}
          installed={findInstalled(detail.name)}
          installing={installing === `${detail.sourceId}:${detail.path}`}
          onClose={() => setDetail(null)}
          onInstall={() => handleInstall(detail)}
          onToggle={(s) => handleToggle(s)}
          onDelete={(s) => handleDelete(s)}
        />
      )}
    </div>
  )
}

// Neutral monochrome avatar with the skill's initial — stays within the app's single-accent palette.
const PAGE_SIZE = 30

// Mirrors the backend's sanitizeSkillName so the renderer matches the same installed-skill directory id.
function sanitizeSkillName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function SkillAvatar({ name, dimmed }: { name: string; dimmed?: boolean }) {
  const initial = (name.replace(/[^a-zA-Z0-9]/g, '')[0] || '?').toUpperCase()
  return (
    <div className={`shrink-0 w-9 h-9 rounded-lg bg-accent-muted flex items-center justify-center text-accent text-[14px] font-semibold ${dimmed ? 'opacity-50 grayscale' : ''}`}>
      {initial}
    </div>
  )
}

// Inline metadata chips — only render the ones that carry a real signal (risk, setup).
function SkillBadges({ skill }: { skill: BrowsableSkill }) {
  const risky = skill.risk === 'critical' || skill.risk === 'offensive'
  const needsSetup = !!skill.setup && skill.setup.type !== 'none'
  if (!risky && !needsSetup) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-2">
      {risky && (
        <span
          className="px-1.5 py-0.5 rounded-md text-[10px] font-medium bg-danger/10 text-danger inline-flex items-center gap-0.5"
          title={skill.risk === 'offensive' ? 'Offensive-security tooling — use responsibly' : 'High-impact skill — review before use'}
        >
          <AlertTriangle size={9} /> {skill.risk}
        </span>
      )}
      {needsSetup && (
        <span
          className="px-1.5 py-0.5 rounded-md text-[10px] font-medium bg-accent-subtle text-accent inline-flex items-center gap-0.5"
          title={skill.setup?.summary || 'Requires extra setup before use'}
        >
          <Sliders size={9} /> Setup
        </span>
      )}
    </div>
  )
}

// Full-detail modal: the place to actually understand a skill before installing.
function SkillDetailModal({ skill, installed, installing, onClose, onInstall, onToggle, onDelete }: {
  skill: BrowsableSkill
  installed?: Skill
  installing: boolean
  onClose: () => void
  onInstall: () => void
  onToggle: (s: Skill) => void
  onDelete: (s: Skill) => void
}) {
  const needsSetup = !!skill.setup && skill.setup.type !== 'none'
  const risky = skill.risk === 'critical' || skill.risk === 'offensive'
  // Turn a provenance string into a clickable link when it's a URL.
  const sourceUrl = skill.source && /^https?:\/\//.test(skill.source) ? skill.source : null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md max-h-[80vh] overflow-y-auto scrollbar-thin bg-surface-0 border border-edge rounded-2xl shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start gap-3 p-4 border-b border-edge-subtle">
          <SkillAvatar name={skill.name} />
          <div className="flex-1 min-w-0 pt-0.5">
            <h3 className="text-[15px] font-semibold text-text-primary break-words">{skill.name}</h3>
            {skill.category && <p className="text-[11.5px] text-text-tertiary capitalize mt-0.5">{skill.category}</p>}
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center text-text-tertiary hover:text-text-secondary hover:bg-surface-2 transition-colors shrink-0">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4">
          {/* Status / risk badges */}
          {(installed || risky) && (
            <div className="flex flex-wrap items-center gap-1.5">
              {installed && (
                <span className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-accent-muted text-accent inline-flex items-center gap-1">
                  <CheckCircle2 size={11} /> {installed.enabled ? 'Installed' : 'Installed · Off'}
                </span>
              )}
              {risky && (
                <span className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-danger/10 text-danger inline-flex items-center gap-1">
                  <AlertTriangle size={11} /> {skill.risk}
                </span>
              )}
            </div>
          )}

          {/* Full description */}
          {skill.description && (
            <div>
              <p className="text-[10.5px] font-medium text-text-tertiary uppercase tracking-wide mb-1">About</p>
              <p className="text-[12.5px] leading-relaxed text-text-secondary whitespace-pre-wrap">{skill.description}</p>
            </div>
          )}

          {/* Setup requirement */}
          {needsSetup && (
            <div className="rounded-lg bg-accent-subtle border border-accent/15 p-3">
              <p className="text-[11.5px] font-medium text-accent inline-flex items-center gap-1.5 mb-1"><Sliders size={12} /> Setup required</p>
              {skill.setup?.summary
                ? <p className="text-[12px] leading-relaxed text-text-secondary">{skill.setup.summary}</p>
                : <p className="text-[12px] text-text-tertiary">This skill needs extra configuration before it works.</p>}
              {skill.setup?.docs && (
                <a
                  href={skill.setup.docs}
                  onClick={e => { e.preventDefault(); window.open(skill.setup!.docs!) }}
                  className="text-[11.5px] text-accent hover:underline mt-1.5 inline-block"
                >
                  Setup docs →
                </a>
              )}
            </div>
          )}

          {/* Meta */}
          <div className="space-y-1.5 text-[11.5px]">
            {skill.source && (
              <div className="flex items-center gap-2">
                <span className="text-text-tertiary w-14 shrink-0">Source</span>
                {sourceUrl
                  ? <a href={sourceUrl} onClick={e => { e.preventDefault(); window.open(sourceUrl) }} className="text-accent hover:underline truncate">{skill.source.replace(/^https?:\/\//, '')}</a>
                  : <span className="text-text-secondary capitalize">{skill.source}</span>}
              </div>
            )}
            {skill.dateAdded && (
              <div className="flex items-center gap-2">
                <span className="text-text-tertiary w-14 shrink-0">Added</span>
                <span className="text-text-secondary">{skill.dateAdded}</span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <span className="text-text-tertiary w-14 shrink-0">Path</span>
              <span className="text-text-secondary font-mono text-[11px] truncate">{skill.path}</span>
            </div>
          </div>
        </div>

        {/* Footer actions */}
        <div className="flex items-center gap-2 p-4 border-t border-edge-subtle">
          {installed ? (
            <>
              <span className="text-[12px] text-text-tertiary">Enabled</span>
              <Toggle checked={installed.enabled} onChange={() => onToggle(installed)} />
              <button
                onClick={() => { onDelete(installed); onClose() }}
                className="ml-auto h-8 px-3 rounded-lg text-[12px] font-medium text-danger hover:bg-danger/8 transition-colors inline-flex items-center gap-1.5"
              >
                <Trash2 size={13} /> Uninstall
              </button>
            </>
          ) : (
            <button
              onClick={onInstall}
              disabled={installing}
              className="ml-auto h-8 px-4 rounded-lg text-[12.5px] font-medium bg-accent text-white hover:brightness-110 disabled:opacity-50 transition-all inline-flex items-center gap-1.5"
            >
              {installing ? 'Installing…' : <><Download size={13} /> Install</>}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════
   Memory Tab
   ═══════════════════════════════════════════ */

function MemoryTab() {
  const [l0, setL0] = useState('')
  const [l0Saved, setL0Saved] = useState(false)
  const [memories, setMemories] = useState<MemoryEntry[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    window.aide.memory.getL0().then(setL0)
    loadMemories()
  }, [])

  const loadMemories = async () => {
    setLoading(true)
    const list = await window.aide.memory.list({ layer: ['L1', 'L2'], status: 'active' })
    setMemories(list)
    setLoading(false)
  }

  const saveL0 = async () => {
    await window.aide.memory.setL0(l0)
    setL0Saved(true)
    setTimeout(() => setL0Saved(false), 2000)
  }

  return (
    <div className="space-y-6">
      {/* L0 */}
      <section className="space-y-3">
        <SectionLabel
          title="Identity"
          desc="A few core facts about who you are. Aide always keeps these in mind."
          meta={`${l0.length}/1000`}
        />
        <textarea
          value={l0}
          onChange={e => setL0(e.target.value)}
          className="w-full h-24 bg-surface-0 border border-edge rounded-xl p-3 text-[13px] text-text-primary placeholder:text-text-tertiary resize-none outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20 transition-all leading-relaxed"
          placeholder={"I'm Jane Doe, a senior frontend engineer at ABC Inc.\nI mainly work on the Web App."}
          maxLength={1000}
        />
        <div className="flex justify-end mt-2">
          <Btn onClick={saveL0}>
            {l0Saved ? <><Check size={12} /> Saved</> : <><Save size={12} /> Save</>}
          </Btn>
        </div>
      </section>

      {/* L1/L2 */}
      <section className="space-y-3">
        <SectionLabel
          title="Learned"
          desc="What Aide has learned about you as you work together."
          meta={`${memories.length} items`}
        />

        {loading ? (
          <div className="text-[12px] text-text-tertiary text-center py-8">Loading…</div>
        ) : memories.length === 0 ? (
          <Empty>No memories yet. They grow as you use Aide.</Empty>
        ) : (
          <div className="space-y-1.5 max-h-[360px] overflow-y-auto scrollbar-thin">
            {memories.map(m => (
              <div key={m.id} className="group p-3 rounded-lg bg-surface-0 border border-edge hover:border-edge transition-colors">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-[12px] text-text-secondary leading-relaxed">{m.content}</p>
                    <div className="flex items-center gap-2 mt-1.5 text-[11px] text-text-tertiary">
                      <Tag>{m.layer}</Tag>
                      <span>{new Date(m.createdAt).toLocaleDateString('en-US')}</span>
                      {m.tags.length > 0 && <span>{m.tags.join(', ')}</span>}
                      {m.recallCount > 0 && <span>Recalled {m.recallCount} times</span>}
                    </div>
                  </div>
                  <button onClick={() => { if (confirm('Delete this memory? This cannot be undone.')) { window.aide.memory.delete(m.id); setMemories(prev => prev.filter(x => x.id !== m.id)) } }} className="w-6 h-6 rounded-md flex items-center justify-center text-text-tertiary hover:text-danger hover:bg-danger/8 opacity-0 group-hover:opacity-100 transition-all shrink-0" title="Delete">
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

/* ═══════════════════════════════════════════
   Preferences Tab
   ═══════════════════════════════════════════ */

function PreferencesTab() {
  const { preferences, fetchPreferences, setPreferences } = useSettingsStore()

  useEffect(() => { fetchPreferences() }, [])

  if (!preferences) return <div className="text-[12px] text-text-tertiary text-center py-8">Loading…</div>

  return (
    <div className="space-y-4">
      <Desc>Fine-tune how Aide behaves.</Desc>

      <SettingRow label="Autonomy level" description="Decide when Aide should check with you before acting">
        <Select value={preferences.autonomyLevel} onChange={v => setPreferences({ autonomyLevel: v as any })} options={[
          { value: 'default', label: 'Default — Aide acts on its own' },
          { value: 'confirm', label: 'Confirm first — ask me before every action' },
        ]} />
      </SettingRow>

      <SettingRow label="System notifications" description="Get notified about high-priority tasks">
        <Toggle checked={preferences.systemNotifications} onChange={v => setPreferences({ systemNotifications: v })} />
      </SettingRow>

      <UpdatesSection />
    </div>
  )
}

/* ═══════════════════════════════════════════
   Updates / About
   ═══════════════════════════════════════════ */

function UpdatesSection() {
  const [state, setState] = useState<UpdateState | null>(null)

  useEffect(() => {
    window.aide.updates.getState().then(setState)
    const unsub = window.aideEvents.on((event: any) => {
      if (event.type === 'update:state') setState(event.state)
    })
    return unsub
  }, [])

  if (!state) return null

  const busy = state.status === 'checking' || state.status === 'downloading'

  const check = () => window.aide.updates.check().then(setState)
  const install = () => {
    // Optimistically reflect the restart immediately — quitAndInstall can take a
    // moment to spin up, and without instant feedback the button feels frozen.
    setState(s => (s ? { ...s, status: 'installing' } : s))
    window.aide.updates.install()
  }
  const retryDownload = () => window.aide.updates.download().then(setState)

  return (
    <div className="mt-6 pt-5 border-t border-edge">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[12.5px] font-medium text-text-primary">About &amp; updates</div>
          <div className="text-[11.5px] text-text-tertiary mt-0.5">Version {state.currentVersion}</div>
        </div>
        {state.supported && state.status !== 'downloaded' && (
          <button
            onClick={check}
            disabled={busy}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium text-text-secondary bg-surface-2 hover:bg-surface-3 disabled:opacity-50 transition-colors"
          >
            <RefreshCw size={12} className={busy ? 'animate-spin' : ''} />
            {state.status === 'checking' ? 'Checking…' : 'Check for updates'}
          </button>
        )}
      </div>

      {state.supported ? (
        <UpdateStatusLine state={state} onInstall={install} onRetry={retryDownload} />
      ) : (
        <div className="mt-3 text-[11.5px] text-text-tertiary">
          Update checks run automatically in the installed app. They're unavailable in this development build.
        </div>
      )}
    </div>
  )
}

function UpdateStatusLine({ state, onInstall, onRetry }: { state: UpdateState; onInstall: () => void; onRetry: () => void }) {
  if (state.status === 'not-available') {
    return (
      <div className="flex items-center gap-1.5 mt-3 text-[11.5px] text-text-tertiary">
        <CheckCircle2 size={13} className="text-emerald-500" />
        You're on the latest version.
      </div>
    )
  }

  if (state.status === 'available' || state.status === 'downloading') {
    return (
      <div className="mt-3">
        <div className="flex items-center justify-between text-[11.5px] text-text-secondary">
          <span>Downloading version {state.latestVersion}…</span>
          <span className="text-text-tertiary">{state.progressPercent ?? 0}%</span>
        </div>
        <div className="mt-1.5 h-1 rounded-full bg-surface-2 overflow-hidden">
          <div className="h-full bg-accent transition-all duration-300" style={{ width: `${state.progressPercent ?? 0}%` }} />
        </div>
      </div>
    )
  }

  if (state.status === 'downloaded' || state.status === 'installing') {
    const installing = state.status === 'installing'
    return (
      <div className="flex items-center justify-between mt-3">
        <div className="flex items-center gap-1.5 text-[11.5px] text-text-secondary">
          <Download size={13} className="text-accent" />
          {installing ? 'Restarting to install…' : `Version ${state.latestVersion} is ready.`}
        </div>
        <button
          onClick={onInstall}
          disabled={installing}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium text-white bg-accent hover:opacity-90 disabled:opacity-60 transition-opacity"
        >
          {installing && <RefreshCw size={12} className="animate-spin" />}
          {installing ? 'Restarting…' : 'Restart & install'}
        </button>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="flex items-center justify-between mt-3">
        <div className="flex items-center gap-1.5 text-[11.5px] text-red-500 min-w-0">
          <AlertCircle size={13} className="shrink-0" />
          <span className="truncate">{state.error || 'Update check failed.'}</span>
        </div>
        <button onClick={onRetry} className="shrink-0 ml-3 px-3 py-1.5 rounded-md text-[12px] font-medium text-text-secondary bg-surface-2 hover:bg-surface-3 transition-colors">
          Retry
        </button>
      </div>
    )
  }

  return null
}

/* ═══════════════════════════════════════════
   Shared Components
   ═══════════════════════════════════════════ */

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`p-4 rounded-xl bg-surface-0 border border-edge ${className}`}>{children}</div>
}

function FormCard({ children }: { children: React.ReactNode }) {
  return <div className="p-4 rounded-xl bg-surface-2 border border-edge space-y-2.5 anim-fade-up">{children}</div>
}

function FormHint({ children }: { children: string }) {
  return <p className="text-[11px] text-text-tertiary/80 leading-relaxed">{children}</p>
}

function Desc({ children }: { children: string }) {
  return <p className="text-[12px] text-text-tertiary leading-relaxed">{children}</p>
}

function SectionLabel({ title, desc, meta }: { title: string; desc?: string; meta?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <p className="text-[12px] font-semibold text-text-secondary">{title}</p>
        {desc && <p className="text-[12px] text-text-tertiary leading-relaxed mt-0.5">{desc}</p>}
      </div>
      {meta != null && <span className="text-[11px] text-text-tertiary tabular-nums shrink-0 mt-0.5">{meta}</span>}
    </div>
  )
}

function Empty({ children }: { children: string }) {
  return (
    <div className="flex flex-col items-center py-10">
      <div className="w-8 h-8 rounded-full bg-surface-2 flex items-center justify-center mb-2">
        <FolderOpen size={14} className="text-text-tertiary" />
      </div>
      <span className="text-[12px] text-text-tertiary">{children}</span>
    </div>
  )
}

function Btn({ children, onClick, variant, disabled }: { children: React.ReactNode; onClick?: () => void; variant?: 'danger'; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`h-7 px-3 rounded-lg text-[12px] font-medium inline-flex items-center gap-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
        variant === 'danger'
          ? 'bg-danger/10 text-danger hover:bg-danger/15 border border-danger/15'
          : 'bg-surface-2 text-text-secondary hover:bg-surface-3 border border-edge'
      }`}
    >
      {children}
    </button>
  )
}

function Field({ label, value, onChange, placeholder, required, multiline, type = 'text' }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; required?: boolean; multiline?: boolean; type?: string
}) {
  const cls = "w-full bg-surface-0 border border-edge rounded-lg px-3 py-[7px] text-[13px] text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20 transition-all"
  return (
    <div>
      <label className="text-[11px] text-text-tertiary font-medium block mb-1">{label}{required && ' *'}</label>
      {multiline ? (
        <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} className={`${cls} resize-none h-[72px] leading-relaxed`} />
      ) : (
        <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} className={cls} />
      )}
    </div>
  )
}

function FormActions({ onSave, onCancel, onDelete, disabled }: { onSave: () => void; onCancel: () => void; onDelete?: () => Promise<void>; disabled?: boolean }) {
  return (
    <div className="flex items-center gap-2 pt-1">
      <button onClick={onSave} disabled={disabled} className="h-7 px-3 rounded-lg text-[12px] font-medium bg-accent text-white hover:brightness-110 disabled:opacity-30 disabled:hover:brightness-100 transition-all inline-flex items-center gap-1.5">
        <Check size={12} /> Save
      </button>
      <button onClick={onCancel} className="h-7 px-3 rounded-lg text-[12px] text-text-tertiary hover:text-text-secondary transition-colors">Cancel</button>
      {onDelete && (
        <button onClick={onDelete} className="h-7 px-3 rounded-lg text-[12px] text-danger/70 hover:text-danger hover:bg-danger/8 transition-colors ml-auto inline-flex items-center gap-1.5">
          <Trash2 size={12} /> Delete
        </button>
      )}
    </div>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!checked)} className={`relative w-9 h-[22px] rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-surface-3'}`}>
      <div className={`absolute top-[3px] w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${checked ? 'left-[19px]' : 'left-[3px]'}`} />
    </button>
  )
}

function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }> }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="bg-surface-0 border border-edge rounded-lg px-3 py-[6px] text-[13px] text-text-primary outline-none focus:border-accent/50 transition-colors appearance-none pr-8 min-w-[160px]"
      style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23666' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center' }}
    >
      {options.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
    </select>
  )
}

function SettingRow({ label, description, children }: { label: string; description: string; children: React.ReactNode }) {
  return (
    <Card>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[13px] font-medium text-text-primary">{label}</p>
          <p className="text-[11px] text-text-tertiary mt-0.5">{description}</p>
        </div>
        {children}
      </div>
    </Card>
  )
}

function Tag({ children }: { children: string }) {
  return <span className="text-[11px] px-1.5 py-[1px] rounded-md bg-surface-2 text-text-tertiary border border-edge-subtle">{children}</span>
}

function RoleBadge({ role }: { role: string }) {
  const styles: Record<string, string> = {
    manager: 'bg-purple-500/10 text-purple-400 border-purple-500/15',
    peer: 'bg-surface-2 text-text-tertiary border-edge',
    report: 'bg-blue-500/10 text-blue-400 border-blue-500/15',
    external: 'bg-warning/10 text-warning border-warning/15',
    stakeholder: 'bg-success/10 text-success border-success/15'
  }
  const labels: Record<string, string> = { manager: 'Manager', peer: 'Peer', report: 'Report', external: 'External', stakeholder: 'Stakeholder' }
  return <span className={`text-[11px] px-1.5 py-[1px] rounded-md font-medium border ${styles[role] || styles.peer}`}>{labels[role] || role}</span>
}

function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return cron

  const [min, hour, dom, , dow] = parts

  // Normalize weekday detection: '1-5' or '1,2,3,4,5' both count as workdays
  const isWorkdays = dow === '1-5' || dow === '1,2,3,4,5'
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  let dayLabel = ''
  if (isWorkdays) {
    dayLabel = 'Weekdays'
  } else if (dow !== '*') {
    const days = dow.split(',').map(d => dayNames[parseInt(d)] || d).join('/')
    dayLabel = days
  }

  // Every N minutes
  if (min.startsWith('*/')) {
    const n = min.slice(2)
    return `Every ${n} min`
  }

  // Monthly (day-of-month specified)
  if (dom !== '*') {
    const time = `${hour}:${min.padStart(2, '0')}`
    return `Day ${dom} monthly at ${time}`
  }

  // Every hour
  if (min === '0' && hour === '*') return 'Hourly on the hour'
  // Specific hours
  if (min === '0' && hour !== '*') {
    const hours = hour.split(',').map(h => `${h}:00`)
    const prefix = dayLabel ? `${dayLabel} ` : 'Daily '
    return `${prefix}${hours.join(' and ')}`
  }
  // Specific minute and hour
  if (hour !== '*' && min !== '*') {
    const prefix = dayLabel ? `${dayLabel} ` : 'Daily '
    return `${prefix}${hour}:${min.padStart(2, '0')}`
  }
  return cron
}
