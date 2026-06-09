import { contextBridge, ipcRenderer } from 'electron'
import type { AideAPI, AideEvent } from '@shared/types'

const api: AideAPI = {
  tasks: {
    list: (filter) => ipcRenderer.invoke('tasks:list', filter),
    get: (id) => ipcRenderer.invoke('tasks:get', id),
    create: (input) => ipcRenderer.invoke('tasks:create', input),
    update: (id, changes) => ipcRenderer.invoke('tasks:update', id, changes),
    markSeen: (id) => ipcRenderer.invoke('tasks:markSeen', id),
    snooze: (id, until) => ipcRenderer.invoke('tasks:snooze', id, until),
    listActivities: (taskId) => ipcRenderer.invoke('tasks:listActivities', taskId)
  },
  chat: {
    send: (message, taskId, attachments) => ipcRenderer.invoke('chat:send', message, taskId, attachments),
    getHistory: (taskId) => ipcRenderer.invoke('chat:getHistory', taskId),
    confirmAction: (actionId, decision, modification) =>
      ipcRenderer.invoke('chat:confirmAction', actionId, decision, modification),
    triggerFirstMessage: (taskId) => ipcRenderer.invoke('chat:triggerFirstMessage', taskId),
    stopStream: () => ipcRenderer.invoke('chat:stopStream'),
    resetSession: (taskId) => ipcRenderer.invoke('chat:resetSession', taskId)
  },
  models: {
    list: () => ipcRenderer.invoke('models:list'),
    getSelected: () => ipcRenderer.invoke('models:getSelected'),
    setSelected: (modelId) => ipcRenderer.invoke('models:setSelected', modelId)
  },
  memory: {
    getL0: () => ipcRenderer.invoke('memory:getL0'),
    setL0: (content) => ipcRenderer.invoke('memory:setL0', content),
    searchL1: (query) => ipcRenderer.invoke('memory:searchL1', query),
    list: (filter) => ipcRenderer.invoke('memory:list', filter),
    update: (id, content) => ipcRenderer.invoke('memory:update', id, content),
    delete: (id) => ipcRenderer.invoke('memory:delete', id)
  },
  jobs: {
    list: () => ipcRenderer.invoke('jobs:list'),
    toggle: (id, enabled) => ipcRenderer.invoke('jobs:toggle', id, enabled),
    getLastSummary: (id) => ipcRenderer.invoke('jobs:getLastSummary', id),
    run: (id) => ipcRenderer.invoke('jobs:run', id),
    create: (data) => ipcRenderer.invoke('jobs:create', data),
    update: (id, data) => ipcRenderer.invoke('jobs:update', id, data),
    delete: (id) => ipcRenderer.invoke('jobs:delete', id)
  },
  connections: {
    getStatus: () => ipcRenderer.invoke('connections:getStatus'),
    checkCli: () => ipcRenderer.invoke('connections:checkCli'),
    authenticateGitHub: () => ipcRenderer.invoke('connections:authenticateGitHub'),
    authenticateMicrosoft: () => ipcRenderer.invoke('connections:authenticateMicrosoft'),
    disconnect: (type) => ipcRenderer.invoke('connections:disconnect', type),
    listGhAccounts: () => ipcRenderer.invoke('connections:listGhAccounts'),
    switchGhAccount: (account) => ipcRenderer.invoke('connections:switchGhAccount', account)
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    get: (id) => ipcRenderer.invoke('projects:get', id),
    create: (input) => ipcRenderer.invoke('projects:create', input),
    update: (id, changes) => ipcRenderer.invoke('projects:update', id, changes),
    delete: (id) => ipcRenderer.invoke('projects:delete', id)
  },
  relations: {
    list: () => ipcRenderer.invoke('relations:list'),
    get: (id) => ipcRenderer.invoke('relations:get', id),
    create: (input) => ipcRenderer.invoke('relations:create', input),
    update: (id, changes) => ipcRenderer.invoke('relations:update', id, changes),
    delete: (id) => ipcRenderer.invoke('relations:delete', id)
  },
  preferences: {
    get: () => ipcRenderer.invoke('preferences:get'),
    set: (prefs) => ipcRenderer.invoke('preferences:set', prefs)
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    get: (id) => ipcRenderer.invoke('skills:get', id),
    toggle: (id, enabled) => ipcRenderer.invoke('skills:toggle', id, enabled),
    delete: (id) => ipcRenderer.invoke('skills:delete', id)
  },
  marketplace: {
    listSources: () => ipcRenderer.invoke('marketplace:listSources'),
    syncSource: (id) => ipcRenderer.invoke('marketplace:syncSource', id),
    syncAll: () => ipcRenderer.invoke('marketplace:syncAll'),
    browse: (sourceId?) => ipcRenderer.invoke('marketplace:browse', sourceId),
    install: (sourceId, path) => ipcRenderer.invoke('marketplace:install', sourceId, path)
  },
  wechat: {
    getStatus: () => ipcRenderer.invoke('wechat:getStatus'),
    connect: () => ipcRenderer.invoke('wechat:connect'),
    disconnect: () => ipcRenderer.invoke('wechat:disconnect'),
    push: (text) => ipcRenderer.invoke('wechat:push', text),
    setTargetUser: (userId) => ipcRenderer.invoke('wechat:setTargetUser', userId),
    setBaseUrl: (url) => ipcRenderer.invoke('wechat:setBaseUrl', url)
  },
  whatsapp: {
    getStatus: () => ipcRenderer.invoke('whatsapp:getStatus'),
    connect: () => ipcRenderer.invoke('whatsapp:connect'),
    disconnect: (clearSession) => ipcRenderer.invoke('whatsapp:disconnect', clearSession),
    push: (text) => ipcRenderer.invoke('whatsapp:push', text)
  },
  telegram: {
    getStatus: () => ipcRenderer.invoke('telegram:getStatus'),
    connect: (config) => ipcRenderer.invoke('telegram:connect', config),
    disconnect: (clearConfig) => ipcRenderer.invoke('telegram:disconnect', clearConfig),
    push: (text) => ipcRenderer.invoke('telegram:push', text)
  },
  discord: {
    getStatus: () => ipcRenderer.invoke('discord:getStatus'),
    connect: (config) => ipcRenderer.invoke('discord:connect', config),
    disconnect: (clearConfig) => ipcRenderer.invoke('discord:disconnect', clearConfig),
    push: (text) => ipcRenderer.invoke('discord:push', text)
  },
  channels: {
    list: () => ipcRenderer.invoke('channels:list'),
    deliver: (channelId, text) => ipcRenderer.invoke('channels:deliver', channelId, text)
  },
  updates: {
    getState: () => ipcRenderer.invoke('updates:getState'),
    check: () => ipcRenderer.invoke('updates:check'),
    download: () => ipcRenderer.invoke('updates:download'),
    install: () => ipcRenderer.invoke('updates:install')
  },
  files: {
    open: (taskId, ref) => ipcRenderer.invoke('files:open', taskId, ref),
    reveal: (taskId, ref) => ipcRenderer.invoke('files:reveal', taskId, ref),
    exists: (taskId, ref) => ipcRenderer.invoke('files:exists', taskId, ref)
  },
  system: {
    health: () => ipcRenderer.invoke('system:health')
  }
}

// Expose API to renderer
contextBridge.exposeInMainWorld('aide', api)

// Event listener for main → renderer events
contextBridge.exposeInMainWorld('aideEvents', {
  on: (callback: (event: AideEvent) => void) => {
    const handler = (_: unknown, event: AideEvent) => callback(event)
    ipcRenderer.on('aide:event', handler)
    return () => ipcRenderer.removeListener('aide:event', handler)
  }
})
