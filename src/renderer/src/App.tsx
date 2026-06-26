import { useEffect, useRef } from 'react'
import { useStore } from './store'
import TitleBar from './components/TitleBar'
import Rail from './components/rail/Rail'
import PaneGroup from './components/body/PaneGroup'
import RightPanel from './components/panel/RightPanel'
import ModalRoot from './components/modals/ModalRoot'

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
  const settingsRef = useRef(useStore.getState().settings)
  settingsRef.current = useStore((s) => s.settings)

  useEffect(() => {
    void init()
    const off = window.orbital.onAlert((evt) => {
      if (evt.rising && settingsRef.current?.alerts.sound) playChime()
    })
    return off
  }, [init])

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg text-text">
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
