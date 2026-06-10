import { writeMemory, searchMemory, updateMemory, markMemoryInactive } from '../memory'
import { createTask, updateTask, listTasks, getTask, addTaskActivity, listTaskActivities, findRelatedTask } from '../tasks'
import { listProjects, createProject, updateProject, deleteProject } from '../projects'
import { listRelations, createRelation, updateRelation, deleteRelation } from '../relations'
import { getPreferences, setPreferences } from '../preferences'
import { listJobs, createJob, updateJob, deleteJob, toggleJob } from '../jobs'
import { showSystemNotification } from '../index'
import { isJobSession, jobCreatedTaskIds, currentSessionId } from './state'
import { getActiveMcpTools } from './mcp'
import { browser, isBrowserAvailable } from '../automation'
import { listSkills, installSkillFromLocalPath } from '../skills'
import { browseSkills, installFromMarketplace } from '../skills/sources'
import { BrowserWindow } from 'electron'
import type { Tool } from '@github/copilot-sdk'

// ============================================================
// Custom Tools — registered to the SDK for the agent to call autonomously
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
    findRelatedTaskTool,
    addTaskActivityTool,
    getTaskActivitiesTool,
    queryProjectsTool,
    queryRelationsTool,
    manageProjectTool,
    manageRelationTool,
    manageJobTool,
    managePreferencesTool,
    generateReportTool,
    // Browser automation tools
    browserNavigateTool,
    browserClickTool,
    browserTypeTool,
    browserReadTool,
    browserScreenshotTool,
    // Skill marketplace tools
    searchSkillsTool,
    installSkillTool,
    listInstalledSkillsTool,
    ...mcpTools
  ]
}

// ── Skill marketplace tools ──────────────────────────────────────────

const searchSkillsTool: Tool<any> = {
  name: 'search_skills',
  description: 'Search the skill marketplace for installable skills by keyword. Returns matching skills with name, description, source, install path, a safety hint (risk), whether it needs extra setup (API keys / dependencies), and whether already installed. Use this when the user wants to find or discover a skill to install. To actually install one, pass its sourceId + path to install_skill.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keyword matched against skill name/description/category. Pass an empty string to list everything (can be large).' },
      limit: { type: 'number', description: 'Max results to return (default 20).' }
    },
    required: ['query']
  },
  skipPermission: true, // read-only browse is auto-allowed
  handler: async (args: { query: string; limit?: number }) => {
    const all = await browseSkills()
    const q = (args.query || '').toLowerCase().trim()
    const matched = q
      ? all.filter(s =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          (s.category || '').toLowerCase().includes(q)
        )
      : all
    const limit = args.limit && args.limit > 0 ? args.limit : 20
    return {
      total: matched.length,
      returned: Math.min(matched.length, limit),
      skills: matched.slice(0, limit).map(s => ({
        name: s.name,
        description: s.description,
        category: s.category,
        risk: s.risk,
        setup: s.setup && s.setup.type !== 'none'
          ? { required: true, steps: s.setup.summary }
          : { required: false },
        sourceId: s.sourceId,
        sourceName: s.sourceName,
        path: s.path,
        installed: s.installed
      }))
    }
  }
}

