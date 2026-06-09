import { ipcMain, BrowserWindow } from 'electron'
import { listTasks, getTask, createTask, updateTask, markTaskSeen, snoozeTask, listTaskActivities } from '../tasks'
import { sendMessage, getChatHistory, confirmAction, triggerFirstMessage, listModels, getSelectedModel, setSelectedModel, stopStream, resetSession } from '../agent'
import { getL0Content, setL0Content, searchMemory, listMemory, updateMemory, deleteMemory } from '../memory'
import { listJobs, toggleJob, getJobLastSummary, createJob, updateJob, deleteJob, runJob } from '../jobs'
import { getConnectionStatus, disconnect, authenticateGitHub, authenticateMicrosoft, checkCliAvailability, listGhAccounts, switchGhAccount } from '../connections'
import { listProjects, getProject, createProject, updateProject, deleteProject } from '../projects'
import { listRelations, getRelation, createRelation, updateRelation, deleteRelation } from '../relations'
import { getPreferences, setPreferences } from '../preferences'
import { getWeChatStatus, connectWeChat, disconnectWeChat, pushToWeChat, setTargetUser } from '../wechat'
import { setBaseUrl as setWeChatBaseUrl } from '../wechat/connection'
import { getWhatsAppStatus, connectWhatsApp, disconnectWhatsApp, pushToWhatsApp } from '../whatsapp'
import { getTelegramStatus, connectTelegram, disconnectTelegram, pushToTelegram } from '../telegram'
import { getDiscordStatus, connectDiscord, disconnectDiscord, pushToDiscord } from '../discord'
import { listChannels, deliverTo } from '../channels'
import { listSkills, getSkill, toggleSkill, deleteSkill } from '../skills'
import { listSources, syncSource, syncAllSources, browseSkills, installFromMarketplace } from '../skills/sources'
import { getUpdateState, checkForUpdates, downloadUpdate, quitAndInstall } from '../updater'
import { openArtifact, revealArtifact, artifactExists } from '../files'
import { sdkHealth, sdkError } from '../health'

