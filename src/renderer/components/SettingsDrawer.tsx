import React, { useEffect, useState } from 'react'
import { X, Link2, FolderOpen, Users, Timer, Brain, Sliders, Trash2, Plus, Save, Check, Github } from 'lucide-react'
import { useSettingsStore } from '../stores/settingsStore'
import type { Project, Relation, Job, ConnectionStatus, MemoryEntry } from '@shared/types'

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
  const { isOpen, activeTab, close, setTab, projects, relations, jobs, connections,
    fetchProjects, fetchRelations, fetchJobs, fetchConnections } = useSettingsStore()

  useEffect(() => {
    if (isOpen) { fetchProjects(); fetchRelations(); fetchJobs(); fetchConnections() }
  }, [isOpen])

  if (!isOpen) return null

  const tabs: Array<{ id: typeof activeTab; label: string; icon: React.ReactNode }> = [
    { id: 'connections', label: '连接', icon: <Link2 size={14} /> },
    { id: 'jobs', label: '定时任务', icon: <Timer size={14} /> },
    { id: 'projects', label: '项目', icon: <FolderOpen size={14} /> },
    { id: 'relations', label: '联系人', icon: <Users size={14} /> },
    { id: 'memory', label: '记忆', icon: <Brain size={14} /> },
    { id: 'preferences', label: '偏好', icon: <Sliders size={14} /> },
  ]

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={close} />

      {/* Panel */}
      <div className="absolute right-0 top-0 bottom-0 w-[540px] max-w-[92vw] bg-surface-1 border-l border-edge shadow-2xl flex flex-col anim-slide-in">
        {/* Header */}
        <div className="shrink-0 bg-surface-0">
          <div className="flex items-center justify-between pl-5 pr-5 h-[52px]">
            <h2 className="text-[13px] font-semibold text-text-primary">设置</h2>
            <button onClick={close} className="w-7 h-7 rounded-md flex items-center justify-center text-text-tertiary hover:text-text-secondary hover:bg-surface-2 transition-colors">
              <X size={15} strokeWidth={2} />
            </button>
          </div>
          <div className="h-px bg-edge" />
        </div>

        {/* Tabs */}
        <nav className="flex border-b border-edge px-5 gap-1 shrink-0">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setTab(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-2.5 text-[12px] font-medium transition-colors border-b-2 -mb-px ${
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
          {activeTab === 'relations' && <RelationsTab relations={relations} onRefresh={fetchRelations} />}
          {activeTab === 'jobs' && <JobsTab jobs={jobs} onRefresh={fetchJobs} />}
          {activeTab === 'memory' && <MemoryTab />}
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

  return (
    <div className="space-y-4">
      <Desc>管理与外部服务的连接，Aide 通过这些连接获取邮件、日历等信息。</Desc>

      {connections.map(conn => (
        <Card key={conn.id}>
          <div className="flex items-start justify-between">
            <div className="flex items-start gap-3">
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                conn.type === 'workiq' ? 'bg-blue-500/10 text-blue-400' : 'bg-zinc-500/10 text-text-secondary'
              }`}>
                {conn.type === 'workiq' ? <MicrosoftIcon /> : <Github size={18} />}
              </div>
              <div>
                <p className="text-[13px] font-medium text-text-primary">
                  {conn.type === 'workiq' ? 'Microsoft 365' : 'GitHub'}
                </p>
                <p className="text-[12px] text-text-tertiary mt-0.5">
                  {conn.type === 'workiq' ? '邮件 · 日历 · Teams · OneDrive' : 'Issues · Pull Requests · Repos'}
                </p>
                <div className="flex items-center gap-1.5 mt-1.5">
                  <div className={`w-[6px] h-[6px] rounded-full ${
                    conn.verified ? 'bg-success' : conn.authenticated ? 'bg-warning' : 'bg-text-tertiary'
                  }`} />
                  <span className={`text-[11px] ${
                    conn.verified ? 'text-success' : conn.authenticated ? 'text-warning' : 'text-text-tertiary'
                  }`}>
                    {conn.verified ? '已连接' : conn.authenticated ? '已登录 · 权限待验证' : '未连接'}
                  </span>
                </div>
                {conn.lastError && <p className="text-[11px] text-danger mt-1">{conn.lastError}</p>}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {conn.authenticated && (
                <Btn variant="danger" onClick={() => disconnect(conn.type)}>断开</Btn>
              )}
              <Btn onClick={() => conn.type === 'github' ? window.aide.connections.authenticateGitHub() : window.aide.connections.authenticateMicrosoft()}>
                {conn.authenticated ? '重新授权' : '连接'}
              </Btn>
            </div>
          </div>
        </Card>
      ))}


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
        <Desc>管理关注的项目，Agent 会据此提供更精准的帮助。</Desc>
        <Btn onClick={() => setAdding(true)}><Plus size={12} /> 添加</Btn>
      </div>

      {adding && (
        <ProjectForm
          onSave={async (data) => { await window.aide.projects.create(data); setAdding(false); onRefresh() }}
          onCancel={() => setAdding(false)}
        />
      )}

      {projects.length === 0 && !adding && <Empty>暂无项目，点击上方「添加」开始。</Empty>}

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
              编辑
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
  const [docsPath, setDocsPath] = useState(initial?.docsPath || '')
  const [techStack, setTechStack] = useState(initial?.techStack || '')
  const [team, setTeam] = useState((initial?.team || []).join(', '))
  const [notes, setNotes] = useState(initial?.notes || '')

  return (
    <FormCard>
      <Field label="名称" value={name} onChange={setName} placeholder="项目名称" required />
      <Field label="描述" value={description} onChange={setDescription} placeholder="简介（可选）" multiline />
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="仓库" value={repoPath} onChange={setRepoPath} placeholder="路径或 owner/repo" />
        <Field label="文档" value={docsPath} onChange={setDocsPath} placeholder="路径或 URL" />
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="技术栈" value={techStack} onChange={setTechStack} placeholder="React, TS, Node" />
        <Field label="团队" value={team} onChange={setTeam} placeholder="逗号分隔" />
      </div>
      <Field label="备注" value={notes} onChange={setNotes} placeholder="其他 Agent 需了解的信息" multiline />
      <FormActions
        onSave={() => onSave({ name, description, repoPath: repoPath || undefined, docsPath: docsPath || undefined, techStack: techStack || undefined, team: team ? team.split(',').map(s => s.trim()).filter(Boolean) : [], notes: notes || undefined })}
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
        <Desc>工作联系人，Agent 据此判断消息优先级与协作关系。</Desc>
        <Btn onClick={() => setAdding(true)}><Plus size={12} /> 添加</Btn>
      </div>

      {adding && (
        <RelationForm onSave={async (data) => { await window.aide.relations.create(data); setAdding(false); onRefresh() }} onCancel={() => setAdding(false)} />
      )}

      {relations.length === 0 && !adding && <Empty>暂无关系人。</Empty>}

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
                {[r.title, r.org].filter(Boolean).join(' · ') || '未设置'}
              </p>
              {r.expertise.length > 0 && (
                <div className="flex gap-1 mt-1.5 flex-wrap">
                  {r.expertise.map((e, i) => <Tag key={i}>{e}</Tag>)}
                </div>
              )}
            </div>
            <button onClick={() => setEditId(r.id)} className="text-[12px] text-text-tertiary hover:text-text-secondary opacity-0 group-hover:opacity-100 transition-all">编辑</button>
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
  const [org, setOrg] = useState(initial?.org || '')
  const [title, setTitle] = useState(initial?.title || '')
  const [email, setEmail] = useState(initial?.email || '')
  const [teamsId, setTeamsId] = useState(initial?.teamsId || '')
  const [timezone, setTimezone] = useState(initial?.timezone || '')
  const [expertise, setExpertise] = useState((initial?.expertise || []).join(', '))
  const [communicationStyle, setCommunicationStyle] = useState(initial?.communicationStyle || '')
  const [notes, setNotes] = useState(initial?.notes || '')

  return (
    <FormCard>
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="姓名" value={name} onChange={setName} placeholder="姓名" required />
        <div>
          <label className="text-[11px] text-text-tertiary font-medium block mb-1">角色</label>
          <select value={role} onChange={e => setRole(e.target.value)} className="w-full bg-surface-0 border border-edge rounded-lg px-2.5 py-[7px] text-[13px] text-text-primary outline-none focus:border-accent/50 transition-colors appearance-none">
            <option value="manager">上级</option>
            <option value="peer">同事</option>
            <option value="report">下属</option>
            <option value="external">外部</option>
            <option value="stakeholder">利益相关方</option>
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="组织" value={org} onChange={setOrg} placeholder="部门或公司" />
        <Field label="职位" value={title} onChange={setTitle} placeholder="职位" />
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="Email" value={email} onChange={setEmail} placeholder="name@company.com" />
        <Field label="Teams ID" value={teamsId} onChange={setTeamsId} placeholder="user@tenant" />
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="时区" value={timezone} onChange={setTimezone} placeholder="Asia/Shanghai" />
        <Field label="专长" value={expertise} onChange={setExpertise} placeholder="逗号分隔" />
      </div>
      <Field label="沟通风格" value={communicationStyle} onChange={setCommunicationStyle} placeholder="偏好的沟通方式" />
      <Field label="备注" value={notes} onChange={setNotes} placeholder="其他信息" multiline />
      <FormActions
        onSave={() => onSave({ name, role, org: org || undefined, title: title || undefined, email: email || undefined, teamsId: teamsId || undefined, timezone: timezone || undefined, expertise: expertise ? expertise.split(',').map(s => s.trim()).filter(Boolean) : [], communicationStyle: communicationStyle || undefined, notes: notes || undefined })}
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
        <Desc>定时任务由 Agent 按计划自动执行，用于周期性信息收集与处理。</Desc>
        <Btn onClick={() => { setAdding(true); setEditId(null) }}><Plus size={12} /> 新建</Btn>
      </div>

      {adding && (
        <JobForm
          onSave={async (data) => { await window.aide.jobs.create(data); setAdding(false); onRefresh() }}
          onCancel={() => setAdding(false)}
        />
      )}

      {jobs.length === 0 && !adding && <Empty>暂无定时任务，点击上方「新建」创建。</Empty>}

      {jobs.map(job => editId === job.id ? (
        <JobForm
          key={job.id}
          initial={job}
          onSave={async (data) => { await window.aide.jobs.update(job.id, data); setEditId(null); onRefresh() }}
          onCancel={() => setEditId(null)}
          onDelete={async () => { await window.aide.jobs.delete(job.id); setEditId(null); onRefresh() }}
        />
      ) : (
        <Card key={job.id} className="group">
          <div className="flex items-center justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-[13px] font-medium text-text-primary truncate">{job.name}</p>
                {job.lastResult && (
                  <div className={`w-[6px] h-[6px] rounded-full shrink-0 ${job.lastResult === 'success' ? 'bg-success' : 'bg-danger'}`} />
                )}
              </div>
              <p className="text-[11px] text-text-tertiary mt-0.5">{describeCron(job.cron)}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => setEditId(job.id)} className="text-[12px] text-text-tertiary hover:text-text-secondary opacity-0 group-hover:opacity-100 transition-all">
                编辑
              </button>
              <Toggle checked={job.enabled} onChange={async v => { await window.aide.jobs.toggle(job.id, v); onRefresh() }} />
            </div>
          </div>

          {/* Instruction preview */}
          <p className="text-[12px] text-text-tertiary mt-1.5 line-clamp-1">{job.instruction}</p>

          {/* Last run info */}
          {job.lastRunAt && (
            <div className="mt-2.5 pt-2.5 border-t border-edge-subtle">
              <div className="flex items-center gap-2">
                <span className={`text-[11px] ${job.lastResult === 'success' ? 'text-success' : 'text-danger'}`}>
                  {job.lastResult === 'success' ? '上次成功' : '上次失败'}
                </span>
                <span className="text-[11px] text-text-tertiary">{formatRelativeTime(job.lastRunAt)}</span>
                {job.lastSummary && (
                  <button onClick={() => setExpandedId(expandedId === job.id ? null : job.id)} className="text-[11px] text-text-tertiary hover:text-text-secondary transition-colors ml-auto">
                    {expandedId === job.id ? '收起' : '详情'}
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

function JobForm({ initial, onSave, onCancel, onDelete }: {
  initial?: Partial<Job>; onSave: (data: { name: string; cron: string; instruction: string }) => Promise<void>; onCancel: () => void; onDelete?: () => Promise<void>
}) {
  const [name, setName] = useState(initial?.name || '')
  const [instruction, setInstruction] = useState(initial?.instruction || '')

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

  const dayNames = ['一', '二', '三', '四', '五', '六', '日']
  const toggleDay = (d: number) => setWeekdays(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d].sort())

  return (
    <FormCard>
      <Field label="任务名称" value={name} onChange={setName} placeholder="例：检查未读邮件" required />

      <div>
        <label className="text-[11px] text-text-tertiary font-medium block mb-1.5">执行频率</label>
        <div className="flex items-center gap-2 flex-wrap">
          <select value={schedType} onChange={e => setSchedType(e.target.value as any)} className={selectCls} style={selectStyle}>
            <option value="interval">每隔</option>
            <option value="daily">每天</option>
            <option value="weekly">每周</option>
            <option value="monthly">每月</option>
          </select>

          {schedType === 'interval' && (
            <>
              <select value={interval} onChange={e => setInterval(+e.target.value)} className={`${selectCls} w-[80px]`} style={selectStyle}>
                {[5, 10, 15, 20, 30, 60].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
              <span className="text-[13px] text-text-secondary">分钟</span>
            </>
          )}

          {(schedType === 'daily' || schedType === 'weekly' || schedType === 'monthly') && (
            <>
              {schedType === 'monthly' && (
                <>
                  <select value={monthDay} onChange={e => setMonthDay(+e.target.value)} className={`${selectCls} w-[72px]`} style={selectStyle}>
                    {Array.from({ length: 28 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
                  </select>
                  <span className="text-[13px] text-text-secondary">日</span>
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

      <Field label="指令" value={instruction} onChange={setInstruction} placeholder="告诉 Agent 要做什么，例：检查我的未读邮件，如果有紧急的就提醒我" required multiline />
      <FormActions onSave={() => onSave({ name, cron, instruction })} onCancel={onCancel} onDelete={onDelete} disabled={!name.trim() || !cron.trim() || !instruction.trim()} />
    </FormCard>
  )
}

function parseCronToSchedule(cron: string) {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return { type: 'interval' as const, interval: 15, hour: 9, minute: 0, weekdays: [1, 2, 3, 4, 5], monthDay: 1 }

  const [min, hr, dom, , dow] = parts

  // */N pattern
  if (min.startsWith('*/')) {
    return { type: 'interval' as const, interval: parseInt(min.slice(2)) || 15, hour: 9, minute: 0, weekdays: [1, 2, 3, 4, 5], monthDay: 1 }
  }

  const hour = hr === '*' ? 9 : parseInt(hr.split(',')[0]) || 0
  const minute = min === '*' ? 0 : parseInt(min) || 0

  // Monthly
  if (dom !== '*') {
    return { type: 'monthly' as const, interval: 15, hour, minute, weekdays: [1, 2, 3, 4, 5], monthDay: parseInt(dom) || 1 }
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
    return { type: 'weekly' as const, interval: 15, hour, minute, weekdays: weekdays.length ? weekdays : [1, 2, 3, 4, 5], monthDay: 1 }
  }

  // Daily
  return { type: 'daily' as const, interval: 15, hour, minute, weekdays: [1, 2, 3, 4, 5], monthDay: 1 }
}

function buildCron(type: string, interval: number, hour: number, minute: number, weekdays: number[], monthDay: number): string {
  switch (type) {
    case 'interval': return `*/${interval} * * * *`
    case 'daily': return `${minute} ${hour} * * *`
    case 'weekly': return `${minute} ${hour} * * ${weekdays.length ? weekdays.join(',') : '1-5'}`
    case 'monthly': return `${minute} ${hour} ${monthDay} * *`
    default: return '*/15 * * * *'
  }
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} 小时前`
  const days = Math.floor(hrs / 24)
  return `${days} 天前`
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
      <div>
        <div className="flex items-center justify-between mb-2">
          <div>
            <p className="text-[13px] font-medium text-text-primary">身份记忆</p>
            <p className="text-[11px] text-text-tertiary mt-0.5">始终注入对话上下文的核心信息</p>
          </div>
          <span className="text-[11px] text-text-tertiary tabular-nums">{l0.length}/8000</span>
        </div>
        <textarea
          value={l0}
          onChange={e => setL0(e.target.value)}
          className="w-full h-40 bg-surface-0 border border-edge rounded-xl p-3 text-[13px] text-text-primary placeholder:text-text-tertiary resize-none outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20 transition-all leading-relaxed"
          placeholder={"我是张三，在 ABC 公司担任高级前端工程师。\n我的上级是李四 (Engineering Manager)。\n我主要负责 Web App 项目，使用 React + TypeScript。"}
          maxLength={8000}
        />
        <div className="flex justify-end mt-2">
          <Btn onClick={saveL0}>
            {l0Saved ? <><Check size={12} /> 已保存</> : <><Save size={12} /> 保存</>}
          </Btn>
        </div>
      </div>

      {/* L1/L2 */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div>
            <p className="text-[13px] font-medium text-text-primary">学习记忆</p>
            <p className="text-[11px] text-text-tertiary mt-0.5">Agent 从交互中自动积累的知识</p>
          </div>
          <span className="text-[11px] text-text-tertiary">{memories.length} 条</span>
        </div>

        {loading ? (
          <div className="text-[12px] text-text-tertiary text-center py-8">加载中…</div>
        ) : memories.length === 0 ? (
          <Empty>尚未积累记忆，随使用逐渐增长。</Empty>
        ) : (
          <div className="space-y-1.5 max-h-[360px] overflow-y-auto scrollbar-thin">
            {memories.map(m => (
              <div key={m.id} className="group p-3 rounded-lg bg-surface-0 border border-edge hover:border-edge transition-colors">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-[12px] text-text-secondary leading-relaxed">{m.content}</p>
                    <div className="flex items-center gap-2 mt-1.5 text-[11px] text-text-tertiary">
                      <Tag>{m.layer}</Tag>
                      <span>{new Date(m.createdAt).toLocaleDateString('zh-CN')}</span>
                      {m.tags.length > 0 && <span>{m.tags.join(', ')}</span>}
                      {m.recallCount > 0 && <span>被引用 {m.recallCount} 次</span>}
                    </div>
                  </div>
                  <button onClick={() => { if (confirm('确定删除这条记忆？此操作不可撤销。')) { window.aide.memory.delete(m.id); setMemories(prev => prev.filter(x => x.id !== m.id)) } }} className="w-6 h-6 rounded-md flex items-center justify-center text-text-tertiary hover:text-danger hover:bg-danger/8 opacity-0 group-hover:opacity-100 transition-all shrink-0" title="删除">
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════
   Preferences Tab
   ═══════════════════════════════════════════ */

function PreferencesTab() {
  const { preferences, fetchPreferences, setPreferences } = useSettingsStore()

  useEffect(() => { fetchPreferences() }, [])

  if (!preferences) return <div className="text-[12px] text-text-tertiary text-center py-8">加载中…</div>

  return (
    <div className="space-y-4">
      <Desc>应用行为偏好。</Desc>

      <SettingRow label="语言" description="Agent 回复语言">
        <Select value={preferences.language} onChange={v => setPreferences({ language: v as any })} options={[
          { value: 'zh-CN', label: '中文' },
          { value: 'en', label: 'English' },
        ]} />
      </SettingRow>

      <SettingRow label="自主级别" description="操作前是否需要确认">
        <Select value={preferences.autonomyLevel} onChange={v => setPreferences({ autonomyLevel: v as any })} options={[
          { value: 'default', label: '默认 — 写操作确认' },
          { value: 'auto', label: '全自动 — 仅危险确认' },
          { value: 'confirm', label: '全确认' },
        ]} />
      </SettingRow>

      <SettingRow label="系统通知" description="高优先级任务弹出通知">
        <Toggle checked={preferences.systemNotifications} onChange={v => setPreferences({ systemNotifications: v })} />
      </SettingRow>

      <SettingRow label="任务列表上限" description="侧边栏显示条数">
        <Select value={String(preferences.activeTaskCap)} onChange={v => setPreferences({ activeTaskCap: Number(v) })} options={[
          { value: '10', label: '10' },
          { value: '15', label: '15' },
          { value: '20', label: '20' },
          { value: '30', label: '30' },
        ]} />
      </SettingRow>
    </div>
  )
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

function Desc({ children }: { children: string }) {
  return <p className="text-[12px] text-text-tertiary leading-relaxed">{children}</p>
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

function Btn({ children, onClick, variant }: { children: React.ReactNode; onClick?: () => void; variant?: 'danger' }) {
  return (
    <button
      onClick={onClick}
      className={`h-7 px-3 rounded-lg text-[12px] font-medium inline-flex items-center gap-1.5 transition-colors ${
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
        <Check size={12} /> 保存
      </button>
      <button onClick={onCancel} className="h-7 px-3 rounded-lg text-[12px] text-text-tertiary hover:text-text-secondary transition-colors">取消</button>
      {onDelete && (
        <button onClick={onDelete} className="h-7 px-3 rounded-lg text-[12px] text-danger/70 hover:text-danger hover:bg-danger/8 transition-colors ml-auto inline-flex items-center gap-1.5">
          <Trash2 size={12} /> 删除
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
  const labels: Record<string, string> = { manager: '上级', peer: '同事', report: '下属', external: '外部', stakeholder: '相关方' }
  return <span className={`text-[11px] px-1.5 py-[1px] rounded-md font-medium border ${styles[role] || styles.peer}`}>{labels[role] || role}</span>
}

function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return cron

  const [min, hour, , , dow] = parts
  const isWorkdays = dow === '1-5'
  const dayLabel = isWorkdays ? '工作日' : dow === '*' ? '' : `周${dow}`

  // Every N minutes
  if (min.startsWith('*/')) {
    const n = min.slice(2)
    return `每 ${n} 分钟`
  }
  // Every hour
  if (min === '0' && hour === '*') return '每小时整点'
  // Specific hours
  if (min === '0' && hour !== '*') {
    const hours = hour.split(',').map(h => `${h}:00`)
    const prefix = dayLabel ? `${dayLabel} ` : '每天 '
    return `${prefix}${hours.join(' 和 ')}`
  }
  // Specific minute and hour
  if (hour !== '*' && min !== '*') {
    const prefix = dayLabel ? `${dayLabel} ` : '每天 '
    return `${prefix}${hour}:${min.padStart(2, '0')}`
  }
  return cron
}