const installSkillTool: Tool<any> = {
  name: 'install_skill',
  description: 'Install a skill so the agent can use it. Two modes: (1) source="marketplace" — provide sourceId and path obtained from search_skills; (2) source="local" — provide localPath to a folder containing a SKILL.md on the user\'s machine. The skill is enabled immediately after install.',
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', enum: ['marketplace', 'local'], description: 'Where to install from.' },
      sourceId: { type: 'string', description: 'Marketplace source id (required when source=marketplace). Get it from search_skills.' },
      path: { type: 'string', description: 'Repository path to the skill (required when source=marketplace). Get it from search_skills.' },
      localPath: { type: 'string', description: 'Absolute path to a local skill folder or SKILL.md file (required when source=local).' }
    },
    required: ['source']
  },
  handler: async (args: { source: 'marketplace' | 'local'; sourceId?: string; path?: string; localPath?: string }) => {
    try {
      if (args.source === 'local') {
        if (!args.localPath) return { success: false, error: 'localPath is required for a local install' }
        const skill = installSkillFromLocalPath(args.localPath)
        return { success: true, installed: skill.name, message: `Installed local skill "${skill.name}"` }
      }
      if (!args.sourceId || !args.path) {
        return { success: false, error: 'sourceId and path are required for a marketplace install — get them from search_skills' }
      }
      const skill = await installFromMarketplace(args.sourceId, args.path)
      return { success: true, installed: skill.name, message: `Installed "${skill.name}" from the marketplace` }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}

const listInstalledSkillsTool: Tool<any> = {
  name: 'list_installed_skills',
  description: 'List skills currently installed in Aide, with their enabled/disabled state and source. Use this to check what is already available before installing something new.',
  parameters: { type: 'object', properties: {} },
  skipPermission: true, // read-only
  handler: async () => {
    const skills = listSkills()
    return {
      total: skills.length,
      skills: skills.map(s => ({ name: s.name, description: s.description, enabled: s.enabled, source: s.source }))
    }
  }
}

const memoryWriteTool: Tool<any> = {
  name: 'memory_write',
  description: `Manage long-term memory. Records stable knowledge about the user and their world.

Rules:
1. SEARCH FIRST — before adding, use memory_search to check if the fact already exists.
2. UPDATE if same subject + same attribute exists (don't duplicate).
3. Format: one-liner declarative facts ("User prefers X", "Alice: manager at Contoso, prefers async").
4. People: one compact card per person. Only for recurring/important people.
5. Do NOT store: task progress, event details (dates/times/venues/budgets/attendees), scheduling info, or anything that expires. Use update_aide_task working_state instead.
6. Test before writing: "Will this fact still be true and useful in 2 weeks?" If not → working_state, not memory.

Actions: add = new fact, update = correct existing, remove = mark wrong entry inactive.
For update/remove: pass the real target_id from memory_search (never guess).`,
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'update', 'remove'], description: 'Operation type' },
      content: { type: 'string', description: 'New content (required for add/update)' },
      target_id: { type: 'string', description: 'Real ID of an existing memory (required for update/remove). Obtain it from memory_search — do not invent it.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Category tags, e.g. ["preference", "tech"]' },
      projectId: { type: 'string', description: 'Associated project ID (optional)' }
    },
    required: ['action']
  },
  skipPermission: true, // memory writes are auto-allowed
  handler: async (args: { action: 'add' | 'update' | 'remove'; content?: string; target_id?: string; tags?: string[]; projectId?: string }) => {
    if (args.action === 'remove') {
      if (!args.target_id) return { success: false, error: 'remove requires target_id. Call memory_search to find the memory and use its id.' }
      const ok = markMemoryInactive(args.target_id)
      if (!ok) return { success: false, error: `No memory found with id "${args.target_id}". Call memory_search to get a valid id — do not guess.` }
      return { success: true, message: 'Marked inactive (auditable)' }
    }
    if (args.action === 'update') {
      if (!args.target_id || !args.content) return { success: false, error: 'update requires target_id and content. Call memory_search to find the memory and use its id.' }
      const ok = updateMemory(args.target_id, args.content)
      if (!ok) return { success: false, error: `No memory found with id "${args.target_id}". Call memory_search to get a valid id — do not guess.` }
      return { success: true, message: 'Updated' }
    }
    // add
    if (!args.content) return { success: false, error: 'add requires content' }
    const entry = writeMemory({ content: args.content, tags: args.tags, projectId: args.projectId })
    return { success: true, id: entry.id, message: 'Recorded' }
  }
}

const memorySearchTool: Tool<any> = {
  name: 'memory_search',
  description: 'Search past memories. Use when you need to recall earlier conversations, user preferences, project info, or details about a person.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search keyword/phrase' },
      limit: { type: 'number', description: 'Max results (default 5)' }
    },
    required: ['query']
  },
  skipPermission: true,
  handler: async (args: { query: string; limit?: number }) => {
    const results = await searchMemory(args.query, args.limit || 5)
    if (results.length === 0) return { memories: [], message: 'No relevant memories found' }
    return {
      memories: results.map(m => ({
        id: m.id,
        content: m.content,
        tags: m.tags,
        createdAt: m.createdAt,
        source: m.source
      }))
    }
  }
}

