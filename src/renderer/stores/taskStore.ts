import { create } from 'zustand'
import type { Task, TaskFilter, CreateTaskInput } from '@shared/types'

export type ViewMode = 'dashboard' | 'chat'

interface TaskStore {
  tasks: Task[]
  selectedTaskId: string | null
  viewMode: ViewMode
  loading: boolean

  fetchTasks: (filter?: TaskFilter) => Promise<void>
  selectTask: (id: string | null) => void
  setViewMode: (mode: ViewMode) => void
  goHome: () => void
  createTask: (input: CreateTaskInput) => Promise<Task>
  updateTask: (id: string, changes: Partial<Task>) => Promise<void>
  markSeen: (id: string) => Promise<void>
  snooze: (id: string, until: string) => Promise<void>
  completeTask: (id: string) => Promise<void>
  cancelTask: (id: string) => Promise<void>
}

export const useTaskStore = create<TaskStore>((set, get) => ({
  tasks: [],
  selectedTaskId: null,
  viewMode: 'dashboard' as ViewMode,
  loading: false,

  fetchTasks: async (filter) => {
    set({ loading: true })
    const tasks = await window.aide.tasks.list(filter)
    set({ tasks, loading: false })
  },

  selectTask: (id) => {
    set({ selectedTaskId: id })
    if (id) {
      window.aide.tasks.markSeen(id)
    }
  },

  setViewMode: (mode) => {
    set({ viewMode: mode, selectedTaskId: null })
  },

  goHome: () => {
    set({ viewMode: 'dashboard', selectedTaskId: null })
  },

  createTask: async (input) => {
    const task = await window.aide.tasks.create(input)
    const tasks = await window.aide.tasks.list()
    set({ tasks })
    return task
  },

  updateTask: async (id, changes) => {
    await window.aide.tasks.update(id, changes)
    const tasks = await window.aide.tasks.list()
    set({ tasks })
  },

  markSeen: async (id) => {
    await window.aide.tasks.markSeen(id)
    set(state => ({
      tasks: state.tasks.map(t => t.id === id ? { ...t, seenAt: new Date().toISOString() } : t)
    }))
  },

  snooze: async (id, until) => {
    await window.aide.tasks.snooze(id, until)
    const tasks = await window.aide.tasks.list()
    set({ tasks })
  },

  completeTask: async (id) => {
    await window.aide.tasks.update(id, { status: 'completed' })
    const tasks = await window.aide.tasks.list()
    set({ tasks })
  },

  cancelTask: async (id) => {
    await window.aide.tasks.update(id, { status: 'cancelled' })
    const tasks = await window.aide.tasks.list()
    set({ tasks })
  }
}))
