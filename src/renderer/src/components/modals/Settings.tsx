import { useEffect, useState } from 'react'
import { X, Plus, ChevronDown, AlertTriangle } from 'lucide-react'
import { useStore, activeProject } from '@renderer/store'
import type { Settings as SettingsModel, AgentConfig, ProfileDirInfo } from '@shared/types'
import { setThemeMode, useThemeMode, THEME_MODES } from '@renderer/lib/theme'
import {
  SUPPORTED_AGENTS,
  defaultAgentConfigs,
  findAgentConfig,
  formatArgsString,
  nextAgentId,
  nextAgentName,
  normalizeAgentConfigs,
  parseArgsString,
  providerLabel
} from '@shared/types'
import { ModalShell, primaryBtn, ghostBtn, sectionLabel, fieldLabel, inputBase } from './ModalRoot'

/** Common Windows shells offered in the default-shell picker. */
const SHELL_OPTIONS = ['pwsh.exe', 'powershell.exe', 'cmd.exe', 'wsl.exe', 'bash.exe', 'git-bash.exe']

const DEFAULT_ALERTS: SettingsModel['alerts'] = { indicator: true, sound: true, taskbarBadge: false, taskbarFlash: false }

/** A 34×19 pill switch — accent track + white knob when on, dim otherwise. */
export function Toggle({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-[19px] w-[34px] flex-none rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-accent/60 outline-none ${
        checked ? 'bg-accent' : 'bg-line-strong'
      }`}
    >
      <span
        className={`absolute top-[2px] size-[15px] rounded-full transition-all ${
          checked ? 'left-[17px] bg-white' : 'left-[2px] bg-text-3'
        }`}
      />
    </button>
  )
}

/** One labelled alert row with a trailing toggle. */
function AlertRow({
  title,
  desc,
  checked,
  onChange
}: {
  title: string
  desc: string
  checked: boolean
  onChange: (value: boolean) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="text-[12.5px] font-semibold text-text-2">{title}</div>
        <div className="mt-px text-[11px] text-dim">{desc}</div>
      </div>
      <Toggle checked={checked} onChange={onChange} label={title} />
    </div>
  )
}

const envChip =
  'inline-flex items-center gap-2 rounded-[7px] bg-accent/10 border border-accent/25 pl-[11px] pr-[9px] py-[5px] font-mono text-[11.5px] text-blue'

/** Normalized view of one installable file, whichever kind it is. */
interface InstallState {
  installed: boolean
  /** Absolute path of the file Orbital manages for this profile. */
  path: string
  /** Exists but was not written by Orbital — we refuse to overwrite it (skill only). */
  foreign?: boolean
}

/**
 * The three things Orbital can install into an agent profile's directory. Each
 * call names the profile, so a workspace running two Claude profiles installs
 * (and reports) them independently.
 */
const INSTALLABLES = {
  hooks: {
    title: 'Claude status hooks',
    describe: (path: string) => (
      <>
        Let Worktrees report status from Claude&apos;s own lifecycle events — no agent self-reporting
        needed. Writes only to <span className="break-all font-mono text-text-2">{path}</span>, and
        leaves any hooks already there untouched.
      </>
    ),
    installLabel: 'Set up Claude status hooks',
    removeLabel: 'Remove Claude hooks',
    confirmLabel: 'Confirm & write',
    removeConfirmLabel: 'Remove hooks',
    /* Hooks run shell commands with the user's permissions — the one preview that warns. */
    warn: true,
    previewIntro: 'Hooks run shell commands with your full permissions. Review before writing:',
    removeIntro: "Remove Orbital's hook entries from settings.json? Other hooks stay intact.",
    status: async (id: string): Promise<InstallState> => {
      const s = await window.orbital.claudeHooksStatus(id)
      return { installed: s.installed, path: s.settingsPath }
    },
    preview: async (id: string): Promise<string> => (await window.orbital.claudeHooksPlan(id)).json,
    install: (id: string) => window.orbital.installClaudeHooks(id),
    remove: (id: string) => window.orbital.removeClaudeHooks(id)
  },
  skill: {
    title: 'The orbital skill for Claude',
    describe: (path: string) => (
      <>
        Teach Claude the <span className="font-mono text-text-2">orbital</span> CLI — reporting status,
        filing tasks, opening tabs — in sessions Orbital did not boot as an agent tab (a{' '}
        <span className="font-mono text-text-2">claude</span> you start yourself with this profile).
        Agent tabs are already briefed. Writes one file:{' '}
        <span className="break-all font-mono text-text-2">{path}</span>
      </>
    ),
    installLabel: 'Install the orbital skill',
    removeLabel: 'Remove the orbital skill',
    confirmLabel: 'Confirm & write',
    removeConfirmLabel: 'Remove skill',
    warn: false,
    previewIntro: 'Review the skill before writing it:',
    removeIntro: 'Delete the skill Orbital installed? Nothing else in the profile is touched.',
    foreignNote: (
      <>
        A skill named <span className="font-mono">orbital</span> already exists there and was not
        written by Orbital — move or delete it first.
      </>
    ),
    status: async (id: string): Promise<InstallState> => {
      const s = await window.orbital.claudeSkillStatus(id)
      return { installed: s.installed, path: s.skillPath, foreign: s.foreign }
    },
    preview: async (id: string): Promise<string> => (await window.orbital.claudeSkillPlan(id)).markdown,
    install: (id: string) => window.orbital.installClaudeSkill(id),
    remove: (id: string) => window.orbital.removeClaudeSkill(id)
  },
  codex: {
    title: 'Orbital instructions for Codex',
    describe: (path: string) => (
      <>
        Codex takes no per-launch briefing, so it learns the{' '}
        <span className="font-mono text-text-2">orbital</span> CLI from its own always-loaded
        instructions. Orbital merges a short marked block into{' '}
        <span className="break-all font-mono text-text-2">{path}</span>, leaving whatever else is in
        that file alone.
      </>
    ),
    installLabel: 'Install the Codex instructions',
    removeLabel: 'Remove the Codex instructions',
    confirmLabel: 'Confirm & write',
    removeConfirmLabel: 'Remove block',
    warn: false,
    previewIntro: 'Every Codex session using this profile loads this. Review it before writing:',
    removeIntro: "Remove Orbital's block from AGENTS.md? The rest of the file stays intact.",
    status: async (id: string): Promise<InstallState> => {
      const s = await window.orbital.codexInstructionsStatus(id)
      return { installed: s.installed, path: s.path }
    },
    preview: async (id: string): Promise<string> => (await window.orbital.codexInstructionsPlan(id)).markdown,
    install: (id: string) => window.orbital.installCodexInstructions(id),
    remove: (id: string) => window.orbital.removeCodexInstructions(id)
  }
} as const

type InstallKind = keyof typeof INSTALLABLES

/** Which installs each provider offers, in card order. */
const PROVIDER_INSTALLS: Record<string, InstallKind[]> = {
  claude: ['hooks', 'skill'],
  codex: ['codex']
}

/**
 * What the typed profile directory really points at. Nothing expands `~` or
 * `%VAR%` on the way to the agent (it is spawned without a shell), so Orbital
 * expands them itself — and shows the result here, because a path that resolves
 * somewhere unexpected looks exactly like "my profile was ignored": the agent
 * launches into a brand-new profile and asks you to sign in again.
 */
function ProfileDirNote({ provider, configDir }: { provider: string; configDir: string }): React.JSX.Element | null {
  const [info, setInfo] = useState<ProfileDirInfo | null>(null)
  const typed = configDir.trim()

  useEffect(() => {
    let live = true
    setInfo(null)
    if (!typed) return
    // Debounced: this runs on every keystroke in the field, and each call stats a disk path.
    const timer = setTimeout(() => {
      void window.orbital
        .inspectProfileDir(provider, typed)
        .then((r) => live && setInfo(r))
        .catch(() => undefined)
    }, 300)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [provider, typed])

  if (!info) return null
  const expanded = info.path !== typed
  if (info.exists && !expanded) return null // says nothing the field doesn't already
  return (
    <div className={`mt-1.5 text-[11px] ${info.exists ? 'text-dim' : 'text-amber-2'}`}>
      {expanded && (
        <span>
          Resolves to <span className="break-all font-mono">{info.path}</span>
          {info.exists ? '' : ' · '}
        </span>
      )}
      {!info.exists && <span>no directory there yet — the agent would start a fresh profile</span>}
    </div>
  )
}

/**
 * One install/remove panel for a profile — status badge, a preview the user must
 * confirm, and the button. Everything it writes lands in that profile's own
 * directory, so it always reads its state back from disk rather than trusting a
 * stored flag.
 */
function InstallPanel({ agentId, kind }: { agentId: string; kind: InstallKind }): React.JSX.Element {
  const spec = INSTALLABLES[kind]
  const [state, setState] = useState<InstallState | null>(null)
  const [confirm, setConfirm] = useState<{ mode: 'install'; preview: string } | { mode: 'remove' } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setConfirm(null)
    void spec
      .status(agentId)
      .then((s) => live && setState(s))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [agentId, spec])

  const startInstall = async (): Promise<void> => {
    setError(null)
    try {
      setConfirm({ mode: 'install', preview: await spec.preview(agentId) })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not build the preview.')
    }
  }

  const apply = async (): Promise<void> => {
    if (!confirm) return
    setBusy(true)
    setError(null)
    try {
      // install() refuses to touch a file Orbital does not own (or cannot parse),
      // so these can reject — surface that rather than silently failing.
      if (confirm.mode === 'install') await spec.install(agentId)
      else await spec.remove(agentId)
      setState(await spec.status(agentId))
      setConfirm(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update the files.')
    } finally {
      setBusy(false)
    }
  }

  const foreignNote = 'foreignNote' in spec ? spec.foreignNote : null

  return (
    <div className="mt-3 rounded-card border border-line-2 bg-bg/40 p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12.5px] font-semibold text-text-2">{spec.title}</div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-text-3 text-pretty">
            {spec.describe(state?.path ?? '…')}
          </p>
        </div>
        <span
          className={`mt-0.5 flex-none rounded-chip px-2 py-0.5 text-[10px] font-bold ${
            state?.installed ? 'bg-green/15 text-green-2' : 'bg-hover text-dim'
          }`}
        >
          {state?.installed ? 'Installed' : 'Not installed'}
        </span>
      </div>

      {confirm ? (
        <div className="mt-3">
          {confirm.mode === 'install' ? (
            <>
              <div
                className={`flex items-center gap-2 text-[11.5px] ${spec.warn ? 'text-amber-2' : 'text-text-3'}`}
              >
                {spec.warn && <AlertTriangle size={13} strokeWidth={1.5} className="flex-none" />}
                {spec.previewIntro}
              </div>
              {/* Fixed dark code block: pin a light foreground (not a theme token) so
                  the preview stays readable in light mode too. */}
              <pre className="mt-2 max-h-44 overflow-auto rounded-btn border border-line-2 bg-[#0a0d12] p-2.5 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-[#aab2c0]">
                {confirm.preview}
              </pre>
            </>
          ) : (
            <div className="flex items-center gap-2 text-[11.5px] text-text-3">
              <AlertTriangle size={13} strokeWidth={1.5} className="flex-none text-amber-2" />
              {spec.removeIntro}
            </div>
          )}
          <div className="mt-2.5 flex items-center justify-end gap-2">
            <button type="button" className={ghostBtn} onClick={() => setConfirm(null)} disabled={busy}>
              Cancel
            </button>
            <button type="button" className={primaryBtn} onClick={apply} disabled={busy}>
              {confirm.mode === 'install' ? spec.confirmLabel : spec.removeConfirmLabel}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3">
          {state?.installed ? (
            <button type="button" className={ghostBtn} onClick={() => setConfirm({ mode: 'remove' })}>
              {spec.removeLabel}
            </button>
          ) : (
            <button type="button" className={ghostBtn} onClick={startInstall} disabled={state?.foreign}>
              {spec.installLabel}
            </button>
          )}
          {state?.foreign && foreignNote && <div className="mt-2 text-[11px] text-amber-2">{foreignNote}</div>}
        </div>
      )}
      {error && <div className="mt-2.5 text-[11px] text-red-2">{error}</div>}
    </div>
  )
}

export default function Settings(): React.JSX.Element {
  const project = useStore(activeProject)
  const settings = useStore((s) => s.settings)
  const workspace = useStore((s) => s.workspace)
  const closeModal = useStore((s) => s.closeModal)

  // Editable working copies seeded from the current store state.
  const [workspaceName, setWorkspaceName] = useState(() => workspace?.name ?? '')
  const [patterns, setPatterns] = useState<string[]>(() => settings?.envSyncPatterns ?? [])
  const [defaultShell, setDefaultShell] = useState(() => settings?.defaultShell ?? SHELL_OPTIONS[0])
  const [alerts, setAlerts] = useState<SettingsModel['alerts']>(() => settings?.alerts ?? DEFAULT_ALERTS)
  const [periodicFetch, setPeriodicFetch] = useState(() => settings?.periodicFetch ?? true)
  const [debugLogging, setDebugLogging] = useState(() => settings?.debugLogging ?? false)
  // App theme is NOT a working copy: it is applied and persisted the moment it is
  // clicked (see the control below), so it is read live from the store — that way
  // a change made from the View menu while this modal is open shows up here, and
  // Save can never write back a stale theme over it.
  const theme = useThemeMode()
  // The workspace's agent profiles. Existing installs lack the key -> default lineup.
  const [agents, setAgents] = useState<AgentConfig[]>(() => settings?.agents ?? defaultAgentConfigs())
  // Extra-CLI-args fields edit as raw text per profile; parsed into argv on save.
  const [argsDrafts, setArgsDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries((settings?.agents ?? []).map((a) => [a.id, formatArgsString(a.args ?? [])]))
  )
  // The in-progress "KEY=value" env-var input per profile card.
  const [envDrafts, setEnvDrafts] = useState<Record<string, string>>({})
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  // Per-project agent config. A default stored before profiles had ids names a
  // provider — resolve it to the profile it refers to. The fallback is the first
  // CONFIGURED profile, never a hard-coded id: a workspace that dropped Claude
  // would otherwise show (and save) a default pointing at nothing.
  const [agentId, setAgentId] = useState(() => {
    const configured = settings?.agents ?? defaultAgentConfigs()
    return findAgentConfig(configured, project?.defaultAgentId)?.id ?? configured[0]?.id ?? 'claude'
  })
  const [agentExecPath, setAgentExecPath] = useState(() => project?.agentExecPath ?? '')

  const shellOptions = SHELL_OPTIONS.includes(defaultShell) ? SHELL_OPTIONS : [defaultShell, ...SHELL_OPTIONS]

  const updateAgent = (id: string, patch: Partial<AgentConfig>): void =>
    setAgents((cur) => cur.map((a) => (a.id === id ? { ...a, ...patch } : a)))

  /** Add a profile for `provider`, named and keyed so it collides with nothing. */
  const addAgent = (provider: string): void =>
    setAgents((cur) => [
      ...cur,
      {
        id: nextAgentId(
          provider,
          cur.map((a) => a.id)
        ),
        name: nextAgentName(
          provider,
          cur.map((a) => a.name)
        ),
        provider
      }
    ])

  // Never allow emptying the list — there must always be at least one agent
  // available in the new-tab menus. Computed from the current list rather than
  // inside a setAgents updater: those must stay pure (React may run them twice).
  const removeAgent = (id: string): void => {
    if (agents.length <= 1) return
    const next = agents.filter((a) => a.id !== id)
    setAgents(next)
    // The project's default cannot point at a profile that no longer exists.
    if (id === agentId) setAgentId(next[0].id)
  }

  // Commit a card's "KEY=value" env input into its entry's env map.
  const commitEnvDraft = (id: string): void => {
    const draft = envDrafts[id] ?? ''
    const eq = draft.indexOf('=')
    const key = (eq === -1 ? draft : draft.slice(0, eq)).trim()
    const value = eq === -1 ? '' : draft.slice(eq + 1).trim()
    setEnvDrafts((cur) => ({ ...cur, [id]: '' }))
    if (!key) return
    setAgents((cur) => cur.map((a) => (a.id === id ? { ...a, env: { ...a.env, [key]: value } } : a)))
  }

  const removeEnvVar = (id: string, key: string): void =>
    setAgents((cur) =>
      cur.map((a) => {
        if (a.id !== id || !a.env) return a
        const env = { ...a.env }
        delete env[key]
        return { ...a, env }
      })
    )

  const removePattern = (p: string): void => setPatterns((cur) => cur.filter((x) => x !== p))

  const commitDraft = (): void => {
    const value = draft.trim()
    setPatterns((cur) => (value && !cur.includes(value) ? [...cur, value] : cur))
    setDraft('')
    setAdding(false)
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const wsName = workspaceName.trim()
      if (workspace && wsName && wsName !== workspace.name) {
        await window.orbital.renameWorkspace(workspace.id, wsName)
      }
      if (project) {
        await window.orbital.setProjectAgent(project.id, {
          defaultAgentId: agentId,
          agentExecPath: agentExecPath.trim()
        })
      }
      // Fold each card's raw args text back into its entry, then scrub empty
      // fields (blank configDir/execPath, empty args/env) via the normalizer,
      // which also fills a blank name back in.
      const cleanedAgents =
        normalizeAgentConfigs(
          agents.map((a) => ({
            ...a,
            args: parseArgsString(argsDrafts[a.id] ?? formatArgsString(a.args ?? []))
          }))
        ) ?? []
      await window.orbital.setSettings({
        defaultShell,
        alerts,
        envSyncPatterns: patterns,
        periodicFetch,
        debugLogging,
        agents: cleanedAgents,
        theme
      })
      closeModal()
    } finally {
      setSaving(false)
    }
  }

  return (
    <ModalShell
      title="Settings"
      subtitle={`Project · ${project?.name ?? '—'}`}
      width={540}
      onClose={closeModal}
      footer={
        <>
          <button type="button" className={ghostBtn} onClick={closeModal}>
            Cancel
          </button>
          <button type="button" className={primaryBtn} onClick={save} disabled={saving}>
            Save changes
          </button>
        </>
      }
    >
      {/* Workspace */}
      <div className={sectionLabel}>Workspace</div>
      <label className={`${fieldLabel} mt-2.5 block`} htmlFor="workspace-name">
        Name <span className="font-normal text-faint">· shown in the title bar and workspace picker</span>
      </label>
      <input
        id="workspace-name"
        value={workspaceName}
        onChange={(e) => setWorkspaceName(e.target.value)}
        placeholder={workspace?.name ?? 'Workspace name'}
        spellCheck={false}
        className={`mt-1.5 ${inputBase}`}
      />

      <div className="my-[18px] h-px bg-soft" />

      {/* Environment file sync */}
      <div className={sectionLabel}>Environment file sync</div>
      <p className="mt-1.5 text-[12px] leading-relaxed text-text-3 text-pretty">
        Files matching these patterns are copied from the root checkout into every Worktree and kept in sync.
        Applies to all projects.
      </p>
      <div className="mt-3 flex flex-wrap gap-[7px]">
        {patterns.map((p) => (
          <span key={p} className={envChip}>
            {p}
            <button
              type="button"
              aria-label={`Remove ${p}`}
              onClick={() => removePattern(p)}
              className="rounded-sm opacity-55 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-accent/60 outline-none"
            >
              <X size={11} strokeWidth={1.5} />
            </button>
          </span>
        ))}
        {adding ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitDraft()
              else if (e.key === 'Escape') {
                setDraft('')
                setAdding(false)
              }
            }}
            placeholder="**/.env.local"
            className="w-[140px] rounded-[7px] border border-dashed border-line-2 bg-bg px-[11px] py-[5px] font-mono text-[11.5px] text-text-2 placeholder:text-faint focus-visible:ring-2 focus-visible:ring-accent/60 outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1 rounded-[7px] border border-dashed border-line-2 bg-bg px-[11px] py-[5px] font-mono text-[11.5px] text-faint hover:text-text-3 focus-visible:ring-2 focus-visible:ring-accent/60 outline-none"
          >
            <Plus size={12} strokeWidth={1.5} /> add pattern
          </button>
        )}
      </div>

      <div className="my-[18px] h-px bg-soft" />

      {/* Appearance */}
      <div className={sectionLabel}>Appearance</div>
      <div className="mt-2.5 flex items-center justify-between gap-4">
        <span className="text-[12.5px] text-text-2">Theme</span>
        {/* 3-way segmented control. Unlike the other fields here it applies (and
            persists) on click rather than on Save, because the View menu offers
            the same three options and does the same — one shared write path in
            lib/theme.ts keeps the two controls from ever disagreeing, and a theme
            picker you have to Save to see is a poor preview. */}
        <div role="radiogroup" aria-label="Theme" className="flex items-center rounded-[7px] border border-line-2 bg-bg p-[2px]">
          {THEME_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              onClick={() => setThemeMode(mode)}
              aria-checked={theme === mode}
              className={`rounded-[5px] px-2.5 py-[3px] text-[11px] font-semibold capitalize ${
                theme === mode ? 'bg-accent/15 text-blue' : 'text-muted hover:text-text-2'
              } focus-visible:ring-2 focus-visible:ring-accent/60 outline-none`}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      <div className="my-[18px] h-px bg-soft" />

      {/* Terminal */}
      <div className={sectionLabel}>Terminal</div>
      <div className="mt-2.5 flex items-center justify-between gap-4">
        <span className="text-[12.5px] text-text-2">Default shell</span>
        <div className="relative">
          <select
            value={defaultShell}
            onChange={(e) => setDefaultShell(e.target.value)}
            aria-label="Default shell"
            className="appearance-none rounded-btn border border-line-2 bg-bg py-[7px] pl-3 pr-9 text-[12px] text-text-2 focus-visible:ring-2 focus-visible:ring-accent/60 outline-none"
          >
            {shellOptions.map((sh) => (
              <option key={sh} value={sh} className="bg-panel text-text-2">
                {sh}
              </option>
            ))}
          </select>
          <ChevronDown
            size={13}
            strokeWidth={1.5}
            className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-faint"
          />
        </div>
      </div>

      <div className="my-[18px] h-px bg-soft" />

      {/* Git */}
      <div className={sectionLabel}>Git</div>
      <div className="mt-1">
        <AlertRow
          title="Periodic fetch"
          desc="Fetch each repo in the background to keep ahead/behind current"
          checked={periodicFetch}
          onChange={setPeriodicFetch}
        />
      </div>

      <div className="my-[18px] h-px bg-soft" />

      {/* Agents */}
      <div className={sectionLabel}>Agents</div>
      <p className="mt-1.5 text-[12px] leading-relaxed text-text-3 text-pretty">
        An agent tab boots the coding CLI straight into the Worktree&apos;s working directory. Each
        profile below appears in the new-tab menus and launches with its own config directory and
        tweaks — add several of the same agent to keep, say, a personal and a work Claude side by side.
      </p>
      {agents.map((agent) => {
        const meta = SUPPORTED_AGENTS.find((s) => s.id === agent.provider)
        // The install panels write to disk immediately, so they act on the SAVED
        // profile: offering them for an unsaved card (or one whose directory the
        // user just retyped) would write into a directory this agent never reads.
        const saved = (settings?.agents ?? []).find((a) => a.id === agent.id)
        const dirty =
          !saved || saved.provider !== agent.provider || (saved.configDir ?? '') !== (agent.configDir ?? '')
        const installs = PROVIDER_INSTALLS[agent.provider] ?? []
        return (
          <div key={agent.id} className="mt-2.5 rounded-card border border-line-2 bg-bg/40 p-3.5">
            <div className="flex items-center gap-2">
              <input
                value={agent.name}
                onChange={(e) => updateAgent(agent.id, { name: e.target.value })}
                aria-label="Profile name"
                placeholder={providerLabel(agent.provider)}
                spellCheck={false}
                className="min-w-0 flex-1 rounded-btn border border-line-2 bg-bg px-2.5 py-[6px] text-[12.5px] font-semibold text-text-2 placeholder:font-normal placeholder:text-faint focus-visible:ring-2 focus-visible:ring-accent/60 outline-none"
              />
              <div className="relative flex-none">
                <select
                  value={agent.provider}
                  onChange={(e) => updateAgent(agent.id, { provider: e.target.value })}
                  aria-label={`CLI for ${agent.name}`}
                  className="appearance-none rounded-btn border border-line-2 bg-bg py-[6px] pl-2.5 pr-8 text-[12px] text-text-2 focus-visible:ring-2 focus-visible:ring-accent/60 outline-none"
                >
                  {SUPPORTED_AGENTS.map((s) => (
                    <option key={s.id} value={s.id} className="bg-panel text-text-2">
                      {s.label}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  size={13}
                  strokeWidth={1.5}
                  className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-faint"
                />
              </div>
              {agents.length > 1 && (
                <button
                  type="button"
                  aria-label={`Remove ${agent.name}`}
                  onClick={() => removeAgent(agent.id)}
                  className="flex-none rounded-sm text-dim opacity-70 hover:text-red-2 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-accent/60 outline-none"
                >
                  <X size={13} strokeWidth={1.5} />
                </button>
              )}
            </div>

            <label className={`${fieldLabel} mt-2.5 block`} htmlFor={`agent-config-dir-${agent.id}`}>
              Profile directory{' '}
              <span className="font-normal text-faint">
                · optional, sets {meta?.configDirEnvVar ?? 'the CLI’s config-dir variable'}
              </span>
            </label>
            <input
              id={`agent-config-dir-${agent.id}`}
              value={agent.configDir ?? ''}
              onChange={(e) => updateAgent(agent.id, { configDir: e.target.value })}
              placeholder={meta ? `default profile (${meta.defaultConfigDir})` : 'default profile'}
              spellCheck={false}
              className={`mt-1.5 font-mono ${inputBase}`}
            />
            <ProfileDirNote provider={agent.provider} configDir={agent.configDir ?? ''} />

            <label className={`${fieldLabel} mt-3 block`} htmlFor={`agent-exec-${agent.id}`}>
              Executable path <span className="font-normal text-faint">· optional, overrides PATH lookup</span>
            </label>
            <input
              id={`agent-exec-${agent.id}`}
              value={agent.execPath ?? ''}
              onChange={(e) => updateAgent(agent.id, { execPath: e.target.value })}
              placeholder="auto-detect via where / which"
              spellCheck={false}
              className={`mt-1.5 font-mono ${inputBase}`}
            />

            <label className={`${fieldLabel} mt-3 block`} htmlFor={`agent-args-${agent.id}`}>
              Extra CLI arguments <span className="font-normal text-faint">· optional, appended at launch</span>
            </label>
            <input
              id={`agent-args-${agent.id}`}
              value={argsDrafts[agent.id] ?? formatArgsString(agent.args ?? [])}
              onChange={(e) => setArgsDrafts((cur) => ({ ...cur, [agent.id]: e.target.value }))}
              placeholder="--flag value"
              spellCheck={false}
              className={`mt-1.5 font-mono ${inputBase}`}
            />

            <div className={`${fieldLabel} mt-3`}>
              Environment variables <span className="font-normal text-faint">· optional, set in the agent&apos;s terminal</span>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-[7px]">
              {Object.entries(agent.env ?? {}).map(([key, value]) => (
                <span key={key} className={envChip}>
                  {key}={value}
                  <button
                    type="button"
                    aria-label={`Remove ${key}`}
                    onClick={() => removeEnvVar(agent.id, key)}
                    className="rounded-sm opacity-55 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-accent/60 outline-none"
                  >
                    <X size={11} strokeWidth={1.5} />
                  </button>
                </span>
              ))}
              <input
                value={envDrafts[agent.id] ?? ''}
                onChange={(e) => setEnvDrafts((cur) => ({ ...cur, [agent.id]: e.target.value }))}
                onBlur={() => commitEnvDraft(agent.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitEnvDraft(agent.id)
                }}
                aria-label={`Add environment variable for ${agent.name}`}
                placeholder="KEY=value"
                spellCheck={false}
                className="w-[140px] rounded-[7px] border border-dashed border-line-2 bg-bg px-[11px] py-[5px] font-mono text-[11.5px] text-text-2 placeholder:text-faint focus-visible:ring-2 focus-visible:ring-accent/60 outline-none"
              />
            </div>

            {/* What Orbital can install into THIS profile's directory. */}
            {installs.length > 0 &&
              (dirty ? (
                <div className="mt-3 rounded-card border border-dashed border-line-2 p-3 text-[11.5px] text-dim">
                  Save changes to set up Orbital&apos;s {providerLabel(agent.provider)} files for this profile.
                </div>
              ) : (
                installs.map((kind) => <InstallPanel key={kind} agentId={agent.id} kind={kind} />)
              ))}
          </div>
        )
      })}
      <div className="mt-2.5 flex flex-wrap gap-[7px]">
        {SUPPORTED_AGENTS.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => addAgent(a.id)}
            className="inline-flex items-center gap-1 rounded-[7px] border border-dashed border-line-2 bg-bg px-[11px] py-[5px] text-[11.5px] text-faint hover:text-text-3 focus-visible:ring-2 focus-visible:ring-accent/60 outline-none"
          >
            <Plus size={12} strokeWidth={1.5} /> add {a.label}
          </button>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between gap-4">
        <span className="text-[12.5px] text-text-2">
          Default agent <span className="text-faint">· this project</span>
        </span>
        <div className="relative">
          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            aria-label="Default agent"
            className="appearance-none rounded-btn border border-line-2 bg-bg py-[7px] pl-3 pr-9 text-[12px] text-text-2 focus-visible:ring-2 focus-visible:ring-accent/60 outline-none"
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id} className="bg-panel text-text-2">
                {a.name}
              </option>
            ))}
          </select>
          <ChevronDown
            size={13}
            strokeWidth={1.5}
            className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-faint"
          />
        </div>
      </div>
      <label className={`${fieldLabel} mt-3.5 block`} htmlFor="agent-exec">
        Executable path{' '}
        <span className="font-normal text-faint">· optional, this project only — wins over the agent&apos;s own path</span>
      </label>
      <input
        id="agent-exec"
        value={agentExecPath}
        onChange={(e) => setAgentExecPath(e.target.value)}
        placeholder="auto-detect via where / which"
        spellCheck={false}
        className={`mt-1.5 font-mono ${inputBase}`}
      />

      <div className="my-[18px] h-px bg-soft" />

      {/* Debug logging */}
      <div className={sectionLabel}>Debug logging</div>
      <div className="mt-1">
        <AlertRow
          title="Debug logging"
          desc="Record CLI calls, UI actions, and errors to a rotating log file for diagnosing crashes"
          checked={debugLogging}
          onChange={setDebugLogging}
        />
      </div>
      <button type="button" className={`${ghostBtn} mt-1.5`} onClick={() => void window.orbital.openLogFolder()}>
        Open log folder
      </button>

      <div className="my-[18px] h-px bg-soft" />

      {/* Needs-attention alerts */}
      <div className={sectionLabel}>Needs-attention alerts</div>
      <div className="mt-1">
        <AlertRow
          title="Global indicator"
          desc="Banner when any Worktree needs you"
          checked={alerts.indicator}
          onChange={(v) => setAlerts((a) => ({ ...a, indicator: v }))}
        />
        <AlertRow
          title="Sound"
          desc="Chime on a new needs-attention"
          checked={alerts.sound}
          onChange={(v) => setAlerts((a) => ({ ...a, sound: v }))}
        />
        <AlertRow
          title="Taskbar badge"
          desc="The taskbar icon's satellite glows amber"
          checked={alerts.taskbarBadge}
          onChange={(v) => setAlerts((a) => ({ ...a, taskbarBadge: v }))}
        />
        <AlertRow
          title="Taskbar flash"
          desc="Flash the taskbar button while Orbital is in the background"
          checked={alerts.taskbarFlash}
          onChange={(v) => setAlerts((a) => ({ ...a, taskbarFlash: v }))}
        />
      </div>
    </ModalShell>
  )
}