const createTaskTool: Tool<any> = {
  name: 'create_aide_task',
  description: 'Create a task in Aide (the user\'s personal task tracker). Always fill sourceType by the task\'s real source (from a GitHub PR/Issue use github, Teams message use teams, email use email, calendar event use calendar; for a task with no external source that originated from chatting with the user, use chat). Pass sourceId (email ID/notification ID, etc.) for exact de-dup. The system auto-detects similar tasks and skips duplicates.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Task title, concise and clear (one line)' },
      description: { type: 'string', description: 'Task details: background + core content + suggested handling steps. The user should be able to decide directly without going back to the original info.' },
      priority: { type: 'string', enum: ['p0', 'p1', 'p2'] },
      sourceType: { type: 'string', enum: ['github', 'teams', 'email', 'calendar', 'chat'], description: 'The task\'s real source. GitHub PR/Issue → github, Teams message → teams, email → email, calendar → calendar; a task with no external source that originated from chatting with the user → chat.' },
      sourceId: { type: 'string', description: 'Unique source identifier (email ID, notification ID, message ID, PR/Issue number). Extract from MCP response data.' },
      sourceUrl: { type: 'string', description: 'External link to the source (PR/Issue URL, email/message deep link, etc.) for one-click navigation.' },
      dueDate: { type: 'string', description: 'ISO 8601 due date' },
      projectIds: { type: 'array', items: { type: 'string' }, description: 'Associated project IDs' },
      relatedRelationIds: { type: 'array', items: { type: 'string' }, description: 'List of related people IDs' }
    },
    required: ['title', 'priority', 'description']
  },
  skipPermission: true, // creating a task is auto-allowed (notify level)
  handler: async (args: any) => {
    const source: any = { type: (args.sourceType as string) || 'chat' }
    if (args.sourceId) {
      source.externalId = args.sourceId
    }
    if (args.sourceUrl) {
      source.externalUrl = args.sourceUrl
    }
    const { task, deduplicated } = createTask({ ...args, source })

    if (deduplicated) {
      return { success: true, deduplicated: true, taskId: task.id, title: task.title, message: 'An identical task already exists; skipped creation' }
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
        showSystemNotification('Urgent task', task.title)
      }
      // Also push a chat message to General for visibility (skip for background jobs)
      if (!isJobSession) emitToRenderer({
        type: 'chat:message',
        message: {
          id: `notify-${task.id}`,
          role: 'agent',
          content: `⚡ New urgent task: **${task.title}**${task.dueDate ? ` (due ${new Date(task.dueDate).toLocaleDateString('en-US')})` : ''}`,
          timestamp: new Date().toISOString(),
          taskId: null
        }
      })
    } else if (task.priority === 'p1') {
      if (prefs.systemNotifications) {
        showSystemNotification('New task', task.title)
      }
      if (!isJobSession) emitToRenderer({
        type: 'chat:message',
        message: {
          id: `notify-${task.id}`,
          role: 'agent',
          content: `📋 New task: **${task.title}**${task.dueDate ? ` (due ${new Date(task.dueDate).toLocaleDateString('en-US')})` : ''}`,
          timestamp: new Date().toISOString(),
          taskId: null
        }
      })
    } else if (task.priority === 'p2') {
      // P2: in-app notification only (no system notification); skip for background jobs
      if (!isJobSession) emitToRenderer({
        type: 'chat:message',
        message: {
          id: `notify-${task.id}`,
          role: 'agent',
          content: `📝 Low-priority task: **${task.title}**`,
          timestamp: new Date().toISOString(),
          taskId: null
        }
      })
    }

    return { success: true, deduplicated: false, taskId: task.id, title: task.title }
  }
}

