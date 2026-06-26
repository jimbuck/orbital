import { useState } from 'react'
import { FolderOpen, GitBranch, Loader2 } from 'lucide-react'
import { useStore } from '@renderer/store'
import { ModalShell, ghostBtn } from './ModalRoot'

export default function AddWorkspace(): React.JSX.Element {
  const closeModal = useStore((s) => s.closeModal)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The native folder picker lives in main; a non-null result means a Workspace
  // (and its root Flight) was created and pushed into the store.
  const choose = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const workspace = await window.orbital.addWorkspace()
      if (workspace) closeModal()
      else setBusy(false) // dialog cancelled — keep the modal open
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open that folder as a workspace.')
      setBusy(false)
    }
  }

  return (
    <ModalShell
      title="Add workspace"
      subtitle="Open a local git repo in Orbital"
      width={500}
      onClose={closeModal}
      footer={
        <button type="button" className={ghostBtn} onClick={closeModal}>
          Cancel
        </button>
      }
    >
      <p className="text-[12.5px] leading-relaxed text-text-3 text-pretty">
        Point Orbital at a folder that already contains a git repository. We will register it as a workspace so you can
        launch Flights against it.
      </p>

      <button
        type="button"
        onClick={choose}
        disabled={busy}
        className="mt-4 flex w-full items-center justify-center gap-2.5 rounded-btn bg-accent px-4 py-3 text-[13px] font-bold text-[#06122e] hover:bg-[#6a9dff] transition-colors disabled:opacity-60 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-accent/60 outline-none"
      >
        {busy ? (
          <Loader2 size={16} strokeWidth={1.5} className="animate-spin" />
        ) : (
          <FolderOpen size={16} strokeWidth={1.5} />
        )}
        {busy ? 'Opening…' : 'Choose folder…'}
      </button>

      <div className="mt-3 flex items-center gap-2.5 rounded-btn border border-green/20 bg-green/[0.06] px-3 py-2.5">
        <GitBranch size={14} strokeWidth={1.5} className="flex-none text-green-2" />
        <span className="text-[11.5px] text-green-2">A root Flight on the repo&rsquo;s current branch is created automatically.</span>
      </div>

      {error && <div className="mt-3 text-[11.5px] text-red-2">{error}</div>}
    </ModalShell>
  )
}
