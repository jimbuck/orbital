import { useEffect, useState } from 'react'
import { useStore } from '@renderer/store'
import { ModalShell, ghostBtn } from './ModalRoot'
import type { UpdateStatus } from '@shared/types'

/** Human line for the updater's current state, shown under the version. */
function updateLine(s: UpdateStatus): string {
  switch (s.phase) {
    case 'disabled':
      return 'Auto-update is off in dev builds.'
    case 'checking':
      return 'Checking for updates…'
    case 'downloading':
      return `Downloading v${s.version ?? '?'}… ${s.percent ?? 0}%`
    case 'ready':
      return `v${s.version ?? '?'} downloaded — restart to apply.`
    case 'uptodate':
      return 'You are on the latest version.'
    case 'error':
      return `Update check failed: ${s.error ?? 'unknown error'}`
    default:
      return 'Updates are checked automatically.'
  }
}

/** A small "About Orbital" surface reached from Help ▸ About. */
export default function About(): React.JSX.Element {
  const closeModal = useStore((s) => s.closeModal)
  const updateStatus = useStore((s) => s.updateStatus)
  const [version, setVersion] = useState('')

  useEffect(() => {
    void window.orbital.getVersion().then(setVersion)
  }, [])

  return (
    <ModalShell
      title="About Orbital"
      width={460}
      onClose={closeModal}
      footer={
        <>
          {updateStatus.phase === 'ready' ? (
            <button type="button" className={ghostBtn} onClick={() => window.orbital.installUpdate()}>
              Restart to update
            </button>
          ) : (
            <button
              type="button"
              className={`${ghostBtn} disabled:cursor-not-allowed disabled:opacity-50`}
              disabled={updateStatus.phase === 'checking' || updateStatus.phase === 'downloading'}
              onClick={() => void window.orbital.checkForUpdates()}
            >
              Check for Updates
            </button>
          )}
          <button type="button" className={ghostBtn} onClick={closeModal}>
            Close
          </button>
        </>
      }
    >
      <div className="flex items-center gap-3">
        {/* Orbit logo mark. */}
        <div className="relative size-7 flex-none">
          <div className="absolute inset-0 rounded-full border-[1.4px] border-accent/55" />
          <div className="absolute left-1/2 top-1/2 -ml-[4px] -mt-[4px] size-2 rounded-full bg-accent shadow-[0_0_9px_rgba(79,140,255,0.9)]" />
        </div>
        <div>
          <div className="text-[16px] font-bold tracking-[0.2px]">Orbital</div>
          <div className="font-mono text-[11px] text-dim">
            {version ? `v${version}` : '…'} · get work done from orbit
          </div>
        </div>
      </div>

      <p className="mt-2 text-[11.5px] text-text-3">{updateLine(updateStatus)}</p>

      <p className="mt-4 text-[12.5px] leading-relaxed text-text-3">
        A native cockpit for running many interactive coding-agent sessions side by side — each in its own git
        worktree, each grouping its terminals, browser previews, and a file/diff viewer — with an at-a-glance signal
        of which agent needs you. Orbital hosts real terminals and spends no tokens of its own.
      </p>

      <div className="mt-4 grid grid-cols-[88px_1fr] gap-x-3 gap-y-1.5 text-[12px]">
        <span className="text-faint">Stack</span>
        <span className="text-text-3">Electron · React · Tailwind · node-pty · xterm.js · SQLite</span>
        <span className="text-faint">CLI</span>
        <span className="font-mono text-text-3">orbital status · flights · flight new · tab new · task add</span>
      </div>
    </ModalShell>
  )
}
