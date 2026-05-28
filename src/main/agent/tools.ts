import { writeMemory, searchMemory, updateMemory, markMemoryInactive } from '../memory'
import { createTask, updateTask, listTasks } from '../tasks'
import { getPreferences } from '../preferences'
import { showSystemNotification } from '../index'
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
  description: '创建一个新任务。当识别到用户需要处理的事项（从邮件、对话、会议中）时使用。',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '任务标题，简洁明确' },
      description: { type: 'string', description: '任务详情' },
      priority: { type: 'string', enum: ['high', 'medium', 'low'], description: '优先级。紧急/有deadline用high' },
      dueDate: { type: 'string', description: 'ISO 8601 截止日期' },
      projectId: { type: 'string', description: '关联项目ID' },
      relatedRelationIds: { type: 'array', items: { type: 'string' }, description: '相关人员ID列表' }
    },
    required: ['title']
  },
  skipPermission: true, // 创建任务自动允许（notify 级别）
  handler: async (args: any) => {
    const task = createTask({ ...args, source: { type: 'agent' as const } })
    emitToRenderer({ type: 'task:created', task })

    // System notification for high priority tasks
    if (task.priority === 'high') {
      const prefs = getPreferences()
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
    }

    return { success: true, taskId: task.id, title: task.title }
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
      priority: { type: 'string', enum: ['high', 'medium', 'low'] },
      title: { type: 'string' },
      description: { type: 'string' }
    },
    required: ['id']
  },
  // update_task 需要确认（默认规则），不设 skipPermission
  handler: async (args: any) => {
    const { id, ...changes } = args
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
      priority: { type: 'array', items: { type: 'string', enum: ['high', 'medium', 'low'] } },
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
