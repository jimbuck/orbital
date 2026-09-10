import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Building2,
  Check,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  FolderDown,
  FolderOpen,
  Globe,
  Loader2,
  Lock,
  RefreshCw,
  Search
} from 'lucide-react'
import { useStore } from '@renderer/store'
import { cleanIpcError } from '@renderer/lib/ipcError'
import {
  parseNameWithOwner,
  suggestRepoName,
  validateRepoName,
  type GithubContext,
  type GithubCreatedRepo,
  type GithubRepoSummary,
  type GithubVisibility
} from '@shared/github'
import { ModalShell, primaryBtn, ghostBtn, inputBase, fieldLabel } from './ModalRoot'
import { SegmentedControl, type SegmentedOption } from '../SegmentedControl'
import { Select } from './Select'

/** Panel width shared by all three Add Project modes so switching does not resize the dialog. */
export const ADD_PROJECT_WIDTH = 560

/* ============================================================================
 * GitHub context (who am I, my orgs, template lists) — loaded once per dialog
 * ========================================================================== */

export type GithubLoad =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; ctx: GithubContext }
  | { status: 'error'; error: string }

export interface GithubState {
  load: GithubLoad
  reload: () => void
}

/**
 * Fetches the gh context the first time `enabled` is true and keeps it for the
 * dialog's lifetime. A failure (gh missing, signed out, offline) is held as a
 * message with a retry, since the fix is usually a `gh auth login` in another
 * window followed by "try again" here.
 */
export function useGithubContext(enabled: boolean): GithubState {
  const [load, setLoad] = useState<GithubLoad>({ status: 'idle' })
  const [attempt, setAttempt] = useState(0)
  const started = useRef(-1)

  useEffect(() => {
    if (!enabled || started.current === attempt) return
    started.current = attempt
    let alive = true
    setLoad({ status: 'loading' })
    window.orbital
      .githubContext()
      .then((ctx) => alive && setLoad({ status: 'ready', ctx }))
      .catch((e) => alive && setLoad({ status: 'error', error: cleanIpcError(e) }))
    return () => {
      alive = false
    }
  }, [enabled, attempt])

  const reload = useCallback(() => setAttempt((n) => n + 1), [])
  return { load, reload }
}

/* ============================================================================
 * Shared bits
 * ========================================================================== */

const VISIBILITY_LABEL: Record<GithubVisibility, string> = {
  public: 'Public',
  private: 'Private',
  internal: 'Internal'
}

/**
 * The folder most recently cloned into during this app run, so a second clone
 * defaults next to the first. Falls back to the parent of an existing project.
 */
let rememberedParentDir = ''

function parentOf(path: string): string {
  return path.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, '')
}

/** Join with whichever separator `parent` already uses; the renderer has no `path`. */
export function joinPath(parent: string, name: string): string {
  const p = parent.replace(/[\\/]+$/, '')
  if (!p) return name
  const sep = p.includes('\\') ? '\\' : '/'
  return `${p}${sep}${name}`
}

function useDefaultParentDir(): string {
  const firstRepo = useStore((s) => s.projects[0]?.repoPath)
  return rememberedParentDir || (firstRepo ? parentOf(firstRepo) : '')
}

