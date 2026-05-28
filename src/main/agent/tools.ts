import { writeMemory, searchMemory, updateMemory, markMemoryInactive } from '../memory'
import { createTask, updateTask, listTasks } from '../tasks'
import { listProjects, createProject, updateProject, deleteProject } from '../projects'
import { listRelations, createRelation, updateRelation, deleteRelation } from '../relations'
import { getPreferences, setPreferences } from '../preferences'
import { listJobs, createJob, updateJob, deleteJob, toggleJob } from '../jobs'
import { showSystemNotification } from '../index'
import { isJobSession, jobCreatedTaskIds } from './state'
import { getActiveMcpTools } from './mcp'
import { BrowserWindow } from 'electron'
import type { Tool } from '@github/copilot-sdk'

// ============================================================
// Custom Tools — 注册到 SDK 供 Agent 自主调用
// ============================================================

export function buildTools(): Tool<any>[] {
  // Internal tools + all active MCP server tools
  const mcpTools = getActiveMcpTools()
  return [
    memoryWriteTool,
    memorySearchTool,
    createTaskTool,
    updateTaskTool,
    queryTasksTool,
    queryProjectsTool,
    queryRelationsTool,
    manageProjectTool,
    manageRelationTool,
    manageJobTool,
    managePreferencesTool,
    generateReportTool,
    ...mcpTools
  ]
}

const memoryWriteTool: Tool<any> = {
  name: 'memory_write',
  description: '管理记忆。add=记录新信息, update=修正已有记忆, remove=删除错误记忆。当用户纠正你时，先检查是否有错误记忆需要 update/remove。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'update', 'remove'], description: '操作类型' },
      content: { type: 'string', description: '新内容（add/update 时必填）' },
      target_id: { type: 'string', description: '目标记忆ID（update/remove 时必填）' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签分类，如 ["preference", "tech"]' },
      projectId: { type: 'string', description: '关联项目ID（可选）' }
    },
    required: ['action']
  },
  skipPermission: true, // 记忆写入自动允许
  handler: async (args: { action: 'add' | 'update' | 'remove'; content?: string; target_id?: string; tags?: string[]; projectId?: string }) => {
    if (args.action === 'remove') {
      if (!args.target_id) return { success: false, error: 'remove 需要 target_id' }
      markMemoryInactive(args.target_id)
      return { success: true, message: '已标记为 inactive（可审计）' }
    }
    if (args.action === 'update') {
      if (!args.target_id || !args.content) return { success: false, error: 'update 需要 target_id 和 content' }
      updateMemory(args.target_id, args.content)
      return { success: true, message: '已更新' }
    }
    // add
    if (!args.content) return { success: false, error: 'add 需要 content' }
    const entry = writeMemory({ content: args.content, tags: args.tags, projectId: args.projectId })
    return { success: true, id: entry.id, message: '已记录' }
  }
}

const memorySearchTool: Tool<any> = {
  name: 'memory_search',
  description: '搜索历史记忆。当你需要回忆之前的对话内容、用户偏好、项目信息、人物细节时使用。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词/短语' },
      limit: { type: 'number', description: '最多返回条数（默认5）' }
    },
    required: ['query']
  },
  skipPermission: true,
  handler: async (args: { query: string; limit?: number }) => {
    const results = searchMemory(args.query, args.limit || 5)
    if (results.length === 0) return { memories: [], message: '未找到相关记忆' }
    return {
      memories: results.map(m => ({
        content: m.content,
        tags: m.tags,
        createdAt: m.createdAt,
        source: m.source
      }))
    }
  }
}

