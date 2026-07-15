import { spawn, ChildProcess } from 'child_process'
import { getMcpConfig, getMcpEnv, getNodeEnv } from '../connections'
import { BrowserWindow } from 'electron'
import type { Tool } from '@github/copilot-sdk'

// ============================================================
// MCP Server Manager — Spawns and communicates with MCP servers
// Uses JSON-RPC over stdio (MCP protocol standard)
// ============================================================

interface McpServer {
  process: ChildProcess
  type: 'workiq' | 'github'
  tools: Tool<any>[]
  ready: boolean
  requestId: number
  pendingRequests: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>
  buffer: string
}

const servers = new Map<string, McpServer>()

// === Start MCP Server ===

export async function startMcpServer(type: 'workiq' | 'github'): Promise<Tool[]> {
  // Don't start if already running
  const existing = servers.get(type)
  if (existing?.ready) return existing.tools

  // Get credentials
  const env = getMcpEnv(type)
  if (!env) throw new Error(`No credentials for ${type}. Please authenticate first.`)

  const config = getMcpConfig()[type]
  
  // Use getNodeEnv to ensure npx.cmd can find node.exe on Windows
  const proc = spawn(config.command, config.args, {
    env: getNodeEnv(env),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true
  })

  const server: McpServer = {
    process: proc,
    type,
    tools: [],
    ready: false,
    requestId: 0,
    pendingRequests: new Map(),
    buffer: ''
  }

  servers.set(type, server)

  // Handle stdout (JSON-RPC responses)
  proc.stdout?.on('data', (data: Buffer) => {
    server.buffer += data.toString()
    processBuffer(server)
  })

  proc.stderr?.on('data', (data: Buffer) => {
    console.error(`[MCP ${type}] stderr:`, data.toString())
  })

  proc.on('exit', (code) => {
    console.log(`[MCP ${type}] exited with code ${code}`)
    servers.delete(type)
  })

  proc.on('error', (err) => {
    console.error(`[MCP ${type}] spawn error:`, err)
    servers.delete(type)
  })

  // Initialize MCP session
  await sendRequest(server, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: { tools: {} },
    clientInfo: { name: 'aide', version: '1.0.0' }
  })

  // Send initialized notification
  sendNotification(server, 'notifications/initialized', {})

  // WorkIQ: auto-accept EULA via MCP protocol (required before other tools work)
  if (type === 'workiq') {
    try {
      await sendRequest(server, 'tools/call', {
        name: 'accept_eula',
        arguments: { eulaUrl: 'https://github.com/microsoft/work-iq' }
      })
      console.log(`[MCP workiq] EULA accepted via MCP protocol`)
    } catch (err) {
      console.warn(`[MCP workiq] EULA accept failed (may already be accepted):`, err)
    }
  }

  // Discover tools
  const toolsResult = await sendRequest(server, 'tools/list', {})
  // Filter out:
  // - accept_eula: already handled internally at startup
  // - write/send tools: blocked by authorization system, no need to expose to LLM
  const HIDDEN_TOOLS = new Set([
    'accept_eula',
    'send_email_work_iq',
    'send_message_work_iq',
    'reply_email_work_iq',
    'forward_email_work_iq',
    'reply_message_work_iq'
  ])
  server.tools = (toolsResult.tools || [])
    .filter((t: any) => !HIDDEN_TOOLS.has(t.name))
    .map((t: any) => mcpToolToSdkTool(t, server))
    .filter((t: any): t is Tool<any> => t !== null)
  server.ready = true

  console.log(`[MCP ${type}] Ready with ${server.tools.length} tools`)
  return server.tools
}

// === Stop MCP Server ===

export function stopMcpServer(type: 'workiq' | 'github'): void {
  const server = servers.get(type)
  if (!server) return
  server.process.kill()
  servers.delete(type)
}

export function stopAllMcpServers(): void {
  for (const [type] of servers) {
    stopMcpServer(type as 'workiq' | 'github')
  }
}

// === Get all active MCP tools ===

export function getActiveMcpTools(): Tool<any>[] {
  const tools: Tool<any>[] = []
  for (const server of servers.values()) {
    if (server.ready) tools.push(...server.tools)
  }
  return tools
}

// === JSON-RPC Communication ===

function sendRequest(server: McpServer, method: string, params: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++server.requestId
    server.pendingRequests.set(id, { resolve, reject })

    const message = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    server.process.stdin?.write(message + '\n')

    // tools/call can be very slow (ask_work_iq takes 60-90s), use longer timeout
    const timeoutMs = method === 'tools/call' ? 150_000 : 30_000
    setTimeout(() => {
      if (server.pendingRequests.has(id)) {
        server.pendingRequests.delete(id)
        reject(new Error(`MCP request timed out after ${timeoutMs / 1000}s: ${method} (${JSON.stringify(params).slice(0, 100)})`))
      }
    }, timeoutMs)
  })
}

function sendNotification(server: McpServer, method: string, params: Record<string, unknown>): void {
  const message = JSON.stringify({ jsonrpc: '2.0', method, params })
  server.process.stdin?.write(message + '\n')
}

function processBuffer(server: McpServer): void {
  const lines = server.buffer.split('\n')
  server.buffer = lines.pop() || '' // Keep incomplete line

  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const msg = JSON.parse(line)
      if (msg.id !== undefined && server.pendingRequests.has(msg.id)) {
        const pending = server.pendingRequests.get(msg.id)!
        server.pendingRequests.delete(msg.id)
        if (msg.error) {
          pending.reject(new Error(msg.error.message || 'MCP error'))
        } else {
          pending.resolve(msg.result)
        }
      }
    } catch {
      // Skip malformed lines
    }
  }
}

// === Convert MCP tool descriptor to our SDK Tool interface ===

// Built-in SDK tool names that MCP tools should not override
const SDK_BUILTIN_TOOLS = new Set(['list_agents'])

function mcpToolToSdkTool(mcpTool: { name: string; description?: string; inputSchema?: any }, server: McpServer): Tool<any> | null {
  // Skip tools that conflict with SDK built-ins
  if (SDK_BUILTIN_TOOLS.has(mcpTool.name)) return null

  return {
    name: mcpTool.name,
    description: mcpTool.description || mcpTool.name,
    parameters: mcpTool.inputSchema || { type: 'object', properties: {} },
    handler: async (args: any) => {
      try {
        const result = await sendRequest(server, 'tools/call', {
          name: mcpTool.name,
          arguments: args
        })
        return result.content || result
      } catch (err: any) {
        const msg = err?.message || String(err)
        // Detect permission / auth errors and surface to UI
        const isAuthError = /403|401|unauthorized|forbidden|insufficient.*privileges|consent/i.test(msg)
        if (isAuthError) {
          console.error(`[MCP ${server.type}] Permission error on ${mcpTool.name}:`, msg)
          // Notify renderer about degraded connection
          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send('aide:event', {
              type: 'connection:status',
              connections: [{
                id: server.type,
                type: server.type,
                authenticated: true,
                verified: false,
                checking: false,
                lastError: `Insufficient permissions: ${mcpTool.name} call was denied. A Tenant Admin may need to grant the related Teams/M365 permissions.`
              }]
            })
          }
          return { error: true, message: `Insufficient permissions to access ${mcpTool.name}. Please confirm an M365 admin has granted the required Graph API permissions (Chat.Read, ChannelMessage.Read, etc.).` }
        }
        // Return non-auth errors as result so the model can see the message and self-correct
        console.error(`[MCP ${server.type}] Tool ${mcpTool.name} error:`, msg)
        return { error: true, message: msg }
      }
    }
  }
}