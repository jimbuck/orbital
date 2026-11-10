/**
 * The geometry of the editor's text surface: where a line and a column of the
 * (wrap-off, monospace) textarea are on screen, and how everything drawn over
 * that text is kept there while it scrolls.
 *
 * The editor is a stack of layers — the highlighted mirror, the line-number
 * gutter, the fold strip, find and selection highlights, fold chips, the reveal
 * band — and every one of them has to land exactly on the textarea's own
 * glyphs. This module is the one place that knows how: layers ask it for a box
 * and a scroll follower and never do unit arithmetic themselves.
 *
 * Two facts about the units, both learned the hard way:
 *
 *  - VERTICALLY the text is laid out in measured pixels. Chromium snaps each
 *    line box to its 1/64px layout unit, so 12px at 1.6 lays out at 19.1875px a
 *    line, not the 19.2px `1.6em` computes to. An overlay placed in `em` falls
 *    0.0125px further behind per line: a few pixels a couple of hundred lines
 *    down, a whole line by line 1500. So the pitch is measured off rendered
 *    text and every `top` is `padTop + row * pitch` in px.
 *
 *  - HORIZONTALLY the text is laid out in glyph advances, which are not
 *    snapped, and `ch` is exactly that advance. So `left` and `width` stay in
 *    `ch`, where the browser does the multiplication at full precision; a
 *    measured character width (snapped, so slightly off) is only good enough
 *    for deciding whether a column is on screen.
 *
 * Because of the second fact, a box from here must be set on an element that
 * keeps the editor's own font size — `ch` resolves against the element it is
 * set on. A layer that wants smaller text puts it on a child.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { DEFAULT_TAB_SIZE, parseTabSize } from './columns'

/** What has to be read off the rendered text; everything else follows from it. */
export interface TextMetrics {
  /** Distance from one line's top to the next, in px, as actually laid out. */
  pitch: number
  /** Advance of one glyph in px, or 0 when it could not be measured. */
  charWidth: number
  /** Space above the first line, in px. */
  padTop: number
}

/** Stand-ins until (or where) the text cannot be measured: 12px at 1.6, 0.75rem. */
export const FALLBACK_METRICS: TextMetrics = { pitch: 19.2, charWidth: 0, padTop: 12 }

/** Padding above and below the text, shared by every element that holds text. */
const TEXT_PAD_BLOCK = '0.75rem'
/** Room beside the gutter's digits: its right padding, its rule, and a little air. */
const GUTTER_PAD_PX = 20
/** The strip between the gutter rule and the first text column, where fold markers sit. */
const FOLD_STRIP_PX = 12

/** The part of the textarea's scroll state the arithmetic needs. */
export interface Viewport {
  scrollTop: number
  scrollLeft: number
  clientHeight: number
  clientWidth: number
}

/** A box for one display row, spanning whatever its positioned parent spans. */
export interface RowBox {
  position: 'absolute'
  top: string
  height: string
}

/** A box starting at a column of a display row; `width` only when a span was asked for. */
export interface CellBox extends RowBox {
  left: string
  width?: string
}

/**
 * Where things are, for a given set of measurements and line count. Rows and
 * columns are 0-based and in DISPLAY terms: row 0 is the first line on screen,
 * and a column is a tab-expanded cell, not a character index.
 */
export interface TextGeometry {
  readonly metrics: TextMetrics
  /** Padding for an element holding the text itself (the textarea, its mirror). */
  readonly textBox: CSSProperties
  /** Width and padding of the line-number gutter. */
  readonly gutterBox: CSSProperties
  /** Position and width of the fold strip beside the gutter. */
  readonly foldStripBox: CSSProperties
  /** Top edge of a row in the scrolled content, px. */
  rowTop(row: number): number
  /** A full-width box over a row. */
  rowBox(row: number): RowBox
  /** A box at `column` of `row`, `width` columns wide when given. */
  cellBox(row: number, column: number, width?: number): CellBox
  /** The scrollTop that puts a row in the middle of the viewport. */
  scrollTopToCentre(row: number, clientHeight: number): number
  /**
   * Scroll offsets that bring a span on screen. Each axis only moves when the
   * span is off screen on it, so stepping between two things already in view
   * does not yank the viewport. Returns the viewport's own offsets otherwise.
   */
  scrollToShow(cell: { row: number; column: number; width: number }, view: Viewport): { scrollTop: number; scrollLeft: number }
}