export function registerIpcHandlers(): void {
  // === Tasks ===
  ipcMain.handle('tasks:list', (_, filter) => listTasks(filter))
  ipcMain.handle('tasks:get', (_, id) => getTask(id))
  ipcMain.handle('tasks:create', (_, input) => createTask(input).task)
  ipcMain.handle('tasks:update', (_, id, changes) => updateTask(id, changes))
  ipcMain.handle('tasks:markSeen', (_, id) => markTaskSeen(id))
  ipcMain.handle('tasks:snooze', (_, id, until) => snoozeTask(id, until))
  ipcMain.handle('tasks:listActivities', (_, taskId) => listTaskActivities(taskId))

  // === Chat ===
  ipcMain.handle('chat:send', async (event, message, taskId, attachments) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const onStream = (delta: string) => {
      win?.webContents.send('aide:event', { type: 'chat:stream', taskId, delta })
    }
    try {
      const result = await sendMessage(message, taskId, onStream, attachments)
      return result
    } finally {
      // Always send stream-end, even on error/timeout, to reset UI streaming state
      win?.webContents.send('aide:event', { type: 'chat:stream-end', taskId })
    }
  })
  ipcMain.handle('chat:stopStream', () => stopStream())
  ipcMain.handle('chat:resetSession', (_, taskId) => resetSession(taskId))
  ipcMain.handle('chat:getHistory', (_, taskId) => getChatHistory(taskId))
  ipcMain.handle('chat:confirmAction', (_, actionId, decision, modification) =>
    confirmAction(actionId, decision, modification)
  )
  ipcMain.handle('chat:triggerFirstMessage', (_, taskId) => triggerFirstMessage(taskId))

  // === Models ===
  ipcMain.handle('models:list', () => listModels())
  ipcMain.handle('models:getSelected', () => getSelectedModel())
  ipcMain.handle('models:setSelected', (_, modelId) => setSelectedModel(modelId))

  // === Memory ===
  ipcMain.handle('memory:getL0', () => getL0Content())
  ipcMain.handle('memory:setL0', (_, content) => setL0Content(content, 'user'))
  ipcMain.handle('memory:searchL1', (_, query) => searchMemory(query))
  ipcMain.handle('memory:list', (_, filter) => listMemory(filter))
  ipcMain.handle('memory:update', (_, id, content) => updateMemory(id, content))
  ipcMain.handle('memory:delete', (_, id) => deleteMemory(id))

  // === Jobs ===
  ipcMain.handle('jobs:list', () => listJobs())
  ipcMain.handle('jobs:toggle', (_, id, enabled) => toggleJob(id, enabled))
  ipcMain.handle('jobs:getLastSummary', (_, id) => getJobLastSummary(id))
  ipcMain.handle('jobs:run', (_, id) => runJob(id))
  ipcMain.handle('jobs:create', (_, data) => createJob(data))
  ipcMain.handle('jobs:update', (_, id, data) => updateJob(id, data))
  ipcMain.handle('jobs:delete', (_, id) => deleteJob(id))

  // === Connections ===
  ipcMain.handle('connections:getStatus', () => getConnectionStatus())
  ipcMain.handle('connections:checkCli', () => checkCliAvailability())
  ipcMain.handle('connections:authenticateGitHub', () => authenticateGitHub())
  ipcMain.handle('connections:authenticateMicrosoft', () => authenticateMicrosoft())
  ipcMain.handle('connections:disconnect', (_, type) => disconnect(type))
  ipcMain.handle('connections:listGhAccounts', () => listGhAccounts())
  ipcMain.handle('connections:switchGhAccount', (_, account) => switchGhAccount(account))

  // === Projects ===
  ipcMain.handle('projects:list', () => listProjects())
  ipcMain.handle('projects:get', (_, id) => getProject(id))
  ipcMain.handle('projects:create', (_, input) => createProject(input))
  ipcMain.handle('projects:update', (_, id, changes) => updateProject(id, changes))
  ipcMain.handle('projects:delete', (_, id) => deleteProject(id))

  // === Relations ===
  ipcMain.handle('relations:list', () => listRelations())
  ipcMain.handle('relations:get', (_, id) => getRelation(id))
  ipcMain.handle('relations:create', (_, input) => createRelation(input))
  ipcMain.handle('relations:update', (_, id, changes) => updateRelation(id, changes))
  ipcMain.handle('relations:delete', (_, id) => deleteRelation(id))

  // === Preferences ===
  ipcMain.handle('preferences:get', () => getPreferences())
  ipcMain.handle('preferences:set', (_, prefs) => setPreferences(prefs))

  // === Skills ===
  ipcMain.handle('skills:list', () => listSkills())
  ipcMain.handle('skills:get', (_, id) => getSkill(id))
  ipcMain.handle('skills:toggle', (_, id, enabled) => toggleSkill(id, enabled))
  ipcMain.handle('skills:delete', (_, id) => deleteSkill(id))

  // === Marketplace ===
  ipcMain.handle('marketplace:listSources', () => listSources())
  ipcMain.handle('marketplace:syncSource', (_, id) => syncSource(id))
  ipcMain.handle('marketplace:syncAll', () => syncAllSources())
  ipcMain.handle('marketplace:browse', (_, sourceId) => browseSkills(sourceId))
  ipcMain.handle('marketplace:install', (_, sourceId, path) => installFromMarketplace(sourceId, path))

  // === WeChat ===
  ipcMain.handle('wechat:getStatus', () => getWeChatStatus())
  ipcMain.handle('wechat:connect', () => connectWeChat())
  ipcMain.handle('wechat:disconnect', () => disconnectWeChat())
  ipcMain.handle('wechat:push', (_, text) => pushToWeChat(text))
  ipcMain.handle('wechat:setTargetUser', (_, userId) => setTargetUser(userId))
  ipcMain.handle('wechat:setBaseUrl', (_, url) => setWeChatBaseUrl(url))

  // === WhatsApp ===
  ipcMain.handle('whatsapp:getStatus', () => getWhatsAppStatus())
  ipcMain.handle('whatsapp:connect', () => connectWhatsApp())
  ipcMain.handle('whatsapp:disconnect', (_, clearSession) => disconnectWhatsApp(clearSession))
  ipcMain.handle('whatsapp:push', (_, text) => pushToWhatsApp(text))

  // === Telegram ===
  ipcMain.handle('telegram:getStatus', () => getTelegramStatus())
  ipcMain.handle('telegram:connect', (_, config) => connectTelegram(config))
  ipcMain.handle('telegram:disconnect', (_, clearConfig) => disconnectTelegram(clearConfig))
  ipcMain.handle('telegram:push', (_, text) => pushToTelegram(text))

  // === Discord ===
  ipcMain.handle('discord:getStatus', () => getDiscordStatus())
  ipcMain.handle('discord:connect', (_, config) => connectDiscord(config))
  ipcMain.handle('discord:disconnect', (_, clearConfig) => disconnectDiscord(clearConfig))
  ipcMain.handle('discord:push', (_, text) => pushToDiscord(text))

  // === Channels (unified) ===
  ipcMain.handle('channels:list', () => listChannels())
  ipcMain.handle('channels:deliver', (_, channelId, text) => deliverTo(channelId, text))

  // === Updates ===
  ipcMain.handle('updates:getState', () => getUpdateState())
  ipcMain.handle('updates:check', () => checkForUpdates())
  ipcMain.handle('updates:download', () => downloadUpdate())
  ipcMain.handle('updates:install', () => quitAndInstall())

  // === Files (agent artifacts) ===
  ipcMain.handle('files:open', (_, taskId, ref) => openArtifact(taskId, ref))
  ipcMain.handle('files:reveal', (_, taskId, ref) => revealArtifact(taskId, ref))
  ipcMain.handle('files:exists', (_, taskId, ref) => artifactExists(taskId, ref))

  // === System health ===
  ipcMain.handle('system:health', () => ({ sdk: sdkHealth, sdkError }))
}
