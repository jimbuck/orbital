import { useEffect } from 'react'
import { useStore } from './store'
import { useTheme } from './lib/theme'
import { applyAccentColor, useAccentColor } from './lib/accent'
import TitleBar from './components/TitleBar'
import Rail from './components/rail/Rail'
import PaneGroup from './components/body/PaneGroup'
import RightPanel from './components/panel/RightPanel'
import ModalRoot from './components/modals/ModalRoot'
import CommandPalette from './components/palette/CommandPalette'

/**
 * Mirrors the applied theme's id onto <html data-theme>, which is what selects
 * its token block — the light override in app.css for the built-ins, a rule
 * from the generated theme stylesheet for everything else (see lib/theme.ts).
 * Rendered once; before settings load the theme is Orbital Dark, which matches
 * the CSS defaults so there is no flash.
 */
function ThemeManager(): null {
  const theme = useTheme()
  const accent = useAccentColor()
  useEffect(() => {
    document.documentElement.dataset.theme = theme.id
  }, [theme.id])
  // The accent overrides the theme's accent tokens inline on <html>, derived
  // against THIS theme's page background (a colour that reads on Orbital Dark
  // does not on Solarized Light), so it has to be recomputed on a theme change
  // as well as on a change of colour.
  useEffect(() => {
    applyAccentColor(document.documentElement, accent, theme.appearance, theme.bg)
  }, [accent, theme])
  return null
}

/** Short, quiet chime when a new agent flips to needs-attention. */
function playChime(): void {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new Ctx()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = 660
    osc.connect(gain)
    gain.connect(ctx.destination)
    gain.gain.setValueAtTime(0.0001, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4)
    osc.start()
    osc.stop(ctx.currentTime + 0.42)
    osc.onended = () => ctx.close()
  } catch {
    /* audio is best-effort */
  }
}

export default function App(): React.JSX.Element {
  const init = useStore((s) => s.init)
  const ready = useStore((s) => s.ready)

  useEffect(() => {
    void init()
    const off = window.orbital.onAlert((evt) => {
      // Read settings at chime time — no store subscription needed just for this.
      if (evt.rising && useStore.getState().settings?.alerts.sound) playChime()
    })
    return off
  }, [init])

  // The palette's shortcuts arrive from main (Ctrl+Shift+P / Ctrl+Shift+O),
  // which sees the keystroke before xterm can swallow it.
  useEffect(() => window.orbital.onOpenPalette((prefix) => useStore.getState().openPalette(prefix)), [])

  // Plain Ctrl+P is the editor convention for "go to file", but it is also
  // readline's "previous command" — so it is bound HERE, in the renderer, and
  // only while focus is outside a terminal. Shell history keeps working where
  // it matters, and the familiar shortcut works everywhere else.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey || e.key.toLowerCase() !== 'p') return
      const el = document.activeElement
      if (el instanceof HTMLElement && el.closest('.xterm')) return
      e.preventDefault()
      useStore.getState().openPalette('')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg text-text">
      <ThemeManager />
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Rail />
        <main className="flex min-w-0 flex-1 flex-col bg-bg">{ready ? <PaneGroup /> : null}</main>
        <RightPanel />
      </div>
      <ModalRoot />
      <CommandPalette />
    </div>
  )
}
