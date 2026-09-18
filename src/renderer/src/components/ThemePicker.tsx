import { useRef, type JSX, type KeyboardEvent } from 'react'
import { Check } from 'lucide-react'
import type { ThemeMode } from '@shared/types'
import { themeById, themeTokens, type ThemeSpec } from '@shared/themes'
import { DARK_THEMES, LIGHT_THEMES, setThemeMode, useSystemTheme, useThemeMode } from '@renderer/lib/theme'

/**
 * The theme gallery: every theme as a miniature of the window it makes, so the
 * choice is made by looking rather than by reading twenty names and guessing
 * which one Gruvbox is.
 *
 * Like the control it replaced, a pick applies and PERSISTS immediately rather
 * than on the modal's Save — the View menu and the command palette offer the
 * same choice and do the same, and one shared write path (lib/theme.ts) keeps
 * the three from ever disagreeing. It also makes selection-follows-focus the
 * right keyboard pattern here: every arrow press is a real, visible preview.
 */

/** Columns in the grid. Also what the vertical arrows step by — see onKeyDown. */
const COLUMNS = 3

const FOCUS = 'focus-visible:ring-2 focus-visible:ring-accent/60 outline-none'

/**
 * A theme as a 44px window: rail, title bar, and a pane with three lines of
 * "content", the middle one in the accent. Small enough to sit twenty to a
 * modal, and still enough to tell a warm theme from a cold one at a glance.
 */
function ThemeSwatch({ theme, className = '' }: { theme: ThemeSpec; className?: string }): JSX.Element {
  const t = themeTokens(theme)
  return (
    <div aria-hidden className={`flex h-[46px] ${className}`} style={{ background: t['--color-bg'] }}>
      <div className="w-[8px] flex-none" style={{ background: t['--color-rail'] }} />
      <div className="flex min-w-0 flex-1 flex-col gap-[3px] p-[4px]">
        <div className="h-[4px] flex-none rounded-[2px]" style={{ background: t['--color-bar'] }} />
        <div
          className="flex min-h-0 flex-1 flex-col justify-center gap-[3px] rounded-[3px] px-[4px]"
          style={{ background: t['--color-pane'] }}
        >
          <div className="h-[3px] w-[70%] rounded-full" style={{ background: t['--color-text-3'] }} />
          <div className="h-[3px] w-[45%] rounded-full" style={{ background: t['--color-accent'] }} />
          <div className="h-[3px] w-[58%] rounded-full" style={{ background: t['--color-muted'] }} />
        </div>
      </div>
    </div>
  )
}

/** One tile: a preview, the theme's name, and a check when it is the active one. */
function ThemeTile({
  label,
  hint,
  selected,
  tabbable,
  onSelect,
  onKeyDown,
  register,
  children
}: {
  label: string
  hint?: string
  selected: boolean
  tabbable: boolean
  onSelect: () => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
  register: (el: HTMLButtonElement | null) => void
  children: JSX.Element
}): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      tabIndex={tabbable ? 0 : -1}
      ref={register}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      // items-stretch, because Chromium's UA stylesheet centres a <button>'s
      // flex children: without it the preview shrink-wraps to a sliver.
      className={`flex flex-col items-stretch overflow-hidden rounded-[9px] border text-left ${
        selected ? 'border-accent' : 'border-line-2 hover:border-line-strong'
      } ${FOCUS}`}
    >
      {children}
      <div className="flex items-center gap-1 border-t border-line bg-panel px-[7px] py-[5px] text-[11px] text-text-2">
        <span className="truncate">{label}</span>
        {hint && <span className="flex-none text-[10px] text-faint">{hint}</span>}
        {selected && <Check size={11} strokeWidth={2} className="ml-auto flex-none text-accent" />}
      </div>
    </button>
  )
}

/**
 * The option index an arrow key moves to, or null when the key is not one this
 * pattern owns. Horizontal arrows step one tile; vertical arrows step a whole
 * row, because the options are laid out as a grid and Down from the top-left
 * tile landing on its neighbour would not match what the user sees. Both wrap,
 * and Home/End jump to the ends.
 */
export function nextTileIndex(key: string, current: number, count: number, columns = COLUMNS): number | null {
  if (count === 0) return null
  const wrap = (i: number): number => ((i % count) + count) % count
  switch (key) {
    case 'ArrowRight':
      return wrap(current + 1)
    case 'ArrowLeft':
      return wrap(current - 1)
    case 'ArrowDown':
      return wrap(current + columns)
    case 'ArrowUp':
      return wrap(current - columns)
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

export default function ThemePicker({
  describedBy,
  className = ''
}: {
  /** Id of the note describing the group, e.g. "applies immediately". */
  describedBy?: string
  className?: string
}): JSX.Element {
  const mode = useThemeMode()
  const systemTheme = useSystemTheme()
  // Arrowing moves DOM focus itself, so the tiles are kept by value; cleared
  // per option on unmount so a changed list cannot pin a detached node.
  const nodes = useRef(new Map<ThemeMode, HTMLButtonElement>())

  // 'system' leads, then the themes grouped by appearance — dark-or-light is
  // the first cut anyone makes, and the Orbital pair heads each group.
  const options: ThemeMode[] = ['system', ...DARK_THEMES.map((t) => t.id), ...LIGHT_THEMES.map((t) => t.id)]
  const checkedIndex = options.indexOf(mode)
  // A stale persisted value would otherwise leave the group with no tab stop
  // and make it keyboard-unreachable.
  const tabStop = checkedIndex === -1 ? 0 : checkedIndex

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const index = nextTileIndex(event.key, tabStop, options.length)
    if (index === null) return
    // Claim the key so the arrows don't also scroll the modal behind the grid.
    event.preventDefault()
    const next = options[index]
    setThemeMode(next)
    nodes.current.get(next)?.focus()
  }

  const tile = (value: ThemeMode, label: string, hint: string | undefined, preview: JSX.Element): JSX.Element => (
    <ThemeTile
      key={value}
      label={label}
      hint={hint}
      selected={mode === value}
      tabbable={options[tabStop] === value}
      onSelect={() => setThemeMode(value)}
      onKeyDown={onKeyDown}
      register={(el) => {
        if (el) nodes.current.set(value, el)
        else nodes.current.delete(value)
      }}
    >
      {preview}
    </ThemeTile>
  )

  const group = (label: string, themes: readonly ThemeSpec[]): JSX.Element => (
    <>
      <div className="col-span-full pt-1 text-[10px] font-bold uppercase tracking-[0.6px] text-faint">{label}</div>
      {themes.map((t) => tile(t.id, t.name, undefined, <ThemeSwatch theme={t} />))}
    </>
  )

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      aria-describedby={describedBy}
      className={`grid grid-cols-3 gap-2 ${className}`}
    >
      {tile(
        'system',
        'System',
        // What System would mean right now — the reason someone hovers this
        // tile at all is to decide whether to hand the choice back to the OS.
        systemTheme,
        <div className="flex">
          {/* Both halves, because System is not one look: it is whichever of
              the two built-ins the OS is asking for at the time. */}
          <ThemeSwatch theme={themeById('dark')} className="w-1/2" />
          <ThemeSwatch theme={themeById('light')} className="w-1/2" />
        </div>
      )}
      <div aria-hidden className="col-span-2" />
      {group('Dark', DARK_THEMES)}
      {group('Light', LIGHT_THEMES)}
    </div>
  )
}
