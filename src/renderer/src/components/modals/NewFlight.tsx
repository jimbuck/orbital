import { useState } from 'react'
import { Check, FolderGit2 } from 'lucide-react'
import { useStore, activeWorkspace } from '@renderer/store'
import type { Workspace } from '@shared/types'
import { ModalShell, primaryBtn, ghostBtn, inputBase, fieldLabel } from './ModalRoot'

export default function NewFlight(): React.JSX.Element {
  const closeModal = useStore((s) => s.closeModal)
  const setActiveFlight = useStore((s) => s.setActiveFlight)
  const fromData = useStore((s) => s.modalData) as Workspace | null
  const fallback = useStore(activeWorkspace)
  const workspace = fromData ?? fallback

  const [branch, setBranch] = useState('')
  const [name, setName] = useState('')
  const [baseRef, setBaseRef] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // No workspace to target — surface a clear message instead of a broken form.
  if (!workspace) {
    return (
      <ModalShell
        title="New Flight"
        width={500}
        onClose={closeModal}
        footer={
          <button type="button" className={ghostBtn} onClick={closeModal}>
            Close
          </button>
        }
      >
        <p className="text-[12.5px] text-text-3">Add a workspace first, then create a Flight on it.</p>
      </ModalShell>
    )
  }

  const submit = async (): Promise<void> => {
    const trimmedBranch = branch.trim()
    if (!trimmedBranch) {
      setError('Branch name is required.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const flight = await window.orbital.createFlight(workspace.id, {
        branch: trimmedBranch,
        name: name.trim() || trimmedBranch,
        worktree: true,
        baseRef: baseRef.trim() || undefined
      })
      setActiveFlight(flight.id)
      closeModal()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create the Flight.')
      setBusy(false)
    }
  }

  const onEnter = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <ModalShell
      title="New Flight"
      subtitle={`Creates a git worktree and a Flight · ${workspace.name}`}
      width={500}
      onClose={closeModal}
      footer={
        <>
          <button type="button" className={ghostBtn} onClick={closeModal}>
            Cancel
          </button>
          <button type="button" className={primaryBtn} onClick={submit} disabled={busy || !branch.trim()}>
            Create Flight
          </button>
        </>
      }
    >
      <label className={fieldLabel} htmlFor="nf-branch">
        Branch name
      </label>
      <input
        id="nf-branch"
        autoFocus
        value={branch}
        onChange={(e) => setBranch(e.target.value)}
        onKeyDown={onEnter}
        placeholder="feat/cli-flags"
        aria-invalid={Boolean(error && !branch.trim())}
        className={`mt-1.5 font-mono ${inputBase}`}
      />

      <label className={`${fieldLabel} mt-4 block`} htmlFor="nf-name">
        Flight name <span className="font-normal text-faint">· optional</span>
      </label>
      <input
        id="nf-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={onEnter}
        placeholder="Defaults to the branch name"
        className={`mt-1.5 ${inputBase}`}
      />

      <label className={`${fieldLabel} mt-4 block`} htmlFor="nf-base">
        Base ref <span className="font-normal text-faint">· optional</span>
      </label>
      <input
        id="nf-base"
        value={baseRef}
        onChange={(e) => setBaseRef(e.target.value)}
        onKeyDown={onEnter}
        placeholder="HEAD"
        className={`mt-1.5 font-mono ${inputBase}`}
      />

      <div className="mt-3.5 flex items-center gap-2.5 rounded-btn border border-green/20 bg-green/[0.06] px-3 py-2.5">
        <Check size={14} strokeWidth={1.5} className="flex-none text-green-2" />
        <span className="text-[11.5px] text-green-2">
          A worktree is created and your <span className="font-mono">.env</span> files are synced in.
        </span>
      </div>

      <div className="mt-2.5 flex items-center gap-2 text-[11px] text-dim">
        <FolderGit2 size={13} strokeWidth={1.5} className="flex-none text-faint" />
        <span className="truncate font-mono">{workspace.repoPath}</span>
      </div>

      {error && <div className="mt-3 text-[11.5px] text-red-2">{error}</div>}
    </ModalShell>
  )
}