const createTaskTool: Tool<any> = {
  name: 'create_task',
  description: '创建新任务。传 sourceId（邮件ID/通知ID等）可精确去重。系统会自动检测相似任务并跳过重复。',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '任务标题，简洁明确（一行）' },
      description: { type: 'string', description: '任务详情：背景 + 核心内容 + 建议处理步骤。用户看到后应能直接决策，无需回溯原始信息。' },
      priority: { type: 'string', enum: ['p0', 'p1', 'p2'] },
      sourceId: { type: 'string', description: '来源唯一标识（邮件ID、notification ID、message ID）。从 MCP 返回数据中提取。' },
      dueDate: { type: 'string', description: 'ISO 8601 截止日期' },
      projectId: { type: 'string', description: '关联项目ID' },
      relatedRelationIds: { type: 'array', items: { type: 'string' }, description: '相关人员ID列表' }
    },
    required: ['title', 'priority', 'description']
  },
  skipPermission: true, // 创建任务自动允许（notify 级别）
  handler: async (args: any) => {
    const source: any = { type: 'agent' as const }
    if (args.sourceId) {
      source.externalId = args.sourceId
    }
    const { task, deduplicated } = createTask({ ...args, source })

    if (deduplicated) {
      return { success: true, deduplicated: true, taskId: task.id, title: task.title, message: '已存在相同任务，跳过创建' }
    }

    emitToRenderer({ type: 'task:created', task })

    // Track task IDs created during job sessions (to prevent same-session completion)
    if (isJobSession) {
      jobCreatedTaskIds.add(task.id)
    }

    // System notification for high priority tasks
    const prefs = getPreferences()
    if (task.priority === 'p0') {
      if (prefs.systemNotifications) {
        showSystemNotification('紧急任务', task.title)
      }
      // Also push a chat message to General for visibility
      emitToRenderer({
        type: 'chat:message',
        message: {
          id: `notify-${task.id}`,
          role: 'agent',
          content: `⚡ 新紧急任务：**${task.title}**${task.dueDate ? `（截止: ${new Date(task.dueDate).toLocaleDateString('zh-CN')}）` : ''}`,
          timestamp: new Date().toISOString(),
          taskId: null
        }
      })
    } else if (task.priority === 'p1') {
      if (prefs.systemNotifications) {
        showSystemNotification('新任务', task.title)
      }
      emitToRenderer({
        type: 'chat:message',
        message: {
          id: `notify-${task.id}`,
          role: 'agent',
          content: `📋 新任务：**${task.title}**${task.dueDate ? `（截止: ${new Date(task.dueDate).toLocaleDateString('zh-CN')}）` : ''}`,
          timestamp: new Date().toISOString(),
          taskId: null
        }
      })
    } else if (task.priority === 'p2') {
      // P2: in-app notification only (no system notification)
      emitToRenderer({
        type: 'chat:message',
        message: {
          id: `notify-${task.id}`,
          role: 'agent',
          content: `📝 低优先级任务：**${task.title}**`,
          timestamp: new Date().toISOString(),
          taskId: null
        }
      })
    }

    return { success: true, deduplicated: false, taskId: task.id, title: task.title }
  }
}

const updateTaskTool: Tool<any> = {
  name: 'update_task',
  description: '更新任务。修改状态（完成/取消）、优先级、标题等。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '任务ID' },
      status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
      priority: { type: 'string', enum: ['p0', 'p1', 'p2'] },
      title: { type: 'string' },
      description: { type: 'string' }
    },
    required: ['id']
  },
  skipPermission: true,
  handler: async (args: any) => {
    const { id, ...changes } = args

    // Prevent jobs from completing tasks they JUST created in the same session (anti-self-completion)
    // But allow completing pre-existing tasks based on new external info (e.g. PR merged → task done)
    if (isJobSession && changes.status && (changes.status === 'completed' || changes.status === 'cancelled')) {
      if (jobCreatedTaskIds.has(id)) {
        return { success: false, error: '不能在同一次 Job 中创建并完成任务。任务状态应由下次检查或用户确认来更新。' }
      }
    }

    const task = updateTask(id, changes)
    emitToRenderer({ type: 'task:updated', task })
    return { success: true, task: { id: task.id, title: task.title, status: task.status } }
  }
}

