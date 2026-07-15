import { useEffect, useState } from 'react'
import { FolderOpen, Plus, X, Orbit } from 'lucide-react'
import { useStore } from '@renderer/store'
import type { WorkspaceInfo } from '@shared/types'
import { ModalShell, ghostBtn, primaryBtn } from './ModalRoot'

/**
 * The workspace picker: recently-opened workspaces from the global registry,
 * plus "open a workspace file" and "create a new workspace". Each workspace
 * runs as its own instance — picking one launches (or refocuses) that instance
 * and leaves this window on its current workspace.
 */
export default function Workspaces(): React.JSX.Element {
  const closeModal = useStore((s) => s.closeModal)
  const current = useStore((s) => s.workspace)
  const [recents, setRecents] = useState<WorkspaceInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.orbital.listWorkspaces().then(setRecents)
  }, [])

  const open = async (configPath?: string): Promise<void> => {
    setError(null)
    try {
      const info = await window.orbital.openWorkspace(configPath)
      if (info) closeModal() // launched (or refocused) — done here
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open that workspace file.')
    }
  }

  const create = async (): Promise<void> => {
    setError(null)
    try {
      const info = await window.orbital.createWorkspace()
      if (info) closeModal()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the workspace.')
    }
  }

  const removeRecent = async (configPath: string): Promise<void> => {
    setRecents(await window.orbital.removeRecentWorkspace(configPath))
  }

  return (
    <ModalShell
      title="Workspaces"
      subtitle="Each workspace is a YAML file of projects and opens in its own window"
      width={540}
      onClose={closeModal}
      footer={
        <>
          <button type="button" className={ghostBtn} onClick={() => void open()}>
            <FolderOpen size={14} strokeWidth={1.5} />
            Open workspace file…
          </button>
          <button type="button" className={primaryBtn} onClick={() => void create()}>
            <Plus size={14} strokeWidth={1.5} />
            New workspace…
          </button>
        </>
      }
    >
      {recents === null ? (
        <div className="text-[12px] text-faint">Loading…</div>
      ) : recents.length === 0 ? (
        <div className="text-[12px] text-faint">
          No workspaces yet. Create one to group projects into a separate window, or open a workspace file someone
          shared with you.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {recents.map((ws) => {
            const isCurrent = ws.configPath === current?.configPath
            return (
              <div
                key={ws.configPath}
                className={`group flex items-center gap-3 rounded-card border px-3 py-2.5 ${
                  isCurrent ? 'border-accent/35 bg-accent/[0.07]' : 'border-line bg-bg hover:bg-hover'
                }`}
              >
                <Orbit size={15} strokeWidth={1.5} className={`flex-none ${isCurrent ? 'text-accent' : 'text-dim'}`} />
                <button
                  type="button"
                  onClick={() => void open(ws.configPath)}
                  className="min-w-0 flex-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/60 rounded-md"
                  title={ws.configPath}
                >
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[12.5px] font-semibold text-text-2">{ws.name}</span>
                    {isCurrent && (
                      <span className="flex-none rounded-chip bg-accent/15 px-2 py-0.5 text-[10px] font-bold text-blue">
                        current
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-[10.5px] text-dim">{ws.configPath}</span>
                </button>
                {!isCurrent && (
                  <button
                    type="button"
                    aria-label={`Remove ${ws.name} from recent workspaces`}
                    title="Remove from this list (the file is not touched)"
                    onClick={() => void removeRecent(ws.configPath)}
                    className="grid size-6 flex-none place-items-center rounded-[6px] text-faint opacity-0 transition-opacity hover:bg-hover hover:text-text group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent/60 outline-none"
                  >
                    <X size={13} strokeWidth={1.5} />
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {error && <div className="mt-3 text-[11.5px] text-red-2">{error}</div>}
    </ModalShell>
  )
}
