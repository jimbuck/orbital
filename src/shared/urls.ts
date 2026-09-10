/**
 * Schemes the app will hand to the OS browser. Everything that reaches
 * `shell.openExternal` is renderer-supplied (a link in a terminal, a markdown
 * preview, a <webview>'s current page), and on Windows openExternal launches
 * whatever the scheme's registered handler is — `file:` runs a program,
 * `ms-msdt:` and friends have had their own CVEs. Web pages and mail only.
 */
const OPENABLE_SCHEMES = new Set(['http:', 'https:', 'mailto:'])

export function isOpenableExternalUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return OPENABLE_SCHEMES.has(parsed.protocol)
}