const updateTaskTool: Tool<any> = {
  name: 'update_aide_task',
  description: 'Update an Aide task. Change status, priority, title, working_state (progress/outputs), or link to projects.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Task ID' },
      status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
      priority: { type: 'string', enum: ['p0', 'p1', 'p2'] },
      title: { type: 'string' },
      description: { type: 'string' },
      working_state: { type: 'string', description: 'Current progress, decisions, outputs for this task. Updated in real-time as work progresses.' },
      progress_summary: { type: 'string', description: 'One-sentence summary of what changed (logged to the activity timeline). Provide this whenever you update working_state.' },
      projectIds: { type: 'array', items: { type: 'string' }, description: 'Project IDs this task relates to' }
    },
    required: ['id']
  },
  skipPermission: true,
  handler: async (args: any) => {
    const { id, working_state, progress_summary, projectIds, ...changes } = args
    if (working_state !== undefined) changes.workingState = working_state
    if (projectIds !== undefined) changes.projectIds = projectIds

    // Auto-promote pending → in_progress when working_state is updated
    if (changes.workingState !== undefined && !changes.status) {
      const current = getTask(id)
      if (current && current.status === 'pending') {
        changes.status = 'in_progress'
      }
    }

    // Prevent jobs from completing tasks they JUST created in the same session (anti-self-completion)
    // But allow completing pre-existing tasks based on new external info (e.g. PR merged → task done)
    if (isJobSession && changes.status && (changes.status === 'completed' || changes.status === 'cancelled')) {
      if (jobCreatedTaskIds.has(id)) {
        return { success: false, error: 'Cannot create and complete a task within the same Job run. Task status should be updated by a later check or user confirmation.' }
      }
    }

    const task = updateTask(id, changes)
    emitToRenderer({ type: 'task:updated', task })

    // Auto-log progress activity when working_state is updated with a summary
    if (changes.workingState !== undefined && progress_summary) {
      const activity = addTaskActivity(id, { type: 'progress', summary: progress_summary })
      emitToRenderer({ type: 'task:activity', taskId: id, activity })
    }

    return { success: true, task: { id: task.id, title: task.title, status: task.status } }
  }
}

const findRelatedTaskTool: Tool<any> = {
  name: 'find_related_task',
  description: 'Before creating a new task or attaching progress, use this to check whether a related task already exists. Returns the most likely candidate, a similarity score (0-1), and the match reason. High score (>=0.7) should attach to the existing task; no result means you may create a new one. Passing an external reference (PR#/email ID/message ID) precisely matches a previously bound task.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Title/subject of the content to evaluate' },
      description: { type: 'string', description: 'Details of the content to evaluate (optional)' },
      sourceRef: { type: 'string', description: 'External reference: PR#, issue#, email messageId, Teams message id, etc. (optional, but improves matching accuracy)' }
    },
    required: ['title']
  },
  skipPermission: true,
  handler: async (args: { title: string; description?: string; sourceRef?: string }) => {
    const match = findRelatedTask(args.title, args.description, args.sourceRef)
    if (!match) return { found: false, message: 'No related task found; can be treated as a new task' }
    return {
      found: true,
      taskId: match.task.id,
      title: match.task.title,
      status: match.task.status,
      score: Math.round(match.score * 100) / 100,
      reason: match.reason
    }
  }
}

const addTaskActivityTool: Tool<any> = {
  name: 'add_task_activity',
  description: 'Record a substantive update on a task. Use for real progress, blockers, or comments needing user response. Do not record pleasantries, acknowledgements, or bot notifications.',
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task ID' },
      type: { type: 'string', enum: ['progress', 'blocker', 'comment', 'note'], description: 'progress = forward movement, blocker = blocked/risk, comment = substantive input needing a response, note = other key point' },
      summary: { type: 'string', description: 'One-sentence plain-language summary of this substantive update' },
      sourceRef: { type: 'string', description: 'External reference (PR#/email ID/message id) for precise later linking (strongly recommended)' }
    },
    required: ['taskId', 'summary']
  },
  skipPermission: true,
  handler: async (args: { taskId: string; type?: any; summary: string; sourceRef?: string }) => {
    const activity = addTaskActivity(args.taskId, {
      type: args.type || 'progress',
      summary: args.summary,
      sourceRef: args.sourceRef
    })
    emitToRenderer({ type: 'task:activity', taskId: args.taskId, activity })
    return { success: true, activityId: activity.id }
  }
}

