import { useEffect, useRef, useState, type JSX } from 'react'
import { Check } from 'lucide-react'
import { normalizeAccentColor } from '@shared/types'
import { ACCENT_PRESETS, DEFAULT_ACCENT } from '@renderer/lib/accent'
import { useResolvedTheme } from '@renderer/lib/theme'

/** How long a drag in the native colour dialog has to pause before it is persisted. */
const PICKER_PERSIST_DEBOUNCE_MS = 200

/**
 * The accent-colour control: a row of swatches — Default, the presets, and a
 * Custom swatch that opens the native colour dialog — plus a hex field for
 * typing an exact value.
 *
 * `onPreview` re-tints the app without writing; `onChange` persists. The split
 * exists for the native dialog, which fires on every movement of the picker:
 * previewing each one keeps the app tracking the drag, while the write waits
 * for the drag to pause. Every other way of choosing is a single click or an
 * Enter, and goes straight to `onChange`.
 */
export function AccentPicker({
  value,
  onPreview,
  onChange,
  describedBy
}: {
  /** The persisted (or previewed) accent, null for the built-in blue. */
  value: string | null
  onPreview: (color: string | null) => void
  onChange: (color: string | null) => void
  describedBy?: string
}): JSX.Element {
  const theme = useResolvedTheme()
  const current = normalizeAccentColor(value)
  const isPreset = current !== null && ACCENT_PRESETS.some((p) => p.hex === current)
  const isCustom = current !== null && !isPreset

  // The hex field is a draft: it has to hold a half-typed value, and only a
  // complete one is applied. It follows the value whenever that changes
  // underneath it (a swatch click, a rollback) so it never shows a stale colour.
  const [draft, setDraft] = useState(current ?? '')
  useEffect(() => {
    setDraft(current ?? '')
  }, [current])

  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => clearTimeout(persistTimer.current ?? undefined), [])

  const commitDraft = (): void => {
    const color = normalizeAccentColor(draft)
    if (color === null) {
      setDraft(current ?? '') // not a colour: put back what is applied
      return
    }
    if (color !== current) onChange(color)
  }

  const swatch = (checked: boolean): string =>
    `relative grid size-6 place-items-center rounded-full border outline-none transition-transform focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-panel ${
      checked ? 'scale-110 border-text/70' : 'border-line-strong hover:scale-110'
    }`

  return (
    <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Accent color" aria-describedby={describedBy}>
      <button
        type="button"
        role="radio"
        aria-checked={current === null}
        aria-label="Default"
        title="Default"
        onClick={() => onChange(null)}
        className={swatch(current === null)}
        style={{ backgroundColor: DEFAULT_ACCENT[theme] }}
      >
        {current === null && <Check size={12} strokeWidth={2.5} className="text-white drop-shadow" />}
      </button>
      {ACCENT_PRESETS.map((preset) => {
        const checked = current === preset.hex
        return (
          <button
            key={preset.hex}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={preset.name}
            title={preset.name}
            onClick={() => onChange(preset.hex)}
            className={swatch(checked)}
            style={{ backgroundColor: preset.hex }}
          >
            {checked && <Check size={12} strokeWidth={2.5} className="text-white drop-shadow" />}
          </button>
        )
      })}
      {/* Custom: a native <input type=color> wearing the swatch's clothes. It
          is the radio for "a colour of your own" and also the way to open the
          dialog, so it is checked whenever the applied colour is not a preset. */}
      <label
        className={`${swatch(isCustom)} cursor-pointer overflow-hidden`}
        style={{
          background: isCustom
            ? current!
            : 'conic-gradient(#f06a8a, #e8b54a, #3ddc97, #38bdf8, #8b7cf6, #f06a8a)'
        }}
        title="Custom…"
      >
        <input
          type="color"
          role="radio"
          aria-checked={isCustom}
          aria-label="Custom"
          value={current ?? DEFAULT_ACCENT[theme]}
          onChange={(e) => {
            const color = e.target.value
            onPreview(color)
            if (persistTimer.current) clearTimeout(persistTimer.current)
            persistTimer.current = setTimeout(() => onChange(color), PICKER_PERSIST_DEBOUNCE_MS)
          }}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
        />
        {isCustom && <Check size={12} strokeWidth={2.5} className="pointer-events-none text-white drop-shadow" />}
      </label>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitDraft}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commitDraft()
          } else if (e.key === 'Escape') {
            setDraft(current ?? '')
          }
        }}
        placeholder={DEFAULT_ACCENT[theme]}
        aria-label="Accent hex"
        spellCheck={false}
        className="ml-1 w-[84px] rounded-[7px] border border-line-2 bg-bg px-2 py-[5px] font-mono text-[11.5px] text-text-2 placeholder:text-faint focus-visible:ring-2 focus-visible:ring-accent/60 outline-none"
      />
    </div>
  )
}
