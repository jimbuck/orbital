/// <reference types="vite/client" />

import type { OrbitalApi } from '@shared/contract'

declare global {
  interface Window {
    orbital: OrbitalApi
  }
}

export {}