/** The geometry of a surface showing `lineCount` lines (which sets the gutter's width). */
export function textGeometry(metrics: TextMetrics, lineCount: number): TextGeometry {
  const { pitch, charWidth, padTop } = metrics
  // Widths are in `ch` of the shared monospace font, so the gutter grows with
  // the digit count and the text moves over by exactly the same amount.
  const digits = Math.max(2, String(lineCount).length)
  const textInsetPx = GUTTER_PAD_PX + FOLD_STRIP_PX
  const gutterWidth = `calc(${digits}ch + ${GUTTER_PAD_PX}px)`
  const textLeft = `calc(${digits}ch + ${textInsetPx}px)`
  const rowTop = (row: number): number => padTop + row * pitch
  const rowBox = (row: number): RowBox => ({ position: 'absolute', top: `${rowTop(row)}px`, height: `${pitch}px` })
  const scrollTopToCentre = (row: number, clientHeight: number): number =>
    // Never past the top, for a row near the start.
    Math.max(0, rowTop(row) - clientHeight / 2 + pitch / 2)
  return {
    metrics,
    textBox: { paddingTop: TEXT_PAD_BLOCK, paddingBottom: TEXT_PAD_BLOCK, paddingLeft: textLeft },
    gutterBox: { paddingTop: TEXT_PAD_BLOCK, paddingBottom: TEXT_PAD_BLOCK, width: gutterWidth },
    foldStripBox: { left: gutterWidth, width: `${FOLD_STRIP_PX}px` },
    rowTop,
    rowBox,
    cellBox: (row, column, width) => ({
      ...rowBox(row),
      left: `calc(${digits + column}ch + ${textInsetPx}px)`,
      ...(width === undefined ? {} : { width: `${width}ch` })
    }),
    scrollTopToCentre,
    scrollToShow: (cell, view) => {
      const top = rowTop(cell.row)
      const offScreenY = top < view.scrollTop || top + pitch > view.scrollTop + view.clientHeight
      let scrollLeft = view.scrollLeft
      // Horizontally too: a span past the right edge of a long line is no more
      // on screen than one below the fold. Needs the one number CSS will not do
      // the arithmetic for, the glyph's advance — skipped when that is unknown.
      if (charWidth > 0) {
        const left = digits * charWidth + textInsetPx + cell.column * charWidth
        const right = left + cell.width * charWidth
        if (left - view.scrollLeft < 0 || right - view.scrollLeft > view.clientWidth) {
          scrollLeft = Math.max(0, left - view.clientWidth / 3)
        }
      }
      return { scrollTop: offScreenY ? scrollTopToCentre(cell.row, view.clientHeight) : view.scrollTop, scrollLeft }
    }
  }
}

// Enough lines that the 1/64px snapping shows up in the measured block height.
const PITCH_LINES = 64
const PITCH_TEXT = Array.from({ length: PITCH_LINES }, () => 'x').join('\n')

/**
 * A computed length in px, or NaN. A browser always resolves these to px; an
 * unresolved one (`normal`, or the `0.75rem` a DOM without layout echoes back)
 * must not be read as that many pixels.
 */
const computedPx = (value: string): number => (/^-?[\d.]+px$/.test(value) ? parseFloat(value) : NaN)

type Axes = 'both' | 'vertical'

const followTransform = (ta: HTMLTextAreaElement, axes: Axes): string =>
  axes === 'vertical' ? `translateY(${-ta.scrollTop}px)` : `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`

/** A live text surface: its geometry, measured off the mounted textarea, and its scroll following. */
export interface TextSurface {
  /** Goes on the textarea. Everything is measured off, and follows, this element. */
  textareaRef: RefObject<HTMLTextAreaElement>
  geometry: TextGeometry
  /** Columns a tab advances to, read off the textarea (highlights are drawn at tab-expanded columns). */
  tabSize: number
  /**
   * The hidden elements the measurements are read off. Render once, as a child
   * of the element that sets the editor's font, alongside the textarea.
   */
  probes: JSX.Element
  /**
   * Ref callbacks for the element of a layer that should move with the text:
   * `both` for content laid out in text coordinates (highlights, chips, the
   * mirror), `vertical` for what stays pinned to the left edge (line numbers,
   * fold markers, full-width bands). The element should be the layer's content
   * box, anchored top-left inside a clipping parent that fills the surface. A
   * layer that mounts late picks the current scroll position up as it mounts.
   */
  follow: { both: (el: HTMLElement | null) => void; vertical: (el: HTMLElement | null) => void }
  /** Bring every follower in line with the textarea's scroll position. Its `onScroll`. */
  sync: () => void
  /** Scroll so a row sits in the middle of the viewport. */
  centreRow: (row: number) => void
  /** Scroll, only as far as needed, so a span of a row is on screen. */
  showCell: (row: number, column: number, width: number) => void
}

/**
 * The text surface of a textarea showing `lineCount` lines. Re-measures on zoom
 * and font changes, and re-syncs its followers after every render of the
 * component using it, so a layer never has to remember to.
 */