/** "3d ago"-style stamp for the repo picker. */
export function timeAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.round(d / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.round(d / 365)}y ago`
}

/** The gh-context loading / failure row shown above both GitHub forms. */
function GithubStatus({ state }: { state: GithubState }): React.JSX.Element | null {
  const { load, reload } = state
  if (load.status === 'ready') return null
  if (load.status === 'error') {
    return (
      <div
        role="alert"
        className="mb-4 flex items-start gap-2 rounded-[7px] border border-red/25 bg-red/10 px-2.5 py-2"
      >
        <CircleAlert size={13} strokeWidth={1.5} className="mt-px flex-none text-red-2" />
        <span className="allow-select min-w-0 flex-1 break-words text-[11.5px] leading-snug text-red-2">
          {load.error}
        </span>
        <button
          type="button"
          onClick={reload}
          className="flex-none rounded-[5px] px-1.5 py-0.5 text-[11px] font-semibold text-red-2/80 hover:bg-red/15 hover:text-red-2 focus-visible:ring-2 focus-visible:ring-accent/60 outline-none"
        >
          <span className="inline-flex items-center gap-1">
            <RefreshCw size={11} strokeWidth={1.5} /> Retry
          </span>
        </button>
      </div>
    )
  }
  return (
    <div className="mb-4 flex items-center gap-2 text-[11.5px] text-dim">
      <Loader2 size={13} strokeWidth={1.5} className="animate-spin text-faint" />
      Checking GitHub CLI sign-in…
    </div>
  )
}

/** A local parent-folder field with a native Browse button and the resulting clone path. */
function ParentDirField({
  id,
  value,
  onChange,
  dirName,
  disabled
}: {
  id: string
  value: string
  onChange: (v: string) => void
  dirName: string
  disabled?: boolean
}): React.JSX.Element {
  const [picking, setPicking] = useState(false)
  const browse = async (): Promise<void> => {
    setPicking(true)
    try {
      const dir = await window.orbital.pickDirectory('Choose where to clone')
      if (dir) onChange(dir)
    } finally {
      setPicking(false)
    }
  }
  return (
    <>
      <label className={`${fieldLabel} mt-4 block`} htmlFor={id}>
        Local folder <span className="font-normal text-faint">· the repository is cloned into a folder inside it</span>
      </label>
      <div className="mt-1.5 flex gap-2">
        <input
          id={id}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          placeholder="C:\Projects"
          className={`font-mono ${inputBase} disabled:opacity-50`}
        />
        <button
          type="button"
          onClick={browse}
          disabled={disabled || picking}
          className={`${ghostBtn} flex-none px-3`}
          aria-label="Browse for a folder"
        >
          {picking ? (
            <Loader2 size={14} strokeWidth={1.5} className="animate-spin" />
          ) : (
            <FolderOpen size={14} strokeWidth={1.5} />
          )}
          Browse…
        </button>
      </div>
      {value.trim() && dirName && (
        <div className="mt-2 flex items-center gap-2 text-[11px] text-dim">
          <FolderDown size={13} strokeWidth={1.5} className="flex-none text-faint" />
          <span className="truncate font-mono">{joinPath(value.trim(), dirName)}</span>
        </div>
      )}
    </>
  )
}

function Checkbox({
  checked,
  onChange,
  disabled,
  children
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  children: ReactNode
}): React.JSX.Element {
  return (
    <label
      className={`flex w-fit select-none items-center gap-1.5 text-[11.5px] ${
        disabled ? 'cursor-not-allowed text-faint' : 'cursor-pointer text-text-3 hover:text-text-2'
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="size-3 accent-accent"
      />
      {children}
    </label>
  )
}

function ErrorText({ error }: { error: string | null }): React.JSX.Element | null {
  if (!error) return null
  return (
    <div role="alert" className="allow-select mt-3 break-words text-[11.5px] leading-snug text-red-2">
      {error}
    </div>
  )
}

function VisibilityIcon({ visibility }: { visibility: GithubVisibility }): React.JSX.Element {
  const cls = 'flex-none text-faint'
  if (visibility === 'public') return <Globe size={12} strokeWidth={1.5} className={cls} />
  if (visibility === 'internal') return <Building2 size={12} strokeWidth={1.5} className={cls} />
  return <Lock size={12} strokeWidth={1.5} className={cls} />
}

interface FormProps {
  github: GithubState
  modeSwitch: ReactNode
  onDone: () => void
}

/* ============================================================================
 * Clone from GitHub
 * ========================================================================== */

type RepoLoad =
  | { status: 'loading' }
  | { status: 'ready'; repos: GithubRepoSummary[] }
  | { status: 'error'; error: string }

