import { ipcMain, BrowserWindow } from 'electron'
import { listTasks, getTask, createTask, updateTask, markTaskSeen, snoozeTask } from '../tasks'
import { sendMessage, getChatHistory, confirmAction, triggerFirstMessage, listModels, getSelectedModel, setSelectedModel, stopStream, resetSession } from '../agent'
import { getL0Content, setL0Content, searchMemory, listMemory, updateMemory, deleteMemory } from '../memory'
import { listJobs, toggleJob, getJobLastSummary, createJob, updateJob, deleteJob, runJob } from '../jobs'
import { getConnectionStatus, disconnect, authenticateGitHub, authenticateMicrosoft, checkCliAvailability, listGhAccounts, switchGhAccount } from '../connections'
import { listProjects, getProject, createProject, updateProject, deleteProject } from '../projects'
import { listRelations, getRelation, createRelation, updateRelation, deleteRelation } from '../relations'
import { getPreferences, setPreferences } from '../preferences'
import { sdkHealth, sdkError } from '../health'

export function registerIpcHandlers(): void {
  // === Tasks ===
  ipcMain.handle('tasks:list', (_, filter) => listTasks(filter))
  ipcMain.handle('tasks:get', (_, id) => getTask(id))
  ipcMain.handle('tasks:create', (_, input) => createTask(input).task)
  ipcMain.handle('tasks:update', (_, id, changes) => updateTask(id, changes))
  ipcMain.handle('tasks:markSeen', (_, id) => markTaskSeen(id))
  ipcMain.handle('tasks:snooze', (_, id, until) => snoozeTask(id, until))

  // === Chat ===
  ipcMain.handle('chat:send', async (event, message, taskId, attachments) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const onStream = (delta: string) => {
      win?.webContents.send('aide:event', { type: 'chat:stream', taskId, delta })
    }
    const result = await sendMessage(message, taskId, onStream, attachments)
    win?.webContents.send('aide:event', { type: 'chat:stream-end', taskId })
    return result
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

  // === System health ===
  ipcMain.handle('system:health', () => ({ sdk: sdkHealth, sdkError }))
}
