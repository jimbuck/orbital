import { useEffect, useState } from 'react'
import { Download, Plus, Trash2, Upload, Orbit } from 'lucide-react'
import { useStore } from '@renderer/store'
import type { WorkspaceInfo } from '@shared/types'
import { ModalShell, ghostBtn, primaryBtn, inputBase } from './ModalRoot'

/**
 * The workspace picker. Workspaces live in the global DB; each opens as its own
 * window. From here: switch/open, create (by name), delete, and share via
 * Export/Import (a YAML file that recreates the workspace elsewhere).
 */
export default function Workspaces(): React.JSX.Element {
  const closeModal = useStore((s) => s.closeModal)
  const current = useStore((s) => s.workspace)
  const [list, setList] = useState<WorkspaceInfo[] | null>(null)
  const [newName, setNewName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = async (): Promise<void> => setList(await window.orbital.listWorkspaces())
  useEffect(() => {
    // Initial load runs outside `run()` — handle its rejection here so an IPC
    // failure surfaces an error instead of hanging on "Loading…" forever.
    refresh().catch((e) => {
      setList([])
      setError(e instanceof Error ? e.message : 'Failed to load workspaces.')
    })
  }, [])

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setError(null)
    setNotice(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.')
    }
  }

  const open = (ws: WorkspaceInfo): Promise<void> =>
    run(async () => {
      await window.orbital.openWorkspace(ws.id)
      closeModal() // launched (or refocused) its window — done here
    })

  const create = (): Promise<void> =>
    run(async () => {
      const name = newName.trim()
      if (!name) return
      const info = await window.orbital.createWorkspace(name)
      if (info) closeModal() // the new workspace's window is opening
    })

  const remove = (ws: WorkspaceInfo): Promise<void> =>
    run(async () => {
      setList(await window.orbital.removeWorkspace(ws.id))
      setConfirmDelete(null)
    })

  const exportWs = (ws: WorkspaceInfo): Promise<void> =>
    run(async () => {
      const file = await window.orbital.exportWorkspace(ws.id)
      if (file) setNotice(`Exported "${ws.name}" to ${file}`)
    })

  const importWs = (): Promise<void> =>
    run(async () => {
      const info = await window.orbital.importWorkspace()
      if (info) {
        await refresh()
        setNotice(`Imported "${info.name}" — click it to open.`)
      }
    })

  const iconBtn =
    'grid size-6 flex-none place-items-center rounded-[6px] text-faint opacity-0 transition-opacity hover:bg-hover hover:text-text group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent/60 outline-none'

  return (
    <ModalShell
      title="Workspaces"
      subtitle="Group projects into workspaces — each opens in its own window"
      width={560}
      onClose={closeModal}
      footer={
        <>
          <button type="button" className={ghostBtn} onClick={() => void importWs()}>
            <Upload size={14} strokeWidth={1.5} />
            Import…
          </button>
          <div className="flex flex-1 items-center justify-end gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void create()
              }}
              placeholder="New workspace name…"
              className={`${inputBase} max-w-[220px]`}
            />
            <button type="button" className={primaryBtn} disabled={!newName.trim()} onClick={() => void create()}>
              <Plus size={14} strokeWidth={1.5} />
              Create
            </button>
          </div>
        </>
      }
    >
      {list === null ? (
        <div className="text-[12px] text-faint">Loading…</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {list.map((ws) => {
            const isCurrent = ws.id === current?.id
            const deleting = confirmDelete === ws.id
            return (
              <div
                key={ws.id}
                className={`group flex items-center gap-3 rounded-card border px-3 py-2.5 ${
                  isCurrent ? 'border-accent/35 bg-accent/[0.07]' : 'border-line bg-bg hover:bg-hover'
                }`}
              >
                <Orbit size={15} strokeWidth={1.5} className={`flex-none ${isCurrent ? 'text-accent' : 'text-dim'}`} />
                <button
                  type="button"
                  onClick={() => void open(ws)}
                  className="min-w-0 flex-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/60 rounded-md"
                  title={isCurrent ? 'This window' : `Open ${ws.name} in its own window`}
                >
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[12.5px] font-semibold text-text-2">{ws.name}</span>
                    {isCurrent && (
                      <span className="flex-none rounded-chip bg-accent/15 px-2 py-0.5 text-[10px] font-bold text-blue">
                        current
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-[10.5px] text-dim">
                    {ws.projectCount} project{ws.projectCount === 1 ? '' : 's'}
                  </span>
                </button>

                {deleting ? (
                  <span className="flex flex-none items-center gap-1.5">
                    <span className="text-[10.5px] font-semibold text-red-2">Delete workspace + its tasks?</span>
                    <button
                      type="button"
                      onClick={() => void remove(ws)}
                      className="rounded-btn bg-red/15 px-2 py-1 text-[10.5px] font-bold text-red-2 hover:bg-red/25 outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                    >
                      Confirm
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(null)}
                      className="rounded-btn px-2 py-1 text-[10.5px] font-semibold text-text-3 hover:bg-hover outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <>
                    <button
                      type="button"
                      aria-label={`Export ${ws.name}`}
                      title="Export to a shareable YAML file"
                      onClick={() => void exportWs(ws)}
                      className={iconBtn}
                    >
                      <Download size={13} strokeWidth={1.5} />
                    </button>
                    {!isCurrent && (
                      <button
                        type="button"
                        aria-label={`Delete ${ws.name}`}
                        title="Delete this workspace (repos on disk are untouched)"
                        onClick={() => setConfirmDelete(ws.id)}
                        className={iconBtn}
                      >
                        <Trash2 size={13} strokeWidth={1.5} />
                      </button>
                    )}
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}

      {notice && <div className="mt-3 text-[11.5px] text-green-2">{notice}</div>}
      {error && <div className="mt-3 text-[11.5px] text-red-2">{error}</div>}
    </ModalShell>
  )
}
