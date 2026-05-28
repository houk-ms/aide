import { create } from 'zustand'
import type { Project, Relation, Job, ConnectionStatus, UserPreferences } from '@shared/types'

interface SettingsStore {
  isOpen: boolean
  activeTab: 'connections' | 'projects' | 'relations' | 'jobs' | 'memory' | 'preferences'
  projects: Project[]
  relations: Relation[]
  jobs: Job[]
  connections: ConnectionStatus[]
  preferences: UserPreferences | null

  open: (tab?: SettingsStore['activeTab']) => void
  close: () => void
  setTab: (tab: SettingsStore['activeTab']) => void

  fetchProjects: () => Promise<void>
  fetchRelations: () => Promise<void>
  fetchJobs: () => Promise<void>
  fetchConnections: () => Promise<void>
  fetchPreferences: () => Promise<void>
  setPreferences: (prefs: Partial<UserPreferences>) => Promise<void>
  disconnect: (type: 'workiq' | 'github') => Promise<void>
}

export const useSettingsStore = create<SettingsStore>((set) => ({
  isOpen: false,
  activeTab: 'connections',
  projects: [],
  relations: [],
  jobs: [],
  connections: [],
  preferences: null,

  open: (tab) => set({ isOpen: true, activeTab: tab || 'connections' }),
  close: () => set({ isOpen: false }),
  setTab: (tab) => set({ activeTab: tab }),

  fetchProjects: async () => {
    const projects = await window.aide.projects.list()
    set({ projects })
  },

  fetchRelations: async () => {
    const relations = await window.aide.relations.list()
    set({ relations })
  },

  fetchJobs: async () => {
    const jobs = await window.aide.jobs.list()
    set({ jobs })
  },

  fetchConnections: async () => {
    const connections = await window.aide.connections.getStatus()
    set({ connections })
  },

  fetchPreferences: async () => {
    const preferences = await window.aide.preferences.get()
    set({ preferences })
  },

  setPreferences: async (prefs) => {
    await window.aide.preferences.set(prefs)
    const preferences = await window.aide.preferences.get()
    set({ preferences })
  },

  disconnect: async (type) => {
    await window.aide.connections.disconnect(type)
    const connections = await window.aide.connections.getStatus()
    set({ connections })
  }
}))