const getTaskActivitiesTool: Tool<any> = {
  name: 'get_task_activities',
  description: 'View a task\'s progress timeline (newest first). Use it before recording a new update to avoid recording the same update twice.',
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task ID' }
    },
    required: ['taskId']
  },
  skipPermission: true,
  handler: async (args: { taskId: string }) => {
    const activities = listTaskActivities(args.taskId)
    return {
      total: activities.length,
      activities: activities.slice(0, 30).map(a => ({
        timestamp: a.timestamp,
        type: a.type,
        summary: a.summary,
        sourceRef: a.sourceRef
      }))
    }
  }
}

const queryTasksTool: Tool<any> = {
  name: 'query_aide_tasks',
  description: 'Query Aide tasks (the user\'s personal task tracker). Filter by status, priority, or project.',
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
  description: 'Query the list of existing projects. Use when creating a task to determine whether there is a matching project to associate.',
  parameters: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: 'Fuzzy search by name or description (optional; returns all if omitted)' }
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
    if (projects.length === 0) return { projects: [], message: 'No matching project found', hint: 'If a project is genuinely involved, create it with manage_project(action: create)' }
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
  description: 'Query existing contacts. Use when creating a task to determine which known people are involved. Also used to look up someone\'s contact info, role, etc.',
  parameters: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: 'Fuzzy search by name, organization, or title (optional; returns all if omitted)' },
      role: { type: 'string', enum: ['manager', 'peer', 'report', 'external', 'stakeholder'], description: 'Filter by role' }
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
    if (relations.length === 0) return { relations: [], message: 'No matching contact found', hint: 'If a new person is involved, create them with manage_relation(action: create)' }
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
  description: 'Create, update, or delete a project. repoPath is required when creating.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'update', 'delete'], description: 'Operation type' },
      id: { type: 'string', description: 'Project ID (required for update/delete)' },
      name: { type: 'string', description: 'Project name (required for create)' },
      description: { type: 'string', description: 'Project description' },
      repoPath: { type: 'string', description: 'GitHub repo URL or local folder path (required for create)' },
      docsPath: { type: 'string', description: 'Docs path' },
      techStack: { type: 'string', description: 'Tech stack' },
      team: { type: 'array', items: { type: 'string' }, description: 'List of team member relation IDs' },
      notes: { type: 'string', description: 'Notes' }
    },
    required: ['action']
  },
  skipPermission: true,
  handler: async (args: any) => {
    const { action, id, ...fields } = args
    if (action === 'create') {
      if (!fields.name) return { success: false, error: 'create requires name' }
      if (!fields.repoPath) return { success: false, error: 'create requires repoPath (GitHub repo URL or local path). A project must map to a real code repo or folder.' }
      const project = createProject({ ...fields, source: 'agent' })
      emitToRenderer({ type: 'project:created', project })
      return { success: true, id: project.id, name: project.name }
    }
    if (action === 'update') {
      if (!id) return { success: false, error: 'update requires id' }
      const project = updateProject(id, fields)
      return { success: true, id: project.id, name: project.name }
    }
    if (action === 'delete') {
      if (!id) return { success: false, error: 'delete requires id' }
      deleteProject(id)
      emitToRenderer({ type: 'project:deleted', projectId: id })
      return { success: true, message: 'Deleted' }
    }
    return { success: false, error: 'Unknown action' }
  }
}

