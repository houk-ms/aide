import type { AideAPI, AideEvent } from '@shared/types'

declare global {
  interface Window {
    aide: AideAPI
    aideEvents: {
      on: (callback: (event: AideEvent) => void) => () => void
    }
  }
}