const queryTasksTool: Tool<any> = {
  name: 'query_tasks',
  description: '查询任务列表。可按状态、优先级、项目筛选。用于了解当前工作负载。',
  parameters: {
    type: 'object',
    properties: {
      status: { type: 'array', items: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] } },
      priority: { type: 'array', items: { type: 'string', enum: ['p0', 'p1', 'p2'] } },
      projectId: { type: 'string' }
    }
  },
  skipPermission: true,
  handler: async (args: any) => {
    const tasks = listTasks(args || {})
    return {
      total: tasks.length,
      tasks: tasks.slice(0, 20).map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        dueDate: t.dueDate,
        source: t.source.type
      }))
    }
  }
}

const queryProjectsTool: Tool<any> = {
  name: 'query_projects',
  description: '查询已有项目列表。创建任务时用来确定是否有匹配的项目可关联。',
  parameters: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '按名称或描述模糊搜索（可选，不传则返回全部）' }
    }
  },
  skipPermission: true,
  handler: async (args: { keyword?: string }) => {
    let projects = listProjects()
    if (args?.keyword) {
      const kw = args.keyword.toLowerCase()
      projects = projects.filter(p =>
        p.name.toLowerCase().includes(kw) ||
        p.description.toLowerCase().includes(kw) ||
        (p.techStack || '').toLowerCase().includes(kw)
      )
    }
    if (projects.length === 0) return { projects: [], message: '未找到匹配项目', hint: '如果确实涉及某个项目，请用 manage_project(action: create) 创建' }
    return {
      projects: projects.map(p => ({
        id: p.id,
        name: p.name,
        description: p.description,
        techStack: p.techStack,
        team: p.team
      }))
    }
  }
}

const queryRelationsTool: Tool<any> = {
  name: 'query_relations',
  description: '查询已有联系人。创建任务时用来确定涉及哪些已知人物可关联。也用于查找某人的联系方式、角色等信息。',
  parameters: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '按姓名、组织、职位模糊搜索（可选，不传则返回全部）' },
      role: { type: 'string', enum: ['manager', 'peer', 'report', 'external', 'stakeholder'], description: '按角色筛选' }
    }
  },
  skipPermission: true,
  handler: async (args: { keyword?: string; role?: string }) => {
    let relations = listRelations()
    if (args?.role) {
      relations = relations.filter(r => r.role === args.role)
    }
    if (args?.keyword) {
      const kw = args.keyword.toLowerCase()
      relations = relations.filter(r =>
        r.name.toLowerCase().includes(kw) ||
        (r.org || '').toLowerCase().includes(kw) ||
        (r.title || '').toLowerCase().includes(kw) ||
        (r.email || '').toLowerCase().includes(kw)
      )
    }
    if (relations.length === 0) return { relations: [], message: '未找到匹配联系人', hint: '如果涉及新人物，请用 manage_relation(action: create) 创建' }
    return {
      relations: relations.map(r => ({
        id: r.id,
        name: r.name,
        role: r.role,
        org: r.org,
        title: r.title,
        email: r.email,
        expertise: r.expertise
      }))
    }
  }
}

const manageProjectTool: Tool<any> = {
  name: 'manage_project',
  description: '创建、更新或删除项目。创建时必须提供 repoPath。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'update', 'delete'], description: '操作类型' },
      id: { type: 'string', description: '项目ID（update/delete 时必填）' },
      name: { type: 'string', description: '项目名称（create 时必填）' },
      description: { type: 'string', description: '项目描述' },
      repoPath: { type: 'string', description: 'GitHub repo URL 或本地文件夹路径（create 时必填）' },
      docsPath: { type: 'string', description: '文档路径' },
      techStack: { type: 'string', description: '技术栈' },
      team: { type: 'array', items: { type: 'string' }, description: '团队成员 relation ID 列表' },
      notes: { type: 'string', description: '备注' }
    },
    required: ['action']
  },
  skipPermission: true,
  handler: async (args: any) => {
    const { action, id, ...fields } = args
    if (action === 'create') {
      if (!fields.name) return { success: false, error: 'create 需要 name' }
      if (!fields.repoPath) return { success: false, error: 'create 需要 repoPath（GitHub repo URL 或本地路径）。项目必须对应真实代码仓库或文件夹。' }
      const project = createProject({ ...fields, source: 'agent' })
      emitToRenderer({ type: 'project:created', project })
      return { success: true, id: project.id, name: project.name }
    }
    if (action === 'update') {
      if (!id) return { success: false, error: 'update 需要 id' }
      const project = updateProject(id, fields)
      return { success: true, id: project.id, name: project.name }
    }
    if (action === 'delete') {
      if (!id) return { success: false, error: 'delete 需要 id' }
      deleteProject(id)
      emitToRenderer({ type: 'project:deleted', projectId: id })
      return { success: true, message: '已删除' }
    }
    return { success: false, error: '未知 action' }
  }
}

