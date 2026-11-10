import type { Settings, SettingsPatch } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { useStore } from '../store'

/**
 * The renderer's way in to settings: read one with its default already
 * applied, and write one through the single optimistic write path. Nothing
 * else in the renderer needs to know what a setting defaults to (that is the
 * schema's, in `@shared/settings`) or how a click becomes a persisted value.
 *
 * The Settings modal is the one other writer, on purpose: it edits several
 * fields as a form and saves them as one patch (see `changedOnly` there).
 */

/**
 * A setting's value from a store snapshot, or its default before settings have
 * loaded. For callers that are not components (the palette builds its command
 * list from a snapshot); components use {@link useSetting}.
 */
export function settingOf<K extends keyof Settings>(settings: Settings | null, key: K): Settings[K] {
  // `??` rather than a null check on `settings` alone, so an object missing the
  // key reads as the default too. Safe for every key: the only setting that can
  // itself be null (the accent) also defaults to null.
  return settings?.[key] ?? DEFAULT_SETTINGS[key]
}

/** Subscribe to one setting. Its default until settings have loaded. */
export function useSetting<K extends keyof Settings>(key: K): Settings[K] {
  return useStore((s) => settingOf(s.settings, key))
}

/**
 * Change one setting: apply it to the store at once, persist that key alone,
 * and roll back if the write fails.
 *
 * Applied optimistically so the UI responds immediately rather than waiting on
 * the IPC round trip; `App` re-derives everything from the store.
 *
 * The patch carries ONLY this key. Sending a whole in-memory snapshot would let
 * a concurrent writer — another Orbital instance, or the open Settings modal —
 * be reverted by a stale copy of an unrelated field; main merges the patch into
 * a fresh read inside a transaction, so disjoint edits cannot collide.
 *
 * No-ops until settings have loaded — with nothing to update optimistically the
 * app would not change until the next broadcast anyway, and there is no user to
 * please before the first state arrives.
 *
 * If the write fails the optimistic apply is rolled back. That is the deliberate
 * choice here, over both alternatives:
 *
 * - Leaving the new value applied is the worst option. The user is shown a
 *   success that never happened, and the app then contradicts it minutes later,
 *   when some unrelated state broadcast lands and snaps it back with no apparent
 *   cause. Rolling back puts the failure where the user can connect it to
 *   something — the click they just made visibly did not take.
 * - Popping a message would mean inventing an app-wide notification surface,
 *   which Orbital does not have; these controls are also reachable from the View
 *   menu, where there is nothing to render one into. That is disproportionate for
 *   a failure that needs the settings row to be locked by another process for
 *   several seconds. The console line is for whoever is debugging that case.
 *
 * The rollback is conditional: if the store has since moved on (a later click,
 * or a broadcast carrying another instance's change), that value is newer than
 * what this call knows and is left alone.
 *
 * A value the store already shows is not written again, unless `always` is set:
 * a control that previews through the store before committing (the accent
 * picker being dragged) ends on a value the store already has, and that final
 * value still has to be persisted.
 */
export function saveSetting<K extends keyof Settings>(
  key: K,
  value: Settings[K],
  opts: { always?: boolean } = {}
): void {
  const settings = useStore.getState().settings
  if (!settings) return
  const previous = settings[key]
  if (previous === value) {
    if (!opts.always) return
  } else {
    useStore.setState({ settings: { ...settings, [key]: value } })
  }
  void window.orbital.setSettings({ [key]: value } as SettingsPatch).catch((err: unknown) => {
    const current = useStore.getState().settings
    if (current && current[key] === value) {
      useStore.setState({ settings: { ...current, [key]: previous } })
    }
    console.error(`Couldn't save the ${key} setting — it has been reverted.`, err)
  })
}