export function useTextSurface(lineCount: number): TextSurface {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // A block of PITCH_LINES lines in the editor's font: its height over the line
  // count is the pitch the text is really laid out at.
  const pitchRef = useRef<HTMLDivElement>(null)
  // A 1ch-wide probe: the glyph advance, without measuring the font by hand.
  const charRef = useRef<HTMLSpanElement>(null)
  const [metrics, setMetrics] = useState<TextMetrics>(FALLBACK_METRICS)
  const [tabSize, setTabSize] = useState(DEFAULT_TAB_SIZE)

  useLayoutEffect(() => {
    const probe = pitchRef.current
    const measure = (): void => {
      const ta = textareaRef.current
      // Computed styles are in the same CSS pixels scrollTop is measured in, so
      // the arithmetic holds at any window zoom.
      const cs = ta ? getComputedStyle(ta) : null
      const measured = probe ? probe.getBoundingClientRect().height / PITCH_LINES : 0
      const declared = cs ? computedPx(cs.lineHeight) : NaN
      const padTop = cs ? computedPx(cs.paddingTop) : NaN
      const next: TextMetrics = {
        pitch: measured > 0 ? measured : Number.isFinite(declared) && declared > 0 ? declared : FALLBACK_METRICS.pitch,
        charWidth: charRef.current?.getBoundingClientRect().width ?? 0,
        padTop: Number.isFinite(padTop) ? padTop : FALLBACK_METRICS.padTop
      }
      setMetrics((prev) =>
        prev.pitch === next.pitch && prev.charWidth === next.charWidth && prev.padTop === next.padTop ? prev : next
      )
      if (cs) setTabSize(parseTabSize(cs.tabSize))
    }
    measure()
    if (!probe || typeof ResizeObserver === 'undefined') return
    // Zoom and font changes both change the probe's size.
    const ro = new ResizeObserver(measure)
    ro.observe(probe)
    return () => ro.disconnect()
  }, [])

  const geometry = useMemo(() => textGeometry(metrics, lineCount), [metrics, lineCount])
  const geometryRef = useRef(geometry)
  geometryRef.current = geometry

  // Followers are moved by transform rather than by copying scrollTop across:
  // they have no scrollbar, so their own scroll range is shorter than the
  // textarea's by the horizontal scrollbar's height, and at the very bottom a
  // copied scrollTop clamps while the textarea's keeps going. And each layer
  // moves as ONE transform — a thousand per-rectangle style writes per scroll
  // frame is exactly the jank this avoids.
  const followers = useRef(new Map<HTMLElement, Axes>()).current
  const sync = useCallback((): void => {
    const ta = textareaRef.current
    if (!ta) return
    for (const [el, axes] of followers) {
      // Ref callbacks are shared, so an unmount cannot say which element left.
      if (!el.isConnected) followers.delete(el)
      else el.style.transform = followTransform(ta, axes)
    }
  }, [followers])
  const follow = useMemo(() => {
    const register =
      (axes: Axes) =>
      (el: HTMLElement | null): void => {
        if (!el) return
        followers.set(el, axes)
        const ta = textareaRef.current
        if (ta) el.style.transform = followTransform(ta, axes)
      }
    return { both: register('both'), vertical: register('vertical') }
  }, [followers])
  // Content changes can move the scroll position (or swap a follower's content)
  // without a scroll event; before paint, so nothing is seen out of place.
  useLayoutEffect(sync)

  const centreRow = useCallback(
    (row: number): void => {
      const ta = textareaRef.current
      if (!ta) return
      ta.scrollTop = geometryRef.current.scrollTopToCentre(row, ta.clientHeight)
      sync()
    },
    [sync]
  )
  const showCell = useCallback(
    (row: number, column: number, width: number): void => {
      const ta = textareaRef.current
      if (!ta) return
      const next = geometryRef.current.scrollToShow({ row, column, width }, ta)
      if (next.scrollTop !== ta.scrollTop) ta.scrollTop = next.scrollTop
      if (next.scrollLeft !== ta.scrollLeft) ta.scrollLeft = next.scrollLeft
      sync()
    },
    [sync]
  )

  const probes = useMemo(
    () => (
      <>
        <span
          ref={charRef}
          aria-hidden
          data-testid="char-probe"
          className="pointer-events-none absolute left-0 top-0 block h-0 w-[1ch] opacity-0"
        />
        <div
          ref={pitchRef}
          aria-hidden
          data-testid="pitch-probe"
          className="pointer-events-none invisible absolute left-0 top-0 whitespace-pre"
        >
          {PITCH_TEXT}
        </div>
      </>
    ),
    []
  )

  return { textareaRef, geometry, tabSize, probes, follow, sync, centreRow, showCell }
}