const manageRelationTool: Tool<any> = {
  name: 'manage_relation',
  description: '创建、更新或删除联系人。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'update', 'delete'], description: '操作类型' },
      id: { type: 'string', description: '联系人ID（update 时必填）' },
      name: { type: 'string', description: '姓名（create 时必填）' },
      role: { type: 'string', enum: ['manager', 'peer', 'report', 'external', 'stakeholder'], description: '角色关系' },
      org: { type: 'string', description: '组织/团队' },
      title: { type: 'string', description: '职位' },
      email: { type: 'string', description: '邮箱' },
      teamsId: { type: 'string', description: 'Teams ID' },
      timezone: { type: 'string', description: '时区' },
      expertise: { type: 'array', items: { type: 'string' }, description: '擅长领域' },
      communicationStyle: { type: 'string', description: '沟通偏好' },
      notes: { type: 'string', description: '备注' }
    },
    required: ['action']
  },
  skipPermission: true, // 联系人管理自动执行
  handler: async (args: any) => {
    const { action, id, ...fields } = args
    if (action === 'create') {
      if (!fields.name) return { success: false, error: 'create 需要 name' }
      if (!fields.role) fields.role = 'peer' // default to peer
      const relation = createRelation({ ...fields, source: 'agent' })
      emitToRenderer({ type: 'relation:created', relation })
      return { success: true, id: relation.id, name: relation.name }
    }
    if (action === 'update') {
      if (!id) return { success: false, error: 'update 需要 id' }
      const relation = updateRelation(id, fields)
      return { success: true, id: relation.id, name: relation.name }
    }
    if (action === 'delete') {
      if (!id) return { success: false, error: 'delete 需要 id' }
      deleteRelation(id)
      emitToRenderer({ type: 'relation:deleted', relationId: id })
      return { success: true, message: '已删除' }
    }
    return { success: false, error: '未知 action' }
  }
}

const manageJobTool: Tool<any> = {
  name: 'manage_job',
  description: `管理定时任务。支持创建、更新、删除、启停、列表查询。

用途示例：
- 用户说"每天早上8点帮我看一下邮件" → create, cron="0 8 * * *"
- 用户说"把那个定时任务频率改成每小时" → update, cron="0 * * * *"
- 用户说"暂停晨报" → toggle, enabled=false
- 用户说"我现在有哪些定时任务" → list`,
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'update', 'delete', 'toggle', 'list'], description: '操作类型' },
      id: { type: 'string', description: '任务ID（update/delete/toggle 时必填）' },
      name: { type: 'string', description: '定时任务名称（create 时必填）' },
      cron: { type: 'string', description: 'Cron 表达式，如 "0 8 * * *" 表示每天8点（create 时必填）' },
      instruction: { type: 'string', description: '执行指令 — agent 在触发时会收到这段话作为 prompt（create 时必填）' },
      enabled: { type: 'boolean', description: '是否启用（toggle 时必填）' }
    },
    required: ['action']
  },
  skipPermission: true,
  handler: async (args: { action: string; id?: string; name?: string; cron?: string; instruction?: string; enabled?: boolean }) => {
    if (args.action === 'list') {
      const jobs = listJobs()
      return {
        total: jobs.length,
        jobs: jobs.map(j => ({ id: j.id, name: j.name, cron: j.cron, enabled: j.enabled, lastRunAt: j.lastRunAt, lastResult: j.lastResult }))
      }
    }
    if (args.action === 'create') {
      if (!args.name || !args.cron || !args.instruction) return { success: false, error: 'create 需要 name, cron, instruction' }
      const job = createJob({ name: args.name, cron: args.cron, instruction: args.instruction })
      emitToRenderer({ type: 'job:created', job })
      return { success: true, id: job.id, name: job.name, cron: job.cron }
    }
    if (args.action === 'update') {
      if (!args.id) return { success: false, error: 'update 需要 id' }
      updateJob(args.id, { name: args.name, cron: args.cron, instruction: args.instruction })
      emitToRenderer({ type: 'job:updated', jobId: args.id })
      return { success: true, message: '已更新' }
    }
    if (args.action === 'delete') {
      if (!args.id) return { success: false, error: 'delete 需要 id' }
      deleteJob(args.id)
      emitToRenderer({ type: 'job:deleted', jobId: args.id })
      return { success: true, message: '已删除' }
    }
    if (args.action === 'toggle') {
      if (!args.id || args.enabled === undefined) return { success: false, error: 'toggle 需要 id 和 enabled' }
      toggleJob(args.id, args.enabled)
      emitToRenderer({ type: 'job:toggled', jobId: args.id, enabled: args.enabled })
      return { success: true, message: args.enabled ? '已启用' : '已暂停' }
    }
    return { success: false, error: '未知 action' }
  }
}