export function CloneFromGithub({ github, modeSwitch, onDone }: FormProps): React.JSX.Element {
  const ctx = github.load.status === 'ready' ? github.load.ctx : null
  const defaultParent = useDefaultParentDir()

  const [owner, setOwner] = useState('')
  const [query, setQuery] = useState('')
  const [repos, setRepos] = useState<RepoLoad>({ status: 'loading' })
  const [selected, setSelected] = useState('')
  const [parentDir, setParentDir] = useState(defaultParent)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The owner picker defaults to the signed-in user once the context lands.
  const effectiveOwner = owner || ctx?.user || ''

  useEffect(() => {
    if (!effectiveOwner) return
    let alive = true
    setRepos({ status: 'loading' })
    window.orbital
      .githubListRepos(effectiveOwner)
      .then((list) => alive && setRepos({ status: 'ready', repos: list }))
      .catch((e) => alive && setRepos({ status: 'error', error: cleanIpcError(e) }))
    return () => {
      alive = false
    }
  }, [effectiveOwner])

  const q = query.trim().toLowerCase()
  const visible = useMemo(() => {
    if (repos.status !== 'ready') return []
    if (!q) return repos.repos
    return repos.repos.filter(
      (r) => r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)
    )
  }, [repos, q])

  // Typing `owner/repo` offers that exact repository too — it may live under
  // an owner that is not in the picker (a repo you were given access to).
  const typed = parseNameWithOwner(query)
  const typedNameWithOwner = typed ? `${typed.owner}/${typed.name}` : ''
  const typedIsListed = Boolean(typedNameWithOwner) && visible.some((r) => r.nameWithOwner === typedNameWithOwner)

  const dirName = selected.split('/').pop() ?? ''
  const canSubmit = Boolean(ctx && selected && parentDir.trim()) && !busy

  const submit = async (): Promise<void> => {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      await window.orbital.githubCloneRepo(selected, parentDir.trim())
      rememberedParentDir = parentDir.trim()
      onDone()
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

  return (
    <ModalShell
      title="Add project"
      subtitle="Clone one of your GitHub repositories"
      width={ADD_PROJECT_WIDTH}
      onClose={onDone}
      footer={
        <>
          <button type="button" className={ghostBtn} onClick={onDone}>
            Cancel
          </button>
          <button type="button" className={primaryBtn} onClick={submit} disabled={!canSubmit}>
            {busy && <Loader2 size={14} strokeWidth={1.5} className="animate-spin" />}
            {busy ? 'Cloning…' : 'Clone repository'}
          </button>
        </>
      }
    >
      {modeSwitch}
      <GithubStatus state={github} />

      <div className="flex gap-3">
        <div className="w-[190px] flex-none">
          <label className={fieldLabel} htmlFor="gh-clone-owner">
            Owner
          </label>
          <Select id="gh-clone-owner" value={effectiveOwner} onChange={setOwner} mono disabled={!ctx || busy}>
            {!ctx && <option value="">…</option>}
            {ctx?.owners.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
        </div>
        <div className="min-w-0 flex-1">
          <label className={fieldLabel} htmlFor="gh-clone-search">
            Repository
          </label>
          <div className="relative mt-1.5">
            <Search
              size={13}
              strokeWidth={1.5}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"
            />
            <input
              id="gh-clone-search"
              autoFocus
              value={query}
              disabled={!ctx || busy}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onEnter}
              placeholder="Search, or type owner/repo"
              className={`pl-8 ${inputBase} disabled:opacity-50`}
            />
          </div>
        </div>
      </div>

      <div
        role="listbox"
        aria-label="Repositories"
        className="mt-2 max-h-[224px] overflow-y-auto rounded-btn border border-line-2 bg-bg"
      >
        {typed && !typedIsListed && (
          <RepoRow
            selected={selected === typedNameWithOwner}
            onSelect={() => setSelected(typedNameWithOwner)}
            onActivate={submit}
            title={typedNameWithOwner}
            subtitle="Clone this repository by name"
          />
        )}
        {repos.status === 'loading' && (
          <div className="flex items-center gap-2 px-3 py-3 text-[11.5px] text-dim">
            <Loader2 size={13} strokeWidth={1.5} className="animate-spin text-faint" />
            Loading repositories…
          </div>
        )}
        {repos.status === 'error' && (
          <div className="allow-select px-3 py-3 text-[11.5px] text-red-2">{repos.error}</div>
        )}
        {repos.status === 'ready' && visible.length === 0 && !typed && (
          <div className="px-3 py-3 text-[11.5px] text-dim">
            {q ? 'No repositories match. Type owner/repo to clone one by name.' : 'No repositories under this owner.'}
          </div>
        )}
        {visible.map((r) => (
          <RepoRow
            key={r.nameWithOwner}
            selected={selected === r.nameWithOwner}
            onSelect={() => setSelected(r.nameWithOwner)}
            onActivate={submit}
            title={r.name}
            subtitle={r.description}
            visibility={r.visibility}
            flags={[r.isArchived ? 'Archived' : '', r.isTemplate ? 'Template' : '', r.isEmpty ? 'Empty' : ''].filter(
              Boolean
            )}
            stamp={timeAgo(r.pushedAt)}
          />
        ))}
      </div>

      <ParentDirField id="gh-clone-dir" value={parentDir} onChange={setParentDir} dirName={dirName} disabled={busy} />

      <ErrorText error={error} />
    </ModalShell>
  )
}

