import { isPtyTabType, type TerminalStatus } from '@shared/types'
import { runtime, repo } from './runtime'

/**
 * Terminal status: the one module that decides what a PTY tab's status is.
 *
 * Callers do not sequence anything. They report what happened — a Claude hook
 * fired, the tab reported its own status, the human typed, a PTY exited, a tab
 * was closed — and this module owns the rest: which hook event means what, the
 * ordering of async hook deliveries, why a tab is blocked on a human, the
 * Worktree roll-up, and the state and alert pushes that follow a change.
 *
 * Every write to a tab's status goes through `apply` below. Nothing outside
 * this file calls `repo.tabs.updateStatus` or `repo.worktrees.recomputeStatus`.
 */

/**
 * Fire time of the last status event applied per terminal (runtime-only state).
 *
 * Claude hooks are registered async, so each event arrives from its own
 * short-lived `orbital hook` process and pipe DELIVERY order is not fire order:
 * the PostToolUse of a turn's final tool call regularly lands after the Stop
 * that ended the turn, wedging an idle worktree on the "working" spinner. Every
 * status-bearing request carries the moment it was fired (stamped by the CLI
 * before its stdin wait); an event older than the last one applied is stale.
 */
const statusAppliedAt = new Map<string, number>()

/**
 * Why each needs-attention tab is blocked, keyed by tab id: the Notification
 * hook's notification_type ('permission_prompt' | 'idle_prompt' | …), recorded
 * when that status lands and cleared when it resolves. Human input consults
 * this to pick the right next status — answering a permission prompt puts
 * Claude straight to work, while typing at an idle prompt is just composing.
 */
const attentionKind = new Map<string, string>()

/**
 * Fire times of each tab's latest SessionStart and UserPromptSubmit, so an
 * idle_prompt can tell whether the session it belongs to has had a turn yet.
 * Times rather than a flag because async hooks arrive out of order: an agent
 * launched with an initial prompt can deliver its UserPromptSubmit before the
 * SessionStart that preceded it.
 */
const sessionStartedAt = new Map<string, number>()
const promptedAt = new Map<string, number>()

/**
 * Notification types that mean Claude is blocked on a human. Beyond the two
 * prompt kinds, Claude raises elicitation dialogs (a question or a URL to visit)
 * and agent-input requests — all of them a stopped agent waiting for a person,
 * which is exactly what the rail badge and the chime exist to surface.
 */
const BLOCKING_NOTIFICATIONS = new Set([
  'permission_prompt',
  'idle_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input'
])

/** Notification types that mean such a block just resolved and Claude carries on. */
const RESOLVED_NOTIFICATIONS = new Set(['elicitation_complete', 'elicitation_response'])

