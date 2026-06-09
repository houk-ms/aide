import type { AideAPI, AideEvent } from '@shared/types'

declare module '*.png' {
  const src: string
  export default src
}

declare global {
  interface Window {
    aide: AideAPI
    aideEvents: {
      on: (callback: (event: AideEvent) => void) => () => void
    }
  }
}
