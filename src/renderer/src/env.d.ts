/// <reference types="vite/client" />

import type { OrbitalApi } from '@shared/types'

declare global {
  interface Window {
    orbital: OrbitalApi
  }
}

export {}
