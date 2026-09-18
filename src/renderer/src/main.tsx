import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installThemeStyles } from './lib/theme'
import '@xterm/xterm/css/xterm.css'
import './app.css'

// Before the first render: a pinned theme should paint on frame one rather
// than flash the built-in dark while React mounts.
installThemeStyles()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
