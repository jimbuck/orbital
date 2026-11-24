import { useMemo, useState } from 'react'
import { CircleAlert, ClipboardPaste, Link2 } from 'lucide-react'
import { Spinner } from '@renderer/lib/status'
import { cleanIpcError } from '@renderer/lib/ipcError'
import { AZURE_LINK_HINT, parseAzureRepoUrl } from '@shared/azure-devops'
import { ModalShell, primaryBtn, ghostBtn, inputBase, fieldLabel } from './ModalRoot'
import {
  ADD_REPO_WIDTH,
  ErrorText,
  ParentDirField,
  rememberParentDir,
  useDefaultParentDir,
  type SourceProps
} from './AddRepoGithub'

/** The clipboard's text, or nothing when it cannot be read. */
function clipboardText(): string {
  try {
    return window.orbital.readClipboard() ?? ''
  } catch {
    return ''
  }
}

/**
 * Clone from Azure DevOps: paste the repository's link, pick where it goes.
 *
 * There is no picker to browse, on purpose. Listing an organization's
 * repositories would take the Azure CLI, its DevOps extension and a sign-in of
 * its own, and the clone would still be git's with git's credentials. A link
 * needs none of that: whoever can clone the repository in a terminal can clone
 * it here. So the form does the one thing that makes a link pleasant, which is
 * to read it back (organization, project, repository) before anything runs,
 * and it takes whatever was copied: the Clone button's link, the SSH address,
 * or the address bar of any page of the repository.
 *
 * The link is usually on the clipboard already, copied a moment ago in the
 * browser, so the field starts with it when it is one.
 */
export function CloneFromAzure({ modeSwitch, onDone, onAdded, projectId, folderId }: SourceProps): React.JSX.Element {
  const defaultParent = useDefaultParentDir(projectId)
  // Only ever a link that reads as a repository, and never a token in one.
  const [copied] = useState(() => parseAzureRepoUrl(clipboardText())?.cloneUrl ?? '')
  const [link, setLink] = useState(copied)
  const [parentDir, setParentDir] = useState(defaultParent)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const ref = useMemo(() => parseAzureRepoUrl(link), [link])
  const typed = link.trim() !== ''
  const canSubmit = Boolean(ref && parentDir.trim()) && !busy

  const submit = async (): Promise<void> => {
    if (!ref || !canSubmit) return
    setBusy(true)
    setError(null)
    try {
      // The link as read, not as typed: that is the one without a token in it.
      await window.orbital.azureCloneRepo(ref.cloneUrl, parentDir.trim(), projectId, folderId)
      rememberParentDir(parentDir.trim())
      onAdded()
    } catch (e) {
      setError(cleanIpcError(e) || 'Could not clone the repository.')
      setBusy(false)
    }
  }

  const onEnter = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void submit()
    }
  }

  const paste = (): void => {
    const text = clipboardText().trim()
    if (text) setLink(text)
  }

  return (
    <ModalShell
      title="Add repo"
      subtitle="Clone a repository from Azure DevOps"
      width={ADD_REPO_WIDTH}
      onClose={onDone}
      footer={
        <>
          <button type="button" className={ghostBtn} onClick={onDone}>
            Cancel
          </button>
          <button type="button" className={primaryBtn} onClick={submit} disabled={!canSubmit}>
            {busy && <Spinner className="text-[14px]" />}
            {busy ? 'Cloning…' : 'Clone repository'}
          </button>
        </>
      }
    >
      {modeSwitch}

      <label className={fieldLabel} htmlFor="az-link">
        Repository link <span className="font-normal text-faint">· from the Clone button, or any page of the repository</span>
      </label>
      <div className="mt-1.5 flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Link2
            size={13}
            strokeWidth={1.5}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"
          />
          <input
            id="az-link"
            autoFocus
            value={link}
            disabled={busy}
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={onEnter}
            placeholder="https://dev.azure.com/organization/project/_git/repository"
            spellCheck={false}
            aria-invalid={typed && !ref}
            aria-describedby="az-link-status"
            className={`pl-8 font-mono ${inputBase} disabled:opacity-50`}
          />
        </div>
        <button type="button" onClick={paste} disabled={busy} className={`${ghostBtn} flex-none px-3`}>
          <ClipboardPaste size={14} strokeWidth={1.5} />
          Paste
        </button>
      </div>

      <div id="az-link-status" aria-live="polite">
        {ref ? (
          <>
            <dl className="mt-2 grid grid-cols-3 gap-px overflow-hidden rounded-btn border border-line-2 bg-line-2">
              <Part label="Organization" value={ref.organization} />
              <Part label="Project" value={ref.project} />
              <Part label="Repository" value={ref.repository} />
            </dl>
            <div className="mt-1.5 text-[11px] leading-snug text-dim">
              {ref.transport === 'ssh'
                ? 'Cloned over SSH, with the key git already uses.'
                : 'Cloned with git and the sign-in it already has. With none, Git Credential Manager asks in its own window.'}
              {link.trim() === copied && ' Filled in from your clipboard.'}
            </div>
            {ref.droppedToken && (
              <div className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-snug text-amber-2">
                <CircleAlert size={12} strokeWidth={1.5} className="mt-px flex-none" />
                The token in this link is left out. Cloning with it would save it in the repo&rsquo;s git config in
                plain text; git asks for it instead and stores it with your other credentials.
              </div>
            )}
          </>
        ) : typed ? (
          <div className="mt-2 flex items-start gap-1.5 text-[11px] leading-snug text-red-2">
            <CircleAlert size={12} strokeWidth={1.5} className="mt-px flex-none" />
            <span>That is not an Azure DevOps repository link. {AZURE_LINK_HINT}</span>
          </div>
        ) : (
          <div className="mt-2 text-[11px] leading-snug text-dim">
            In Azure DevOps, open the repository, choose Clone and copy the HTTPS or SSH link. The address of the page
            you are on works too.
          </div>
        )}
      </div>

      <ParentDirField id="az-dir" value={parentDir} onChange={setParentDir} dirName={ref?.dirName ?? ''} disabled={busy} />

      <ErrorText error={error} />
    </ModalShell>
  )
}

/** One part of the link, read back. */
function Part({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="min-w-0 bg-bg px-3 py-2">
      <dt className="text-[10.5px] text-faint">{label}</dt>
      <dd title={value} className="allow-select mt-px truncate font-mono text-[12px] text-text-2">
        {value}
      </dd>
    </div>
  )
}