// Focus-in/out reports and mouse-tracking sequences a TUI subscribed to — sent
// by merely clicking into or scrolling a terminal, so not a human response.
// eslint-disable-next-line no-control-regex
const TERMINAL_REPORTS = /\x1b\[(?:I|O|<\d+;\d+;\d+[Mm]|M[\s\S]{3})/g

const fireTime = (firedAt: unknown): number =>
  typeof firedAt === 'number' && Number.isFinite(firedAt) ? firedAt : Date.now()

/* ---- events -------------------------------------------------------------- */

/**
 * A Claude Code hook fired in this tab's session (`orbital hook <event>`).
 * Returns the status it put the tab in, or null when the event changed nothing:
 * an event that carries no status, one a later-fired event already beat here,
 * or an idle prompt from a session nobody has prompted yet.
 */
export function hookFired(
  tabId: string,
  event: string,
  payload: Record<string, unknown>,
  firedAt: unknown
): TerminalStatus | null {
  const tab = repo.tabs.get(tabId)
  if (!tab) return null
  const ts = fireTime(firedAt)
  // Session and prompt starts are tracked whether or not the event goes on to
  // change the status: the unprompted-idle check below reads them.
  const lifecycle = event === 'SessionStart' ? sessionStartedAt : event === 'UserPromptSubmit' ? promptedAt : null
  if (lifecycle && ts >= (lifecycle.get(tabId) ?? 0)) lifecycle.set(tabId, ts)

  const status = hookEventToStatus(event, payload)
  if (!status) return null
  // An empty session (just `/clear`ed, or launched bare) idling at its prompt
  // is not waiting on anyone.
  if (status === 'needs_attention' && isUnpromptedIdle(tabId, payload)) return null
  // Async hooks race over the pipe — drop an event a later-fired one beat here.
  if (!accept(tabId, ts)) return null
  if (status === 'needs_attention') attentionKind.set(tabId, String(payload.notification_type ?? ''))
  else attentionKind.delete(tabId)
  apply(tabId, tab.worktreeId, status)
  return status
}

/**
 * The tab set its own status (`orbital status <s>`). Subject to the same
 * fire-time ordering as hooks. A CLI-set needs-attention has no prompt kind,
 * so typing into the tab afterwards resets it to idle.
 */
export function statusReported(tabId: string, status: TerminalStatus, firedAt: unknown): void {
  const tab = repo.tabs.get(tabId)
  if (!tab) return
  if (!accept(tabId, fireTime(firedAt))) return
  attentionKind.delete(tabId)
  apply(tabId, tab.worktreeId, status)
}

/**
 * The human sent input to this tab's PTY. If the tab was flagged
 * needs-attention and the input is a real keystroke or paste, they have
 * responded, so it is no longer blocked on a human. This covers agent tabs AND
 * plain terminal tabs (an agent launched by hand, or `orbital status`, flags
 * those just the same). Uses INPUT only — never scrapes terminal output.
 */
export function humanTyped(tabId: string, data: string): void {
  const tab = repo.tabs.get(tabId)
  if (!tab || !isPtyTabType(tab.type) || tab.status !== 'needs_attention') return
  if (data.replace(TERMINAL_REPORTS, '').length === 0) return
  // The human's response supersedes anything already in flight: hook events
  // fired before this moment must not overwrite the flip below.
  statusAppliedAt.set(tabId, Date.now())
  const next = statusAfterHumanInput(attentionKind.get(tabId))
  attentionKind.delete(tabId)
  apply(tabId, tab.worktreeId, next)
}

/**
 * Every PTY tab in the Worktree goes back to idle: the user force-cleared its
 * status, or the app just started and every PTY in it is fresh. Supersedes
 * anything already in flight, so hook events fired before this moment cannot
 * re-set a status afterwards.
 */
export function resetWorktree(worktreeId: string): void {
  const worktree = repo.worktrees.get(worktreeId)
  if (!worktree) return
  const now = Date.now()
  for (const pane of worktree.panes) {
    for (const tab of pane.tabs) {
      if (!isPtyTabType(tab.type)) continue
      statusAppliedAt.set(tab.id, now)
      attentionKind.delete(tab.id)
      repo.tabs.updateStatus(tab.id, 'idle')
    }
  }
  rollUp(worktreeId)
}

/**
 * The tab's PTY process exited but the tab stays (a plain terminal). A dead
 * PTY must stop contributing a stale status to the Worktree aggregate, or the
 * rail and taskbar stay stuck on working / needs-you.
 */
export function ptyExited(tabId: string): void {
  const tab = repo.tabs.get(tabId)
  if (!tab || !isPtyTabType(tab.type)) return
  attentionKind.delete(tabId)
  apply(tabId, tab.worktreeId, 'idle')
}

/** The tab's agent could not be launched. */
export function launchFailed(tabId: string): void {
  const tab = repo.tabs.get(tabId)
  if (!tab) return
  attentionKind.delete(tabId)
  apply(tabId, tab.worktreeId, 'error')
}

/**
 * Tabs were removed from a Worktree that lives on (a tab or pane was closed,
 * an agent exited and took its tab with it). Call after their rows are gone:
 * drops their bookkeeping and re-aggregates the Worktree without them.
 */
export function tabsClosed(worktreeId: string, tabIds: string[]): void {
  forgetTabs(tabIds)
  rollUp(worktreeId)
}

/**
 * Drop the bookkeeping for tabs whose Worktree is going away with them, so the
 * maps never outgrow the live tabs. No roll-up: there is nothing left to
 * aggregate into.
 */
export function forgetTabs(tabIds: string[]): void {
  for (const tabId of tabIds) {
    statusAppliedAt.delete(tabId)
    attentionKind.delete(tabId)
    sessionStartedAt.delete(tabId)
    promptedAt.delete(tabId)
  }
}

/* ---- rules --------------------------------------------------------------- */

/** Record a status event's fire time; false when a later-fired event already landed. */
function accept(tabId: string, ts: number): boolean {
  if (ts < (statusAppliedAt.get(tabId) ?? 0)) return false
  statusAppliedAt.set(tabId, ts)
  return true
}

/**
 * True for an idle_prompt from a session nobody has prompted yet — the state
 * `/clear` leaves behind (and a bare launch). Claude still raises idle_prompt
 * there a minute later, but an empty session waiting at its prompt is not
 * asking for anything, so it should not light the needs-attention badge.
 * A tab Orbital has seen no SessionStart for (the app restarted mid-session)
 * is not treated as fresh.
 */
function isUnpromptedIdle(tabId: string, payload: Record<string, unknown>): boolean {
  if (payload.notification_type !== 'idle_prompt') return false
  const started = sessionStartedAt.get(tabId)
  return started !== undefined && (promptedAt.get(tabId) ?? 0) < started
}

/**
 * Where a tab goes when the human types into it while it is blocked. Answering
 * something Claude ASKED — a permission prompt, an elicitation dialog, a request
 * for input — puts it straight back to work (and a long approved tool emits no
 * hook until it finishes). The exception is an idle prompt: nobody asked
 * anything, so typing there is just composing the next instruction and the tab
 * stays idle until the UserPromptSubmit hook fires on send.
 */
function statusAfterHumanInput(kind: string | undefined): TerminalStatus {
  return kind && kind !== 'idle_prompt' && BLOCKING_NOTIFICATIONS.has(kind) ? 'working' : 'idle'
}

/**
 * Map a Claude Code hook event (+ its stdin payload) to a terminal status, or
 * null to ignore. This is the single source of the event→status policy — the
 * global settings.json just lists which events to forward.
 */
function hookEventToStatus(event: string, payload: Record<string, unknown>): TerminalStatus | null {
  switch (event) {
    case 'Notification': {
      // The load-bearing signal: Claude is blocked waiting on a human.
      const kind = String(payload.notification_type ?? '')
      if (BLOCKING_NOTIFICATIONS.has(kind)) return 'needs_attention'
      // A dialog answered somewhere other than this terminal (a URL elicitation
      // opened in the browser) produces no keystroke here, so without this the
      // worktree would sit on needs-attention until the next tool call.
      if (RESOLVED_NOTIFICATIONS.has(kind)) return 'working'
      // Everything else — auth_success, agent_completed, types added in future
      // Claude versions — says nothing about whether a human is needed.
      return null
    }
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return 'working'
    case 'Stop':
      return 'idle'
    case 'StopFailure':
      return 'error'
    case 'SessionStart':
      return 'idle'
    case 'SessionEnd':
      return 'done'
    default:
      return null
  }
}

/* ---- the write path ------------------------------------------------------ */

/** Persist one tab's status, then re-aggregate its Worktree and push. */
function apply(tabId: string, worktreeId: string, status: TerminalStatus): void {
  repo.tabs.updateStatus(tabId, status)
  rollUp(worktreeId)
}

/** Refresh a Worktree's aggregate from its tabs and push the state and the alert. */
function rollUp(worktreeId: string): void {
  repo.worktrees.recomputeStatus(worktreeId)
  runtime.broadcastState()
  runtime.broadcastAlert()
}
