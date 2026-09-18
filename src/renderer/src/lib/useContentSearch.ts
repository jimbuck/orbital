import { useEffect, useMemo, useRef, useState } from 'react'
import type { SearchQuery, SearchResults } from '@shared/types'

/**
 * Run a content search as the user types, shared by the Search tab and the
 * palette's `/` view so they debounce, cancel and gate identically.
 *
 * Three things make this safe to drive from a keystroke:
 *
 *  - **A slot id.** Main kills whatever was running under `searchId` when a new
 *    search arrives in it, so a burst of typing leaves one live grep rather
 *    than one per character. Each caller owns its own slot, which is why the
 *    tab passes its tab id and the palette passes a constant.
 *  - **A debounce**, so a slot is not churned on every keypress to begin with.
 *  - **A minimum length.** A one-character query matches most of a repo: the
 *    scan is the most expensive one there is and the result is useless.
 *
 * `results` holds the last completed search, so the previous hits stay on
 * screen while the next one runs rather than the list blanking on every
 * keystroke. `searching` says whether one is in flight.
 */

/** Queries shorter than this are not run at all. */
const MIN_LENGTH = 2

export interface ContentSearchState {
  /** The last completed results, or null before the first search. */
  results: SearchResults | null
  searching: boolean
  /** The query those results came from, for rendering them against the right term. */
  ranFor: SearchQuery | null
}

export function useContentSearch(
  searchId: string,
  /** The search to run, or null to run nothing and clear. */
  query: SearchQuery | null,
  opts: { debounceMs?: number; minLength?: number } = {}
): ContentSearchState {
  const debounceMs = opts.debounceMs ?? 180
  const minLength = opts.minLength ?? MIN_LENGTH
  const [state, setState] = useState<ContentSearchState>({ results: null, searching: false, ranFor: null })

  // The query is rebuilt every render, so the effect keys on its CONTENT.
  // Without this the effect re-runs on every render and the debounce never
  // fires.
  const key = query ? JSON.stringify(query) : ''
  const queryRef = useRef(query)
  queryRef.current = query

  const runnable = useMemo(
    () => !!query && query.query.trim().length >= minLength,
    [query, minLength]
  )

  useEffect(() => {
    if (!runnable) {
      setState({ results: null, searching: false, ranFor: null })
      return
    }
    const sent = queryRef.current
    if (!sent) return
    let live = true
    setState((s) => ({ ...s, searching: true }))
    const timer = setTimeout(() => {
      window.orbital
        .searchContent(sent, searchId)
        .then((results) => {
          // A superseded search returns cancelled; its empty file list must not
          // wipe the results the user is currently reading.
          if (!live || results.cancelled) return
          setState({ results, searching: false, ranFor: sent })
        })
        .catch(() => {
          if (live) setState((s) => ({ ...s, searching: false }))
        })
    }, debounceMs)
    return () => {
      live = false
      clearTimeout(timer)
    }
    // `key` stands in for `query` by content; queryRef carries the value.
  }, [key, runnable, searchId, debounceMs])

  // Leaving (tab closed, palette dismissed) must stop whatever is still running
  // in this slot; otherwise a grep over a large workspace outlives its reader.
  useEffect(() => {
    return () => {
      void window.orbital.cancelSearch(searchId).catch(() => undefined)
    }
  }, [searchId])

  return state
}
