import { useEffect, useRef, useState } from 'react'
import { Folder } from 'lucide-react'
import type { FileNode } from '@shared/types'
import { fileIcon } from '@renderer/lib/fileIcons'
import { extOf, imageMime } from '@renderer/lib/markdownAssets'

const FOCUS = 'outline-none focus-visible:ring-2 focus-visible:ring-accent/60'

/* ---- Thumbnails ------------------------------------------------------------
 *
 * A folder of screenshots can hold hundreds of images, several MB each, so a
 * thumbnail is only fetched once its tile scrolls into view, a few at a time,
 * and what is kept is a small re-encoded copy rather than the original's
 * base64 — a grid of 300 tiles then holds a few hundred KB, not a few hundred
 * MB. Main's own size cap on `readFileBase64` still bounds any single read.
 * -------------------------------------------------------------------------- */

/** The longest edge a thumbnail is re-encoded to, in device pixels. */
const THUMB_EDGE = 256
/** Thumbnail reads in flight at once. */
const MAX_CONCURRENT = 4
/** Thumbnails remembered across folder visits (oldest dropped first). */
const CACHE_LIMIT = 400

/** MIME for anything the grid can draw as a picture, SVG included. */
export function thumbMime(path: string): string | null {
  return imageMime(path) ?? (extOf(path) === 'svg' ? 'image/svg+xml' : null)
}

const cache = new Map<string, string>()
const inflight = new Map<string, Promise<string>>()
const queue: (() => void)[] = []
let running = 0

/** Forget every cached thumbnail — the editor's refresh button calls this. */
export function clearThumbnailCache(): void {
  cache.clear()
}

function remember(key: string, url: string): void {
  cache.delete(key)
  cache.set(key, url)
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
}

function schedule<T>(job: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = (): void => {
      running++
      job()
        .then(resolve, reject)
        .finally(() => {
          running--
          queue.shift()?.()
        })
    }
    if (running < MAX_CONCURRENT) run()
    else queue.push(run)
  })
}

/**
 * Re-encode a full-size data URL at thumbnail size. SVG is left alone (it is
 * already small and scales cleanly), and so is anything already small enough —
 * or anything the canvas cannot handle, where the original is the fallback.
 */
async function shrink(src: string, mime: string): Promise<string> {
  if (mime === 'image/svg+xml') return src
  const img = new Image()
  img.src = src
  await img.decode()
  const scale = Math.min(1, THUMB_EDGE / Math.max(img.naturalWidth, img.naturalHeight, 1))
  if (scale === 1) return src
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return src
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  // WebP keeps transparency (a PNG sprite sheet stays see-through) at a
  // fraction of PNG's size.
  return canvas.toDataURL('image/webp', 0.85)
}

function loadThumbnail(worktreeId: string, path: string, mime: string): Promise<string> {
  const key = `${worktreeId}\0${path}`
  const hit = cache.get(key)
  if (hit) return Promise.resolve(hit)
  const pending = inflight.get(key)
  if (pending) return pending
  const p = schedule(async () => {
    const b64 = await window.orbital.readFileBase64(worktreeId, path)
    const full = `data:${mime};base64,${b64}`
    return shrink(full, mime).catch(() => full)
  })
    .then((url) => {
      remember(key, url)
      return url
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

function Thumbnail({ worktreeId, node, mime }: { worktreeId: string; node: FileNode; mime: string }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [src, setSrc] = useState<string | null>(() => cache.get(`${worktreeId}\0${node.path}`) ?? null)
  const [failed, setFailed] = useState(false)

  // Load only once the tile is near the viewport. Without an observer (jsdom)
  // everything counts as visible.
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true)
          io.disconnect()
        }
      },
      { rootMargin: '200px' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (!visible || src) return
    let alive = true
    loadThumbnail(worktreeId, node.path, mime).then(
      (url) => alive && setSrc(url),
      () => alive && setFailed(true)
    )
    return () => {
      alive = false
    }
  }, [visible, src, worktreeId, node.path, mime])

  const { Icon, className: iconColor } = fileIcon(node.path)
  return (
    <div ref={ref} className="grid size-full place-items-center">
      {src ? (
        <img
          src={src}
          alt=""
          draggable={false}
          className="max-h-full max-w-full rounded-[3px] object-contain [background:repeating-conic-gradient(var(--checker-a)_0%_25%,var(--checker-b)_0%_50%)_0_0/12px_12px]"
        />
      ) : (
        <Icon size={28} strokeWidth={1.25} className={`${iconColor} ${failed ? '' : 'opacity-40'}`} />
      )}
    </div>
  )
}

/* ---- The grid -------------------------------------------------------------- */

/**
 * A folder's entries as tiles: images as thumbnails, everything else as its
 * type icon. A click on a file follows the tree's rules (preview; double-click
 * keeps it open). A click on a folder only selects it — double-click (or
 * Enter) goes in, the way a file browser does, so browsing does not jump away
 * on a stray click.
 */
export default function FolderView({
  worktreeId,
  entries,
  selectedPath,
  onOpenFile,
  onEnterDir,
  onContextMenu
}: {
  worktreeId: string
  /** Null while an ignored folder's listing is still being fetched. */
  entries: FileNode[] | null
  selectedPath: string | null
  onOpenFile: (node: FileNode, keep: boolean) => void
  onEnterDir: (path: string) => void
  onContextMenu: (e: React.MouseEvent, node: FileNode) => void
}): JSX.Element {
  const [picked, setPicked] = useState<string | null>(null)

  if (entries === null) return <div className="px-4 py-3 font-mono text-[11px] text-faint">Loading…</div>
  if (entries.length === 0) return <div className="px-4 py-3 text-xs text-faint">This folder is empty</div>

  return (
    <div
      data-testid="folder-view"
      className="grid gap-2 p-3 [grid-template-columns:repeat(auto-fill,minmax(112px,1fr))]"
    >
      {entries.map((node) => {
        const isDir = node.type === 'dir'
        const mime = isDir ? null : thumbMime(node.path)
        const selected = node.path === picked || node.path === selectedPath
        const { Icon, className: iconColor } = fileIcon(node.path)
        return (
          <button
            key={node.path}
            type="button"
            title={node.path}
            data-testid="folder-tile"
            onClick={() => {
              setPicked(node.path)
              if (!isDir) onOpenFile(node, false)
            }}
            onDoubleClick={() => (isDir ? onEnterDir(node.path) : onOpenFile(node, true))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && isDir) {
                e.preventDefault()
                onEnterDir(node.path)
              }
            }}
            onContextMenu={(e) => onContextMenu(e, node)}
            className={`flex min-w-0 flex-col items-stretch gap-1.5 rounded-btn border p-1.5 text-left ${
              selected ? 'border-accent/50 bg-accent/10' : 'border-transparent hover:bg-hover'
            } ${node.ignored ? 'opacity-60' : ''} ${FOCUS}`}
          >
            <div className="grid aspect-[4/3] place-items-center overflow-hidden rounded-[5px] bg-panel-2 p-1.5">
              {isDir ? (
                <Folder size={34} strokeWidth={1.25} className="text-muted" />
              ) : mime ? (
                <Thumbnail worktreeId={worktreeId} node={node} mime={mime} />
              ) : (
                <Icon size={28} strokeWidth={1.25} className={iconColor} />
              )}
            </div>
            <span
              className={`truncate px-0.5 text-center text-[11px] ${isDir ? 'text-text-3' : 'font-mono text-text-3'}`}
            >
              {node.name}
            </span>
          </button>
        )
      })}
    </div>
  )
}
