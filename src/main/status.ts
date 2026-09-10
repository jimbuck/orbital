import type { TerminalStatus } from '@shared/types'
import { runtime, repo } from './runtime'

/**
 * Terminal status policy and the runtime-only bookkeeping behind it: which
 * Claude hook event means what, how async hook deliveries are ordered, why a
 * tab is blocked on a human, and the one place a PTY tab's status is written.
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

/** Record a status event's fire time; false when a later-fired event already landed. */
export function acceptStatusEvent(terminalId: string, firedAt: unknown): boolean {
  const ts = typeof firedAt === 'number' && Number.isFinite(firedAt) ? firedAt : Date.now()
  if (ts < (statusAppliedAt.get(terminalId) ?? 0)) return false
  statusAppliedAt.set(terminalId, ts)
  return true
}

/**
 * Why each needs-attention tab is blocked, keyed by tab id: the Notification
 * hook's notification_type ('permission_prompt' | 'idle_prompt'), recorded when
 * that status lands and cleared when it resolves. Human input consults this to
 * pick the right next status — answering a permission prompt puts Claude
 * straight to work, while typing at an idle prompt is just composing.
 */
const attentionKind = new Map<string, string>()

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

/**
 * Where a tab goes when the human types into it while it is blocked. Answering
 * something Claude ASKED — a permission prompt, an elicitation dialog, a request
 * for input — puts it straight back to work (and a long approved tool emits no
 * hook until it finishes). The exception is an idle prompt: nobody asked
 * anything, so typing there is just composing the next instruction and the tab
 * stays idle until the UserPromptSubmit hook fires on send.
 */
export function statusAfterHumanInput(kind: string | undefined): TerminalStatus {
  return kind && kind !== 'idle_prompt' && BLOCKING_NOTIFICATIONS.has(kind) ? 'working' : 'idle'
}

// Focus-in/out reports and mouse-tracking sequences a TUI subscribed to — sent
// by merely clicking into or scrolling a terminal, so not a human response.
// eslint-disable-next-line no-control-regex
const TERMINAL_REPORTS = /\x1b\[(?:I|O|<\d+;\d+;\d+[Mm]|M[\s\S]{3})/g

/** True when terminal input contains an actual keystroke/paste, not just reports. */
export function isHumanKeystroke(data: string): boolean {
  return data.replace(TERMINAL_REPORTS, '').length > 0
}

/** Why a tab is blocked (its last blocking notification_type), if it is. */
export function attentionKindOf(tabId: string): string | undefined {
  return attentionKind.get(tabId)
}

export function setAttentionKind(tabId: string, kind: string): void {
  attentionKind.set(tabId, kind)
}

export function clearAttentionKind(tabId: string): void {
  attentionKind.delete(tabId)
}

/**
 * The human acted on this tab at this moment (typed into it, cleared its
 * status): hook events fired before now must not overwrite what follows.
 */
export function markHumanAction(tabId: string): void {
  statusAppliedAt.set(tabId, Date.now())
}

/** Drop a tab's bookkeeping once it is gone, so the maps never outgrow the live tabs. */
export function forgetTabStatus(tabId: string): void {
  statusAppliedAt.delete(tabId)
  attentionKind.delete(tabId)
}

/**
 * Persist a PTY tab's status, refresh its Worktree's aggregate, and push the
 * state and alert. The one write path for status — every source (hooks, the
 * CLI, human input, a failed agent launch) lands here.
 */
export function setTabStatus(tabId: string, worktreeId: string, status: TerminalStatus): void {
  repo.tabs.updateStatus(tabId, status)
  repo.worktrees.recomputeStatus(worktreeId)
  runtime.broadcastState()
  runtime.broadcastAlert()
}

/**
 * Map a Claude Code hook event (+ its stdin payload) to a terminal status, or
 * null to ignore. This is the single source of the event→status policy — the
 * global settings.json just lists which events to forward.
 */
export function hookEventToStatus(event: string, payload: Record<string, unknown>): TerminalStatus | null {
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
