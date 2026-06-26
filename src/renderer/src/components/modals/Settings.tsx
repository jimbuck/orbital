import { useState } from 'react'
import { X, Plus, ChevronDown } from 'lucide-react'
import { useStore, activeWorkspace } from '@renderer/store'
import type { Settings as SettingsModel } from '@shared/types'
import { ModalShell, primaryBtn, ghostBtn, sectionLabel } from './ModalRoot'

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
      if (ws) await window.orbital.updateEnvPatterns(ws.id, patterns)
      await window.orbital.setSettings({ defaultShell, alerts })
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
          desc="Count on the Windows taskbar icon"
          checked={alerts.taskbarBadge}
          onChange={(v) => setAlerts((a) => ({ ...a, taskbarBadge: v }))}
        />
      </div>
    </ModalShell>
  )
}