const manageRelationTool: Tool<any> = {
  name: 'manage_relation',
  description: 'Create, update, or delete a contact.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'update', 'delete'], description: 'Operation type' },
      id: { type: 'string', description: 'Contact ID (required for update)' },
      name: { type: 'string', description: 'Name (required for create)' },
      role: { type: 'string', enum: ['manager', 'peer', 'report', 'external', 'stakeholder'], description: 'Role relationship' },
      org: { type: 'string', description: 'Organization/team' },
      title: { type: 'string', description: 'Job title' },
      email: { type: 'string', description: 'Email' },
      teamsId: { type: 'string', description: 'Teams ID' },
      timezone: { type: 'string', description: 'Timezone' },
      expertise: { type: 'array', items: { type: 'string' }, description: 'Areas of expertise' },
      communicationStyle: { type: 'string', description: 'Communication preference' },
      notes: { type: 'string', description: 'Notes' }
    },
    required: ['action']
  },
  skipPermission: true, // contact management runs automatically
  handler: async (args: any) => {
    const { action, id, ...fields } = args
    if (action === 'create') {
      if (!fields.name) return { success: false, error: 'create requires name' }
      if (!fields.role) fields.role = 'peer' // default to peer
      const relation = createRelation({ ...fields, source: 'agent' })
      emitToRenderer({ type: 'relation:created', relation })
      return { success: true, id: relation.id, name: relation.name }
    }
    if (action === 'update') {
      if (!id) return { success: false, error: 'update requires id' }
      const relation = updateRelation(id, fields)
      return { success: true, id: relation.id, name: relation.name }
    }
    if (action === 'delete') {
      if (!id) return { success: false, error: 'delete requires id' }
      deleteRelation(id)
      emitToRenderer({ type: 'relation:deleted', relationId: id })
      return { success: true, message: 'Deleted' }
    }
    return { success: false, error: 'Unknown action' }
  }
}

const manageJobTool: Tool<any> = {
  name: 'manage_job',
  description: `Manage scheduled jobs. Supports create, update, delete, toggle, and list.

Usage examples:
- User says "check my email every day at 8am" → create, cron="0 8 * * *"
- User says "change that scheduled job to hourly" → update, cron="0 * * * *"
- User says "pause the morning briefing" → toggle, enabled=false
- User says "what scheduled jobs do I have" → list`,
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'update', 'delete', 'toggle', 'list'], description: 'Operation type' },
      id: { type: 'string', description: 'Job ID (required for update/delete/toggle)' },
      name: { type: 'string', description: 'Scheduled job name (required for create)' },
      cron: { type: 'string', description: 'Cron expression, e.g. "0 8 * * *" means daily at 8am (required for create)' },
      instruction: { type: 'string', description: 'Execution instruction — the agent receives this text as its prompt when triggered (required for create)' },
      enabled: { type: 'boolean', description: 'Whether enabled (required for toggle)' }
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
      if (!args.name || !args.cron || !args.instruction) return { success: false, error: 'create requires name, cron, instruction' }
      const job = createJob({ name: args.name, cron: args.cron, instruction: args.instruction })
      emitToRenderer({ type: 'job:created', job })
      return { success: true, id: job.id, name: job.name, cron: job.cron }
    }
    if (args.action === 'update') {
      if (!args.id) return { success: false, error: 'update requires id' }
      updateJob(args.id, { name: args.name, cron: args.cron, instruction: args.instruction })
      emitToRenderer({ type: 'job:updated', jobId: args.id })
      return { success: true, message: 'Updated' }
    }
    if (args.action === 'delete') {
      if (!args.id) return { success: false, error: 'delete requires id' }
      deleteJob(args.id)
      emitToRenderer({ type: 'job:deleted', jobId: args.id })
      return { success: true, message: 'Deleted' }
    }
    if (args.action === 'toggle') {
      if (!args.id || args.enabled === undefined) return { success: false, error: 'toggle requires id and enabled' }
      toggleJob(args.id, args.enabled)
      emitToRenderer({ type: 'job:toggled', jobId: args.id, enabled: args.enabled })
      return { success: true, message: args.enabled ? 'Enabled' : 'Paused' }
    }
    return { success: false, error: 'Unknown action' }
  }
}

