// SDK health state — isolated to avoid circular imports

export let sdkHealth: 'initializing' | 'ready' | 'error' = 'initializing'
export let sdkError: string | null = null

export function setSdkHealth(status: typeof sdkHealth, error?: string): void {
  sdkHealth = status
  sdkError = error ?? null
}
