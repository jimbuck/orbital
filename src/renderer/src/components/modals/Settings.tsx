import { useEffect, useState } from 'react'
import { X, Plus, ChevronDown, AlertTriangle } from 'lucide-react'
import { useStore, activeWorkspace } from '@renderer/store'
import type { Settings as SettingsModel, ClaudeHooksStatus, ClaudeHooksPlan } from '@shared/types'
import { ModalShell, primaryBtn, ghostBtn, sectionLabel, fieldLabel, inputBase } from './ModalRoot'

/** Common Windows shells offered in the default-shell picker. */
const SHELL_OPTIONS = ['pwsh.exe', 'powershell.exe', 'cmd.exe', 'wsl.exe', 'bash.exe', 'git-bash.exe']

const DEFAULT_ALERTS: SettingsModel['alerts'] = { indicator: true, sound: true, taskbarBadge: false }

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
  const ws = useStore(activeWorkspace)
  const settings = useStore((s) => s.settings)
  const closeModal = useStore((s) => s.closeModal)

  // Editable working copies seeded from the current store state.
  const [patterns, setPatterns] = useState<string[]>(() => ws?.envSyncPatterns ?? [])
  const [defaultShell, setDefaultShell] = useState(() => settings?.defaultShell ?? SHELL_OPTIONS[0])
  const [alerts, setAlerts] = useState<SettingsModel['alerts']>(() => settings?.alerts ?? DEFAULT_ALERTS)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  // Per-workspace agent config.
  const [agentProvider, setAgentProvider] = useState(() => ws?.defaultAgentProvider ?? 'claude')
  const [agentExecPath, setAgentExecPath] = useState(() => ws?.agentExecPath ?? '')

  // Machine-global Claude status hooks.
  const [hooks, setHooks] = useState<ClaudeHooksStatus | null>(null)
  const [hookConfirm, setHookConfirm] = useState<
    { mode: 'install'; plan: ClaudeHooksPlan } | { mode: 'remove' } | null
  >(null)
  const [hookBusy, setHookBusy] = useState(false)
  const [hookError, setHookError] = useState<string | null>(null)

  useEffect(() => {
    void window.orbital.claudeHooksStatus().then(setHooks).catch(() => undefined)
  }, [])

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
      if (ws) {
        await window.orbital.updateEnvPatterns(ws.id, patterns)
        await window.orbital.setWorkspaceAgent(ws.id, {
          defaultAgentProvider: agentProvider,
          agentExecPath: agentExecPath.trim()
        })
      }
      // Preserve claudeHooksInstalled (managed by the hooks buttons, not this form).
      await window.orbital.setSettings({
        defaultShell,
        alerts,
        claudeHooksInstalled: settings?.claudeHooksInstalled ?? false
      })
      closeModal()
    } finally {
      setSaving(false)
    }
  }

  return (
    <ModalShell
      title="Settings"
      subtitle={`Workspace · ${ws?.name ?? '—'}`}
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
      {/* Environment file sync */}
      <div className={sectionLabel}>Environment file sync</div>
      <p className="mt-1.5 text-[12px] leading-relaxed text-text-3 text-pretty">
        Files matching these patterns are copied from the root checkout into every worktree Flight and kept in sync.
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

      {/* Agent */}
      <div className={sectionLabel}>Agent</div>
      <p className="mt-1.5 text-[12px] leading-relaxed text-text-3 text-pretty">
        A <span className="font-semibold text-text-2">Claude</span> tab boots this agent straight
        into the Flight&apos;s worktree, pre-briefed with the flight&apos;s context.
      </p>
      <div className="mt-3 flex items-center justify-between gap-4">
        <span className="text-[12.5px] text-text-2">Default agent</span>
        <div className="relative">
          <select
            value={agentProvider}
            onChange={(e) => setAgentProvider(e.target.value)}
            aria-label="Default agent provider"
            className="appearance-none rounded-btn border border-line-2 bg-bg py-[7px] pl-3 pr-9 text-[12px] text-text-2 focus-visible:ring-2 focus-visible:ring-accent/60 outline-none"
          >
            <option value="claude" className="bg-panel text-text-2">
              Claude
            </option>
          </select>
          <ChevronDown
            size={13}
            strokeWidth={1.5}
            className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-faint"
          />
        </div>
      </div>
      <label className={`${fieldLabel} mt-3.5 block`} htmlFor="agent-exec">
        Executable path <span className="font-normal text-faint">· optional, overrides PATH lookup</span>
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
              Let flights report status from Claude&apos;s own lifecycle events — no agent
              self-reporting needed. Writes only to{' '}
              <span className="break-all font-mono text-text-2">
                {hooks?.settingsPath ?? '~/.claude/settings.json'}
              </span>
              , and leaves any hooks already there untouched.
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
                <pre className="mt-2 max-h-44 overflow-auto rounded-btn border border-line-2 bg-[#0a0d12] p-2.5 font-mono text-[10.5px] leading-relaxed text-text-3">
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

      <div className="my-[18px] h-px bg-soft" />

      {/* Needs-attention alerts */}
      <div className={sectionLabel}>Needs-attention alerts</div>
      <div className="mt-1">
        <AlertRow
          title="Global indicator"
          desc="Banner when any Flight needs you"
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
      </div>
    </ModalShell>
  )
}
