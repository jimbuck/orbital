import { useEffect } from 'react'
import { useStore } from './store'
import { useResolvedTheme } from './lib/theme'
import { applyAccentColor, useAccentColor } from './lib/accent'
import TitleBar from './components/TitleBar'
import Rail from './components/rail/Rail'
import PaneGroup from './components/body/PaneGroup'
import RightPanel from './components/panel/RightPanel'
import ModalRoot from './components/modals/ModalRoot'

/**
 * Mirrors the resolved theme onto <html data-theme> so the light override in
 * app.css activates. Rendered once; before settings load the resolved theme is
 * 'dark', which matches the CSS defaults so there is no flash.
 */
function ThemeManager(): null {
  const theme = useResolvedTheme()
  const accent = useAccentColor()
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  // The accent overrides the theme's accent tokens inline on <html>, derived
  // for the resolved theme (a colour that reads on dark does not on white), so
  // it has to be recomputed on a theme flip as well as on a change of colour.
  useEffect(() => {
    applyAccentColor(document.documentElement, accent, theme)
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
    </div>
  )
}