function RepoRow({
  selected,
  onSelect,
  onActivate,
  title,
  subtitle,
  visibility,
  flags = [],
  stamp
}: {
  selected: boolean
  onSelect: () => void
  onActivate: () => void
  title: string
  subtitle?: string
  visibility?: GithubVisibility
  flags?: string[]
  stamp?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      onDoubleClick={onActivate}
      className={`flex w-full items-center gap-2.5 border-b border-soft px-3 py-2 text-left last:border-b-0 transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 outline-none ${
        selected ? 'bg-accent/15' : 'hover:bg-hover'
      }`}
    >
      <span className="grid size-4 flex-none place-items-center">
        {selected ? (
          <Check size={13} strokeWidth={2} className="text-blue" />
        ) : (
          visibility && <VisibilityIcon visibility={visibility} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className={`truncate font-mono text-[12px] ${selected ? 'text-blue' : 'text-text-2'}`}>{title}</span>
          {visibility && (
            <span className="flex-none rounded-[4px] border border-line-2 px-1 text-[9.5px] font-semibold uppercase tracking-[0.4px] text-muted">
              {VISIBILITY_LABEL[visibility]}
            </span>
          )}
          {flags.map((f) => (
            <span
              key={f}
              className="flex-none rounded-[4px] border border-line-2 px-1 text-[9.5px] font-semibold uppercase tracking-[0.4px] text-faint"
            >
              {f}
            </span>
          ))}
        </span>
        {subtitle && <span className="mt-px block truncate text-[11px] text-dim">{subtitle}</span>}
      </span>
      {stamp && <span className="flex-none text-[10.5px] text-faint">{stamp}</span>}
    </button>
  )
}

/* ============================================================================
 * Create on GitHub
 * ========================================================================== */

const VISIBILITIES: readonly SegmentedOption<GithubVisibility>[] = [
  { value: 'private', label: 'Private' },
  { value: 'public', label: 'Public' },
  { value: 'internal', label: 'Internal' }
]
/** Without an organization owner, `internal` is not an option GitHub accepts. */
const USER_VISIBILITIES = VISIBILITIES.filter((v) => v.value !== 'internal')

type NameCheck =
  | { state: 'idle' }
  | { state: 'invalid'; reason: string }
  | { state: 'checking' }
  | { state: 'ok' }
  | { state: 'taken'; reason: string }
  | { state: 'unknown'; reason: string }

const NAME_CHECK_DEBOUNCE_MS = 450

export function CreateOnGithub({ github, modeSwitch, onDone }: FormProps): React.JSX.Element {
  const ctx = github.load.status === 'ready' ? github.load.ctx : null
  const defaultParent = useDefaultParentDir()

  const [owner, setOwner] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [visibility, setVisibility] = useState<GithubVisibility>('private')
  const [parentDir, setParentDir] = useState(defaultParent)
  const [more, setMore] = useState(false)
  const [homepage, setHomepage] = useState('')
  const [gitignore, setGitignore] = useState('')
  const [license, setLicense] = useState('')
  const [addReadme, setAddReadme] = useState(true)
  const [disableIssues, setDisableIssues] = useState(false)
  const [disableWiki, setDisableWiki] = useState(false)
  const [template, setTemplate] = useState('')
  const [includeAllBranches, setIncludeAllBranches] = useState(false)
  const [team, setTeam] = useState('')

  const [check, setCheck] = useState<NameCheck>({ state: 'idle' })
  const [phase, setPhase] = useState<'idle' | 'creating' | 'cloning'>('idle')
  const [created, setCreated] = useState<GithubCreatedRepo | null>(null)
  const [error, setError] = useState<string | null>(null)

  const effectiveOwner = owner || ctx?.user || ''
  const ownerIsOrg = Boolean(ctx && effectiveOwner && effectiveOwner !== ctx.user)
  const visibilities = ownerIsOrg ? VISIBILITIES : USER_VISIBILITIES
  // Switching from an org back to yourself drops `internal`.
  useEffect(() => {
    if (!ownerIsOrg && visibility === 'internal') setVisibility('private')
  }, [ownerIsOrg, visibility])

  const trimmedName = name.trim()
  const suggestion = suggestRepoName(name)
  const usingTemplate = Boolean(template.trim())

  // Live availability check, debounced, with a stale-reply guard: the reply
  // for "my-ap" must not land after the one for "my-app".
  const checkSeq = useRef(0)
  useEffect(() => {
    const seq = ++checkSeq.current
    if (!trimmedName) {
      setCheck({ state: 'idle' })
      return
    }
    const invalid = validateRepoName(trimmedName)
    if (invalid) {
      setCheck({ state: 'invalid', reason: invalid })
      return
    }
    if (!effectiveOwner) return
    setCheck({ state: 'checking' })
    const timer = window.setTimeout(() => {
      window.orbital
        .githubCheckRepoName(effectiveOwner, trimmedName)
        .then((r) => {
          if (seq !== checkSeq.current) return
          setCheck(r.ok ? { state: 'ok' } : { state: 'taken', reason: r.reason ?? 'That name is taken.' })
        })
        .catch((e) => {
          if (seq === checkSeq.current) setCheck({ state: 'unknown', reason: cleanIpcError(e) })
        })
    }, NAME_CHECK_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [effectiveOwner, trimmedName])

  const busy = phase !== 'idle'
  const nameUsable = check.state === 'ok' || check.state === 'unknown'
  // Once the repository exists on GitHub only the clone can be retried; the
  // name check is moot and the form is frozen so the retry targets the same repo.
  const canSubmit = Boolean(ctx && parentDir.trim()) && !busy && (created ? true : nameUsable)

  const submit = async (): Promise<void> => {
    if (!canSubmit) return
    setError(null)
    let repo = created
    try {
      if (!repo) {
        setPhase('creating')
        repo = await window.orbital.githubCreateRepo({
          owner: effectiveOwner,
          name: trimmedName,
          visibility,
          description,
          homepage,
          gitignore: usingTemplate ? undefined : gitignore,
          license: usingTemplate ? undefined : license,
          addReadme: usingTemplate ? undefined : addReadme,
          disableIssues,
          disableWiki,
          template: usingTemplate ? template.trim() : undefined,
          includeAllBranches: usingTemplate ? includeAllBranches : undefined,
          team: ownerIsOrg ? team : undefined
        })
        setCreated(repo)
      }
      setPhase('cloning')
      await window.orbital.githubCloneRepo(repo.nameWithOwner, parentDir.trim())
      rememberedParentDir = parentDir.trim()
      onDone()
    } catch (e) {
      const msg = cleanIpcError(e) || 'Something went wrong.'
      setError(repo ? `The repository was created at ${repo.url}, but cloning it failed: ${msg}` : msg)
      setPhase('idle')
    }
  }

  const onEnter = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void submit()
    }
  }

  const frozen = busy || Boolean(created)
  const primaryLabel =
    phase === 'creating' ? 'Creating…' : phase === 'cloning' ? 'Cloning…' : created ? 'Retry clone' : 'Create repository'

  return (
    <ModalShell
      title="Add project"
      subtitle="Create a repository on GitHub and clone it"
      width={ADD_PROJECT_WIDTH}
      onClose={onDone}
      footer={
        <>
          <button type="button" className={ghostBtn} onClick={onDone}>
            Cancel
          </button>
          <button type="button" className={primaryBtn} onClick={submit} disabled={!canSubmit}>
            {busy && <Loader2 size={14} strokeWidth={1.5} className="animate-spin" />}
            {primaryLabel}
          </button>
        </>
      }
    >
      {modeSwitch}
      <GithubStatus state={github} />

      <div className="flex gap-3">
        <div className="w-[190px] flex-none">
          <label className={fieldLabel} htmlFor="gh-owner">
            Owner
          </label>
          <Select id="gh-owner" value={effectiveOwner} onChange={setOwner} mono disabled={!ctx || frozen}>
            {!ctx && <option value="">…</option>}
            {ctx?.owners.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
        </div>
        <div className="min-w-0 flex-1">
          <label className={fieldLabel} htmlFor="gh-name">
            Repository name
          </label>
          <input
            id="gh-name"
            autoFocus
            value={name}
            disabled={frozen}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={onEnter}
            placeholder="my-project"
            aria-invalid={check.state === 'invalid' || check.state === 'taken'}
            aria-describedby="gh-name-status"
            className={`font-mono ${inputBase} disabled:opacity-50`}
          />
        </div>
      </div>
      <NameStatus id="gh-name-status" check={check} owner={effectiveOwner} name={trimmedName} suggestion={suggestion} onSuggest={setName} />

      <label className={`${fieldLabel} mt-4 block`} htmlFor="gh-description">
        Description <span className="font-normal text-faint">· optional</span>
      </label>
      <input
        id="gh-description"
        value={description}
        disabled={frozen}
        onChange={(e) => setDescription(e.target.value)}
        onKeyDown={onEnter}
        placeholder="What is this repository for?"
        className={`mt-1.5 ${inputBase} disabled:opacity-50`}
      />

      <div className={`${fieldLabel} mt-4`}>Visibility</div>
      <SegmentedControl
        label="Visibility"
        options={visibilities}
        value={visibility}
        onChange={setVisibility}
        fill
        className="mt-1.5"
      />
      <div className="mt-1.5 text-[11px] text-dim">
        {visibility === 'public'
          ? 'Anyone on the internet can see this repository.'
          : visibility === 'internal'
            ? 'Members of the organization can see this repository.'
            : 'You choose who can see and commit to this repository.'}
      </div>

      <ParentDirField id="gh-dir" value={parentDir} onChange={setParentDir} dirName={trimmedName} disabled={busy} />

      <button
        type="button"
        onClick={() => setMore((v) => !v)}
        aria-expanded={more}
        aria-controls="gh-more"
        className="mt-4 flex items-center gap-1 text-[11.5px] font-semibold text-text-3 hover:text-text-2 focus-visible:ring-2 focus-visible:ring-accent/60 outline-none rounded-[4px]"
      >
        <ChevronRight size={13} strokeWidth={1.5} className={`transition-transform ${more ? 'rotate-90' : ''}`} />
        More options
        <span className="font-normal text-faint">· README, .gitignore, license, template, homepage</span>
      </button>

      {more && (
        <div id="gh-more" className="mt-2 rounded-btn border border-line-2 bg-bg/40 px-3 pb-3 pt-1">
          <div className="flex gap-3">
            <div className="min-w-0 flex-1">
              <label className={`${fieldLabel} mt-2 block`} htmlFor="gh-gitignore">
                .gitignore template
              </label>
              <Select
                id="gh-gitignore"
                value={gitignore}
                onChange={setGitignore}
                mono
                disabled={frozen || !ctx || usingTemplate}
              >
                <option value="">None</option>
                {ctx?.gitignoreTemplates.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </div>
            <div className="min-w-0 flex-1">
              <label className={`${fieldLabel} mt-2 block`} htmlFor="gh-license">
                License
              </label>
              <Select id="gh-license" value={license} onChange={setLicense} disabled={frozen || !ctx || usingTemplate}>
                <option value="">None</option>
                {ctx?.licenses.map((l) => (
                  <option key={l.key} value={l.key}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
            <Checkbox checked={addReadme} onChange={setAddReadme} disabled={frozen || usingTemplate}>
              Add a README
            </Checkbox>
            <Checkbox checked={disableIssues} onChange={setDisableIssues} disabled={frozen}>
              Disable issues
            </Checkbox>
            <Checkbox checked={disableWiki} onChange={setDisableWiki} disabled={frozen}>
              Disable wiki
            </Checkbox>
          </div>

          <label className={`${fieldLabel} mt-3 block`} htmlFor="gh-homepage">
            Homepage URL <span className="font-normal text-faint">· optional</span>
          </label>
          <input
            id="gh-homepage"
            value={homepage}
            disabled={frozen}
            onChange={(e) => setHomepage(e.target.value)}
            onKeyDown={onEnter}
            placeholder="https://example.com"
            className={`mt-1.5 font-mono ${inputBase} disabled:opacity-50`}
          />

          <label className={`${fieldLabel} mt-3 block`} htmlFor="gh-template">
            Template repository{' '}
            <span className="font-normal text-faint">· optional · replaces the README, .gitignore and license</span>
          </label>
          <input
            id="gh-template"
            value={template}
            disabled={frozen}
            onChange={(e) => setTemplate(e.target.value)}
            onKeyDown={onEnter}
            placeholder="owner/template-repo"
            className={`mt-1.5 font-mono ${inputBase} disabled:opacity-50`}
          />
          {usingTemplate && (
            <div className="mt-2">
              <Checkbox checked={includeAllBranches} onChange={setIncludeAllBranches} disabled={frozen}>
                Include all branches from the template
              </Checkbox>
            </div>
          )}

          {ownerIsOrg && (
            <>
              <label className={`${fieldLabel} mt-3 block`} htmlFor="gh-team">
                Team <span className="font-normal text-faint">· optional · organization team granted access</span>
              </label>
              <input
                id="gh-team"
                value={team}
                disabled={frozen}
                onChange={(e) => setTeam(e.target.value)}
                onKeyDown={onEnter}
                placeholder="team-slug"
                className={`mt-1.5 font-mono ${inputBase} disabled:opacity-50`}
              />
            </>
          )}
        </div>
      )}

      {created && !error && (
        <div className="mt-4 flex items-center gap-2.5 rounded-btn border border-green/20 bg-green/[0.06] px-3 py-2.5">
          <Check size={14} strokeWidth={1.5} className="flex-none text-green-2" />
          <span className="min-w-0 truncate text-[11.5px] text-green-2">
            Created <span className="font-mono">{created.nameWithOwner}</span>
          </span>
        </div>
      )}
      <ErrorText error={error} />
      {created && error && (
        <a
          href={created.url}
          target="_blank"
          rel="noreferrer"
          className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-blue hover:underline"
        >
          Open {created.nameWithOwner} on GitHub <ExternalLink size={11} strokeWidth={1.5} />
        </a>
      )}
    </ModalShell>
  )
}

/** The line under the name field: validation, "checking", available, or taken. */
function NameStatus({
  id,
  check,
  owner,
  name,
  suggestion,
  onSuggest
}: {
  id: string
  check: NameCheck
  owner: string
  name: string
  suggestion: string
  onSuggest: (v: string) => void
}): React.JSX.Element {
  const base = 'mt-1.5 flex min-h-[16px] items-center gap-1.5 text-[11px]'
  switch (check.state) {
    case 'idle':
      return (
        <div id={id} className={`${base} text-dim`}>
          Great repository names are short and memorable.
        </div>
      )
    case 'checking':
      return (
        <div id={id} className={`${base} text-dim`}>
          <Loader2 size={12} strokeWidth={1.5} className="animate-spin text-faint" />
          Checking <span className="font-mono">{owner}/{name}</span> on GitHub…
        </div>
      )
    case 'ok':
      return (
        <div id={id} className={`${base} text-green-2`}>
          <Check size={12} strokeWidth={2} />
          <span className="font-mono">{owner}/{name}</span> is available.
        </div>
      )
    case 'invalid':
      return (
        <div id={id} className={`${base} flex-wrap text-red-2`}>
          <CircleAlert size={12} strokeWidth={1.5} />
          {check.reason}
          {suggestion && suggestion !== name && !validateRepoName(suggestion) && (
            <button
              type="button"
              onClick={() => onSuggest(suggestion)}
              className="font-mono text-blue hover:underline focus-visible:ring-2 focus-visible:ring-accent/60 outline-none rounded-[3px]"
            >
              Use {suggestion}?
            </button>
          )}
        </div>
      )
    case 'taken':
      return (
        <div id={id} className={`${base} text-red-2`}>
          <CircleAlert size={12} strokeWidth={1.5} />
          {check.reason}
        </div>
      )
    case 'unknown':
      return (
        <div id={id} className={`${base} text-amber-2`}>
          <CircleAlert size={12} strokeWidth={1.5} />
          Could not check availability: {check.reason}
        </div>
      )
  }
}
