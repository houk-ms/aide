// ============================================================
// SDK Client Factory — @github/copilot-sdk
// ============================================================

import { CopilotClient } from '@github/copilot-sdk'
import { join } from 'node:path'

export async function createClient(): Promise<CopilotClient> {
  try {
    // Use the native binary directly — avoids npm-loader.js which requires Node 24+
    const cliPath = join(__dirname, '..', '..', 'node_modules', '@github', 'copilot-win32-x64', 'copilot.exe')
    const client = new CopilotClient({ cliPath, useStdio: false })
    await client.start()
    console.log('[Aide] Copilot SDK client started.')
    return client
  } catch (err: any) {
    console.error('[Aide] Failed to start Copilot SDK:', err.message)
    throw err
  }
}
