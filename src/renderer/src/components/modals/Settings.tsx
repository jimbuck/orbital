import { useEffect, useState } from 'react'
import { X, Plus, ChevronDown, AlertTriangle } from 'lucide-react'
import { useStore, activeProject } from '@renderer/store'
import type {
  Settings as SettingsModel,
  ClaudeHooksStatus,
  ClaudeHooksPlan,
  ClaudeSkillStatus,
  ClaudeSkillPlan,
  CodexInstructionsStatus,
  CodexInstructionsPlan,
  ThemeMode,
  AgentConfig
} from '@shared/types'
import { SUPPORTED_AGENTS, defaultAgentConfigs, normalizeAgentConfigs, parseArgsString, formatArgsString } from '@shared/types'
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
  // App theme; missing on installs predating this setting -> default dark (the original look).
  const [theme, setTheme] = useState<ThemeMode>(() => settings?.theme ?? 'dark')
  // Workspace-configured agents. Existing installs lack the key -> default lineup.
  const [agents, setAgents] = useState<AgentConfig[]>(() => settings?.agents ?? defaultAgentConfigs())
  // Extra-CLI-args fields edit as raw text per provider; parsed into argv on save.
  const [argsDrafts, setArgsDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries((settings?.agents ?? []).map((a) => [a.provider, formatArgsString(a.args ?? [])]))
  )
  // The in-progress "KEY=value" env-var input per provider card.
  const [envDrafts, setEnvDrafts] = useState<Record<string, string>>({})
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  // Per-project agent config.
  const [agentProvider, setAgentProvider] = useState(() => project?.defaultAgentProvider ?? 'claude')
  const [agentExecPath, setAgentExecPath] = useState(() => project?.agentExecPath ?? '')

  // Machine-global Claude status hooks.
  const [hooks, setHooks] = useState<ClaudeHooksStatus | null>(null)
  const [hookConfirm, setHookConfirm] = useState<
    { mode: 'install'; plan: ClaudeHooksPlan } | { mode: 'remove' } | null
  >(null)
  const [hookBusy, setHookBusy] = useState(false)
  const [hookError, setHookError] = useState<string | null>(null)

  // The opt-in `orbital` Agent Skill, installed into this workspace's Claude profile.
  const [skill, setSkill] = useState<ClaudeSkillStatus | null>(null)
  const [skillConfirm, setSkillConfirm] = useState<
    { mode: 'install'; plan: ClaudeSkillPlan } | { mode: 'remove' } | null
  >(null)
  const [skillBusy, setSkillBusy] = useState(false)
  const [skillError, setSkillError] = useState<string | null>(null)

  // Codex's equivalent of the skill: a managed block in its profile AGENTS.md.
  const [codex, setCodex] = useState<CodexInstructionsStatus | null>(null)
  const [codexConfirm, setCodexConfirm] = useState<
    { mode: 'install'; plan: CodexInstructionsPlan } | { mode: 'remove' } | null
  >(null)
  const [codexBusy, setCodexBusy] = useState(false)
  const [codexError, setCodexError] = useState<string | null>(null)

  useEffect(() => {
    void window.orbital.claudeHooksStatus().then(setHooks).catch(() => undefined)
    void window.orbital.claudeSkillStatus().then(setSkill).catch(() => undefined)
    void window.orbital.codexInstructionsStatus().then(setCodex).catch(() => undefined)
  }, [])

  const startCodexInstall = async (): Promise<void> => {
    setCodexError(null)
    try {
      setCodexConfirm({ mode: 'install', plan: await window.orbital.codexInstructionsPlan() })
    } catch (e) {
      setCodexError(e instanceof Error ? e.message : 'Could not build the instructions.')
    }
  }
  const confirmCodex = async (): Promise<void> => {
    if (!codexConfirm) return
    setCodexBusy(true)
    setCodexError(null)
    try {
      const result =
        codexConfirm.mode === 'install'
          ? await window.orbital.installCodexInstructions()
          : await window.orbital.removeCodexInstructions()
      setCodex(result)
      setCodexConfirm(null)
    } catch (e) {
      setCodexError(e instanceof Error ? e.message : 'Could not update the instructions.')
    } finally {
      setCodexBusy(false)
    }
  }

  const startSkillInstall = async (): Promise<void> => {
    setSkillError(null)
    try {
      const plan = await window.orbital.claudeSkillPlan()
      setSkillConfirm({ mode: 'install', plan })
    } catch (e) {
      setSkillError(e instanceof Error ? e.message : 'Could not build the skill.')
    }
  }
  const confirmSkill = async (): Promise<void> => {
    if (!skillConfirm) return
    setSkillBusy(true)
    setSkillError(null)
    try {
      // install() refuses to overwrite a SKILL.md Orbital does not own, so this
      // can reject — surface that rather than silently failing.
      const result =
        skillConfirm.mode === 'install'
          ? await window.orbital.installClaudeSkill()
          : await window.orbital.removeClaudeSkill()
      setSkill(result)
      setSkillConfirm(null)
    } catch (e) {
      setSkillError(e instanceof Error ? e.message : 'Could not update the skill.')
    } finally {
      setSkillBusy(false)
    }
  }

  const startInstall = async (): Promise<void> => {
    setHookError(null)
    try {
      const plan = await window.orbital.claudeHooksPlan()
      setHookConfirm({ mode: 'install', plan })
    } catch (e) {
      setHookError(e instanceof Error ? e.message : 'Could not read Claude settings.')
    }
  }
  const confirmHooks = async (): Promise<void> => {
    if (!hookConfirm) return
    setHookBusy(true)
    setHookError(null)
    try {
      // install() refuses to overwrite a settings.json that exists but won't parse,
      // so this can reject — surface that rather than silently failing.
      const result =
        hookConfirm.mode === 'install'
          ? await window.orbital.installClaudeHooks()
          : await window.orbital.removeClaudeHooks()
      setHooks(result)
      setHookConfirm(null)
    } catch (e) {
      setHookError(e instanceof Error ? e.message : 'Could not update Claude hooks.')
    } finally {
      setHookBusy(false)
    }
  }

  const shellOptions = SHELL_OPTIONS.includes(defaultShell) ? SHELL_OPTIONS : [defaultShell, ...SHELL_OPTIONS]

  const updateAgent = (provider: string, patch: Partial<AgentConfig>): void =>
    setAgents((cur) => cur.map((a) => (a.provider === provider ? { ...a, ...patch } : a)))

  const addAgent = (provider: string): void =>
    setAgents((cur) => (cur.some((a) => a.provider === provider) ? cur : [...cur, { provider }]))

  // Never allow emptying the list — there must always be at least one agent
  // available in the new-tab menus.
  const removeAgent = (provider: string): void =>
    setAgents((cur) => (cur.length <= 1 ? cur : cur.filter((a) => a.provider !== provider)))

  // Commit a card's "KEY=value" env input into its entry's env map.
  const commitEnvDraft = (provider: string): void => {
    const draft = envDrafts[provider] ?? ''
    const eq = draft.indexOf('=')
    const key = (eq === -1 ? draft : draft.slice(0, eq)).trim()
    const value = eq === -1 ? '' : draft.slice(eq + 1).trim()
    setEnvDrafts((cur) => ({ ...cur, [provider]: '' }))
    if (!key) return
    setAgents((cur) =>
      cur.map((a) => (a.provider === provider ? { ...a, env: { ...a.env, [key]: value } } : a))
    )
  }

  const removeEnvVar = (provider: string, key: string): void =>
    setAgents((cur) =>
      cur.map((a) => {
        if (a.provider !== provider || !a.env) return a
        const env = { ...a.env }
        delete env[key]
        return { ...a, env }
      })
    )

  /** Providers not yet configured — offered as "add" chips under the list. */
  const addableAgents = SUPPORTED_AGENTS.filter((s) => !agents.some((a) => a.provider === s.id))

  // The default-agent picker only offers configured agents; if the project's
  // current default was removed, still show it so the select has a valid value.
  const agentOptions = SUPPORTED_AGENTS.filter(
    (a) => agents.some((c) => c.provider === a.id) || a.id === agentProvider
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
          defaultAgentProvider: agentProvider,
          agentExecPath: agentExecPath.trim()
        })
      }
      // Fold each card's raw args text back into its entry, then scrub empty
      // fields (blank configDir/execPath, empty args/env) via the normalizer.
      const cleanedAgents =
        normalizeAgentConfigs(
          agents.map((a) => ({
            ...a,
            args: parseArgsString(argsDrafts[a.provider] ?? formatArgsString(a.args ?? []))
          }))
        ) ?? []
      // Preserve claudeHooksInstalled / claudeSkillInstalled (managed by their own
      // buttons, not this form).
      await window.orbital.setSettings({
        defaultShell,
        alerts,
        claudeHooksInstalled: settings?.claudeHooksInstalled ?? false,
        claudeSkillInstalled: settings?.claudeSkillInstalled ?? false,
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
        {/* 3-way segmented control; theme re-applies on Save (useResolvedTheme reads the store). */}
        <div className="flex items-center rounded-[7px] border border-line-2 bg-bg p-[2px]">
          {(['system', 'light', 'dark'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setTheme(mode)}
              aria-pressed={theme === mode}
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

      {/* Agent */}
      <div className={sectionLabel}>Agent</div>
      <p className="mt-1.5 text-[12px] leading-relaxed text-text-3 text-pretty">
        An agent tab boots the coding CLI straight into the Worktree&apos;s working directory. Agents
        configured here appear in the new-tab menus; each can point at its own profile directory and
        launch tweaks, per workspace.
      </p>
      {agents.map((agent) => {
        const meta = SUPPORTED_AGENTS.find((s) => s.id === agent.provider)
        const label = meta?.label ?? agent.provider
        return (
          <div key={agent.provider} className="mt-2.5 rounded-card border border-line-2 bg-bg/40 p-3.5">
            <div className="flex items-center justify-between gap-3">
              <div className="text-[12.5px] font-semibold text-text-2">{label}</div>
              {agents.length > 1 && (
                <button
                  type="button"
                  aria-label={`Remove ${label}`}
                  onClick={() => removeAgent(agent.provider)}
                  className="rounded-sm text-dim opacity-70 hover:text-red-2 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-accent/60 outline-none"
                >
                  <X size={13} strokeWidth={1.5} />
                </button>
              )}
            </div>

            <label className={`${fieldLabel} mt-2.5 block`} htmlFor={`agent-config-dir-${agent.provider}`}>
              Profile directory{' '}
              <span className="font-normal text-faint">
                · optional, sets {meta?.configDirEnvVar ?? 'the CLI’s config-dir variable'}
              </span>
            </label>
            <input
              id={`agent-config-dir-${agent.provider}`}
              value={agent.configDir ?? ''}
              onChange={(e) => updateAgent(agent.provider, { configDir: e.target.value })}
              placeholder={meta ? `default profile (${meta.defaultConfigDir})` : 'default profile'}
              spellCheck={false}
              className={`mt-1.5 font-mono ${inputBase}`}
            />

            <label className={`${fieldLabel} mt-3 block`} htmlFor={`agent-exec-${agent.provider}`}>
              Executable path <span className="font-normal text-faint">· optional, overrides PATH lookup</span>
            </label>
            <input
              id={`agent-exec-${agent.provider}`}
              value={agent.execPath ?? ''}
              onChange={(e) => updateAgent(agent.provider, { execPath: e.target.value })}
              placeholder="auto-detect via where / which"
              spellCheck={false}
              className={`mt-1.5 font-mono ${inputBase}`}
            />

            <label className={`${fieldLabel} mt-3 block`} htmlFor={`agent-args-${agent.provider}`}>
              Extra CLI arguments <span className="font-normal text-faint">· optional, appended at launch</span>
            </label>
            <input
              id={`agent-args-${agent.provider}`}
              value={argsDrafts[agent.provider] ?? formatArgsString(agent.args ?? [])}
              onChange={(e) => setArgsDrafts((cur) => ({ ...cur, [agent.provider]: e.target.value }))}
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
                    onClick={() => removeEnvVar(agent.provider, key)}
                    className="rounded-sm opacity-55 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-accent/60 outline-none"
                  >
                    <X size={11} strokeWidth={1.5} />
                  </button>
                </span>
              ))}
              <input
                value={envDrafts[agent.provider] ?? ''}
                onChange={(e) => setEnvDrafts((cur) => ({ ...cur, [agent.provider]: e.target.value }))}
                onBlur={() => commitEnvDraft(agent.provider)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitEnvDraft(agent.provider)
                }}
                aria-label={`Add environment variable for ${label}`}
                placeholder="KEY=value"
                spellCheck={false}
                className="w-[140px] rounded-[7px] border border-dashed border-line-2 bg-bg px-[11px] py-[5px] font-mono text-[11.5px] text-text-2 placeholder:text-faint focus-visible:ring-2 focus-visible:ring-accent/60 outline-none"
              />
            </div>
          </div>
        )
      })}
      {addableAgents.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-[7px]">
          {addableAgents.map((a) => (
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
      )}
      <div className="mt-3 flex items-center justify-between gap-4">
        <span className="text-[12.5px] text-text-2">Default agent</span>
        <div className="relative">
          <select
            value={agentProvider}
            onChange={(e) => setAgentProvider(e.target.value)}
            aria-label="Default agent provider"
            className="appearance-none rounded-btn border border-line-2 bg-bg py-[7px] pl-3 pr-9 text-[12px] text-text-2 focus-visible:ring-2 focus-visible:ring-accent/60 outline-none"
          >
            {agentOptions.map((a) => (
              <option key={a.id} value={a.id} className="bg-panel text-text-2">
                {a.label}
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

      {/* Claude status hooks (machine-global, opt-in) */}
      <div className="mt-4 rounded-card border border-line-2 bg-bg/40 p-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[12.5px] font-semibold text-text-2">Claude status hooks</div>
            <p className="mt-1 text-[11.5px] leading-relaxed text-text-3 text-pretty">
              Let Worktrees report status from Claude&apos;s own lifecycle events — no agent
              self-reporting needed. Writes only to{' '}
              <span className="break-all font-mono text-text-2">
                {hooks?.settingsPath ?? '~/.claude/settings.json'}
              </span>
              , the profile this workspace launches Claude with, and leaves any hooks already
              there untouched.
            </p>
          </div>
          <span
            className={`mt-0.5 flex-none rounded-chip px-2 py-0.5 text-[10px] font-bold ${
              hooks?.installed ? 'bg-green/15 text-green-2' : 'bg-hover text-dim'
            }`}
          >
            {hooks?.installed ? 'Installed' : 'Not installed'}
          </span>
        </div>

        {hookConfirm ? (
          <div className="mt-3">
            {hookConfirm.mode === 'install' ? (
              <>
                <div className="flex items-center gap-2 text-[11.5px] text-amber-2">
                  <AlertTriangle size={13} strokeWidth={1.5} className="flex-none" />
                  Hooks run shell commands with your full permissions. Review before writing:
                </div>
                {/* Fixed dark code block: pin a light foreground (not a theme token) so
                    the JSON stays readable in light mode too. */}
                <pre className="mt-2 max-h-44 overflow-auto rounded-btn border border-line-2 bg-[#0a0d12] p-2.5 font-mono text-[10.5px] leading-relaxed text-[#aab2c0]">

                  {hookConfirm.plan.json}
                </pre>
              </>
            ) : (
              <div className="flex items-center gap-2 text-[11.5px] text-text-3">
                <AlertTriangle size={13} strokeWidth={1.5} className="flex-none text-amber-2" />
                Remove Orbital&apos;s hook entries from settings.json? Other hooks stay intact.
              </div>
            )}
            <div className="mt-2.5 flex items-center justify-end gap-2">
              <button type="button" className={ghostBtn} onClick={() => setHookConfirm(null)} disabled={hookBusy}>
                Cancel
              </button>
              <button type="button" className={primaryBtn} onClick={confirmHooks} disabled={hookBusy}>
                {hookConfirm.mode === 'install' ? 'Confirm & write' : 'Remove hooks'}
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-3">
            {hooks?.installed ? (
              <button type="button" className={ghostBtn} onClick={() => setHookConfirm({ mode: 'remove' })}>
                Remove Claude hooks
              </button>
            ) : (
              <button type="button" className={ghostBtn} onClick={startInstall}>
                Set up Claude status hooks
              </button>
            )}
          </div>
        )}
        {hookError && <div className="mt-2.5 text-[11px] text-red-2">{hookError}</div>}
      </div>

      {/* The `orbital` Agent Skill (per-workspace Claude profile, opt-in) */}
      <div className="mt-3 rounded-card border border-line-2 bg-bg/40 p-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[12.5px] font-semibold text-text-2">The orbital skill for Claude</div>
            <p className="mt-1 text-[11.5px] leading-relaxed text-text-3 text-pretty">
              Teach Claude the <span className="font-mono text-text-2">orbital</span> CLI — reporting
              status, filing tasks, opening tabs — in sessions Orbital did not boot as an agent tab
              (a <span className="font-mono text-text-2">claude</span> you start yourself). Agent tabs
              are already briefed. Writes one file:{' '}
              <span className="break-all font-mono text-text-2">
                {skill?.skillPath ?? '~/.claude/skills/orbital/SKILL.md'}
              </span>
            </p>
          </div>
          <span
            className={`mt-0.5 flex-none rounded-chip px-2 py-0.5 text-[10px] font-bold ${
              skill?.installed ? 'bg-green/15 text-green-2' : 'bg-hover text-dim'
            }`}
          >
            {skill?.installed ? 'Installed' : 'Not installed'}
          </span>
        </div>

        {skillConfirm ? (
          <div className="mt-3">
            {skillConfirm.mode === 'install' ? (
              <>
                <div className="text-[11.5px] text-text-3">Review the skill before writing it:</div>
                {/* Same fixed dark code block as the hooks preview, for the same reason. */}
                <pre className="mt-2 max-h-44 overflow-auto rounded-btn border border-line-2 bg-[#0a0d12] p-2.5 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-[#aab2c0]">
                  {skillConfirm.plan.markdown}
                </pre>
              </>
            ) : (
              <div className="flex items-center gap-2 text-[11.5px] text-text-3">
                <AlertTriangle size={13} strokeWidth={1.5} className="flex-none text-amber-2" />
                Delete the skill Orbital installed? Nothing else in the profile is touched.
              </div>
            )}
            <div className="mt-2.5 flex items-center justify-end gap-2">
              <button type="button" className={ghostBtn} onClick={() => setSkillConfirm(null)} disabled={skillBusy}>
                Cancel
              </button>
              <button type="button" className={primaryBtn} onClick={confirmSkill} disabled={skillBusy}>
                {skillConfirm.mode === 'install' ? 'Confirm & write' : 'Remove skill'}
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-3">
            {skill?.installed ? (
              <button type="button" className={ghostBtn} onClick={() => setSkillConfirm({ mode: 'remove' })}>
                Remove the orbital skill
              </button>
            ) : (
              <button type="button" className={ghostBtn} onClick={startSkillInstall} disabled={skill?.foreign}>
                Install the orbital skill
              </button>
            )}
            {skill?.foreign && (
              <div className="mt-2 text-[11px] text-amber-2">
                A skill named <span className="font-mono">orbital</span> already exists there and was not
                written by Orbital — move or delete it first.
              </div>
            )}
          </div>
        )}
        {skillError && <div className="mt-2.5 text-[11px] text-red-2">{skillError}</div>}
      </div>

      {/* Codex instructions — only relevant when this workspace runs Codex at all */}
      {agents.some((a) => a.provider === 'codex') && (
        <div className="mt-3 rounded-card border border-line-2 bg-bg/40 p-3.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[12.5px] font-semibold text-text-2">Orbital instructions for Codex</div>
              <p className="mt-1 text-[11.5px] leading-relaxed text-text-3 text-pretty">
                Codex takes no per-launch briefing, so it learns the{' '}
                <span className="font-mono text-text-2">orbital</span> CLI from its own always-loaded
                instructions. Orbital merges a short marked block into{' '}
                <span className="break-all font-mono text-text-2">
                  {codex?.path ?? '~/.codex/AGENTS.md'}
                </span>
                , leaving whatever else is in that file alone.
              </p>
            </div>
            <span
              className={`mt-0.5 flex-none rounded-chip px-2 py-0.5 text-[10px] font-bold ${
                codex?.installed ? 'bg-green/15 text-green-2' : 'bg-hover text-dim'
              }`}
            >
              {codex?.installed ? 'Installed' : 'Not installed'}
            </span>
          </div>

          {codexConfirm ? (
            <div className="mt-3">
              {codexConfirm.mode === 'install' ? (
                <>
                  <div className="text-[11.5px] text-text-3">
                    Every Codex session using this profile loads this. Review it before writing:
                  </div>
                  <pre className="mt-2 max-h-44 overflow-auto rounded-btn border border-line-2 bg-[#0a0d12] p-2.5 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-[#aab2c0]">
                    {codexConfirm.plan.markdown}
                  </pre>
                </>
              ) : (
                <div className="flex items-center gap-2 text-[11.5px] text-text-3">
                  <AlertTriangle size={13} strokeWidth={1.5} className="flex-none text-amber-2" />
                  Remove Orbital&apos;s block from AGENTS.md? The rest of the file stays intact.
                </div>
              )}
              <div className="mt-2.5 flex items-center justify-end gap-2">
                <button type="button" className={ghostBtn} onClick={() => setCodexConfirm(null)} disabled={codexBusy}>
                  Cancel
                </button>
                <button type="button" className={primaryBtn} onClick={confirmCodex} disabled={codexBusy}>
                  {codexConfirm.mode === 'install' ? 'Confirm & write' : 'Remove block'}
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-3">
              {codex?.installed ? (
                <button type="button" className={ghostBtn} onClick={() => setCodexConfirm({ mode: 'remove' })}>
                  Remove the Codex instructions
                </button>
              ) : (
                <button type="button" className={ghostBtn} onClick={startCodexInstall}>
                  Install the Codex instructions
                </button>
              )}
            </div>
          )}
          {codexError && <div className="mt-2.5 text-[11px] text-red-2">{codexError}</div>}
        </div>
      )}

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