const managePreferencesTool: Tool<any> = {
  name: 'manage_preferences',
  description: '查看或修改用户偏好设置。如语言、通知、自主决策级别等。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'set'], description: '操作类型' },
      language: { type: 'string', description: '语言 (zh-CN / en)' },
      autonomyLevel: { type: 'string', enum: ['cautious', 'default', 'autonomous'], description: '自主决策级别' },
      systemNotifications: { type: 'boolean', description: '是否开启系统通知' },
      activeTaskCap: { type: 'number', description: '同时活跃任务上限' }
    },
    required: ['action']
  },
  skipPermission: true,
  handler: async (args: any) => {
    const { action, ...fields } = args
    if (action === 'get') {
      return getPreferences()
    }
    if (action === 'set') {
      const validKeys = ['language', 'autonomyLevel', 'systemNotifications', 'activeTaskCap']
      const updates: Record<string, unknown> = {}
      for (const k of validKeys) {
        if (fields[k] !== undefined) updates[k] = fields[k]
      }
      if (Object.keys(updates).length === 0) return { success: false, error: '没有有效的设置项' }
      setPreferences(updates)
      emitToRenderer({ type: 'preferences:updated' })
      return { success: true, updated: updates }
    }
    return { success: false, error: '未知 action' }
  }
}

const generateReportTool: Tool<any> = {
  name: 'generate_report',
  description: '生成工作报告。汇总指定时间段内完成的和进行中的任务。',
  parameters: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['daily', 'weekly'], description: '日报或周报' }
    },
    required: ['type']
  },
  skipPermission: true,
  handler: async (args: { type: 'daily' | 'weekly' }) => {
    const tasks = listTasks()
    const now = new Date()
    const cutoff = new Date(now)
    cutoff.setDate(cutoff.getDate() - (args.type === 'daily' ? 1 : 7))
    const cutoffStr = cutoff.toISOString()

    const completed = tasks.filter(t => t.status === 'completed' && t.completedAt && t.completedAt >= cutoffStr)
    const inProgress = tasks.filter(t => t.status === 'in_progress')
    const pending = tasks.filter(t => t.status === 'pending')

    return {
      period: args.type,
      dateRange: { from: cutoffStr, to: now.toISOString() },
      completed: completed.map(t => ({ title: t.title, completedAt: t.completedAt })),
      inProgress: inProgress.map(t => ({ title: t.title, priority: t.priority })),
      pending: pending.length,
      summary: `${args.type === 'daily' ? '今日' : '本周'}完成 ${completed.length} 项，进行中 ${inProgress.length} 项，待处理 ${pending.length} 项`
    }
  }
}

function emitToRenderer(event: { type: string; [key: string]: unknown }): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('aide:event', event)
  }
}
