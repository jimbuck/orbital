/**
 * Small filesystem helpers shared by the providers' session lookups. Every CLI
 * files its conversations somewhere under its profile directory and keys them
 * by the working directory they ran in; these are the pieces of "is this the
 * same directory" and "what is in this folder" that each provider needs.
 */
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

/** A session id every supported CLI produces: a UUID. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Whether two paths name the same directory, tolerant of the differences the
 * CLIs and Orbital produce for one place: separator style, a trailing slash,
 * and (on Windows) letter case.
 */
export function samePath(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b)
}

function canonicalPath(p: string): string {
  let out = resolve(p).replace(/[\\/]+$/, '')
  if (process.platform === 'win32') out = out.toLowerCase().replace(/\//g, '\\')
  return out
}

/** Names of the subdirectories of `dir`, or [] when it is missing/unreadable. */
export function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
}

/** Names of the plain files in `dir`, or [] when it is missing/unreadable. */
export function files(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
  } catch {
    return []
  }
}

/** Whether `path` is an existing directory. */
export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Last-modified time of `path` in ms epoch, or 0 when it cannot be read. */
export function mtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/**
 * The first `bytes` of a file as UTF-8, or '' when it cannot be read. For
 * pulling a header record out of a transcript that may be megabytes long.
 */
export function readHead(path: string, bytes = 64 * 1024): string {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(bytes)
    const n = readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, n).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== null) closeSync(fd)
  }
}