const managePreferencesTool: Tool<any> = {
  name: 'manage_preferences',
  description: 'View or change user preferences, such as notifications and autonomy level.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'set'], description: 'Operation type' },
      autonomyLevel: { type: 'string', enum: ['default', 'confirm'], description: 'Autonomy level: default = write operations run automatically, confirm = confirm before every operation' },
      systemNotifications: { type: 'boolean', description: 'Whether system notifications are enabled' }
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
      const validKeys = ['autonomyLevel', 'systemNotifications']
      const updates: Record<string, unknown> = {}
      for (const k of validKeys) {
        if (fields[k] !== undefined) updates[k] = fields[k]
      }
      if (Object.keys(updates).length === 0) return { success: false, error: 'No valid settings provided' }
      setPreferences(updates)
      emitToRenderer({ type: 'preferences:updated' })
      return { success: true, updated: updates }
    }
    return { success: false, error: 'Unknown action' }
  }
}

const generateReportTool: Tool<any> = {
  name: 'generate_report',
  description: 'Generate a work report. Summarizes completed and in-progress tasks within the given time window.',
  parameters: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['daily', 'weekly'], description: 'Daily or weekly report' }
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
      summary: `${args.type === 'daily' ? 'Today' : 'This week'}: ${completed.length} completed, ${inProgress.length} in progress, ${pending.length} pending`
    }
  }
}

function emitToRenderer(event: { type: string; [key: string]: unknown }): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('aide:event', event)
  }
}

// ============================================================
// Browser Automation Tools — Playwright-based web automation
// ============================================================

const browserNavigateTool: Tool<any> = {
  name: 'browser_navigate',
  description: 'Navigate to a URL in the browser. Opens a new browser window if needed. Use this to visit websites, web apps, or any URL.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to navigate to (e.g., "https://github.com")' }
    },
    required: ['url']
  },
  skipPermission: false,
  handler: async (args: { url: string }) => {
    if (!isBrowserAvailable()) {
      return { success: false, error: 'Browser automation is not available. Chromium may not be installed.' }
    }
    try {
      const page = await browser.navigateTo(args.url)
      const title = await page.title()
      return { success: true, url: args.url, title, message: `Navigated to ${args.url}` }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }
}

const browserClickTool: Tool<any> = {
  name: 'browser_click',
  description: 'Click an element on the current web page. Use CSS selectors to identify the element.',
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector for the element to click (e.g., "button.submit", "#login-btn", "a[href=\'/dashboard\']")' }
    },
    required: ['selector']
  },
  skipPermission: false,
  handler: async (args: { selector: string }) => {
    try {
      await browser.clickElement(args.selector)
      return { success: true, message: `Clicked element: ${args.selector}` }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }
}

const browserTypeTool: Tool<any> = {
  name: 'browser_type',
  description: 'Type text into an input field on the current web page.',
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector for the input element' },
      text: { type: 'string', description: 'Text to type into the element' }
    },
    required: ['selector', 'text']
  },
  skipPermission: false,
  handler: async (args: { selector: string; text: string }) => {
    try {
      await browser.typeIntoElement(args.selector, args.text)
      return { success: true, message: `Typed text into: ${args.selector}` }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }
}

const browserReadTool: Tool<any> = {
  name: 'browser_read',
  description: 'Read text content from an element on the current web page. Also returns current URL and page title.',
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector for the element to read (optional, omit to get page info only)' }
    }
  },
  skipPermission: true,
  handler: async (args: { selector?: string }) => {
    try {
      const url = browser.getCurrentUrl()
      const title = await browser.getPageTitle()
      let text: string | undefined

      if (args.selector) {
        text = await browser.getElementText(args.selector)
      }

      return { success: true, url, title, text }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }
}

const browserScreenshotTool: Tool<any> = {
  name: 'browser_screenshot',
  description: 'Take a screenshot of the current web page. Returns a base64-encoded PNG image.',
  parameters: {
    type: 'object',
    properties: {}
  },
  skipPermission: true,
  handler: async () => {
    try {
      const buffer = await browser.takeScreenshot()
      const base64 = buffer.toString('base64')
      return { success: true, imageBase64: base64, mimeType: 'image/png' }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  }
}