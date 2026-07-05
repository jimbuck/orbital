import { BrowserWindow, nativeImage } from 'electron'
import type { Flight, Settings, AlertEvent } from '@shared/types'

/**
 * AlertManager owns the Windows taskbar leg of the three-way needs-attention
 * alert (overlay badge). Sound + in-app banner are handled in the renderer.
 *
 * On every state change the orchestrator calls `update(flights)`; the manager
 * computes how many Flights need attention, paints/clears the taskbar overlay,
 * and returns an AlertEvent that the renderer consumes for chime/banner.
 */
export class AlertManager {
  /** Needs-attention count from the previous `update`, for rising-edge detection. */
  private prev = 0

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly getSettings: () => Settings
  ) {}

  /**
   * Recompute the needs-attention set, drive the taskbar overlay icon, and
   * report the transition. `rising` is true when a *new* Flight has just
   * started needing attention (count grew), which the renderer uses to decide
   * whether to chime/re-badge rather than re-alert on every tick.
   */
  update(flights: Pick<Flight, 'id' | 'status'>[]): AlertEvent {
    const needing = flights.filter((f) => f.status === 'needs_attention')
    const count = needing.length
    const firstId = count > 0 ? needing[0].id : null
    const rising = count > this.prev

    if (this.getSettings().alerts.taskbarBadge) {
      const win = this.getWindow()
      if (win) {
        try {
          if (count > 0) {
            win.setOverlayIcon(this.buildBadge(count), `${count} need attention`)
          } else {
            win.setOverlayIcon(null, '')
          }
        } catch {
          // setOverlayIcon can throw if the window was destroyed mid-update;
          // the badge is best-effort, so swallow and keep the loop alive.
        }
      }
    }

    this.prev = count
    return { count, flightId: firstId, rising }
  }

  /**
   * Build a 32x32 amber (#e8b54a) filled-circle PNG for the taskbar overlay.
   * The PNG is assembled by hand (IHDR/IDAT/IEND with a single stored zlib
   * block) so the manager has no dependencies beyond `electron` itself.
   */
  private buildBadge(count: number): Electron.NativeImage {
    void count // a single amber dot is sufficient signal; count rides in the tooltip.
    const size = 32
    const cx = (size - 1) / 2
    const cy = (size - 1) / 2
    const r = size / 2 - 1

    // Raw RGBA scanlines, each prefixed with a "none" (0) filter byte.
    const raw = Buffer.alloc(size * (1 + size * 4))
    let off = 0
    for (let y = 0; y < size; y++) {
      raw[off++] = 0 // filter type: none
      for (let x = 0; x < size; x++) {
        const dx = x - cx
        const dy = y - cy
        const inside = dx * dx + dy * dy <= r * r
        raw[off++] = inside ? 0xe8 : 0x00 // R
        raw[off++] = inside ? 0xb5 : 0x00 // G
        raw[off++] = inside ? 0x4a : 0x00 // B
        raw[off++] = inside ? 0xff : 0x00 // A
      }
    }

    const png = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
      this.pngChunk('IHDR', this.ihdr(size)),
      this.pngChunk('IDAT', this.zlibStore(raw)),
      this.pngChunk('IEND', Buffer.alloc(0))
    ])

    return nativeImage.createFromDataURL(`data:image/png;base64,${png.toString('base64')}`)
  }

  /** 13-byte IHDR payload: square, 8-bit, RGBA, no compression/filter/interlace. */
  private ihdr(size: number): Buffer {
    const buf = Buffer.alloc(13)
    buf.writeUInt32BE(size, 0)
    buf.writeUInt32BE(size, 4)
    buf[8] = 8 // bit depth
    buf[9] = 6 // color type: truecolor + alpha
    buf[10] = 0 // compression
    buf[11] = 0 // filter
    buf[12] = 0 // interlace
    return buf
  }

  /** Wrap data in a length-prefixed, CRC32-suffixed PNG chunk. */
  private pngChunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(this.crc32(typed), 0)
    return Buffer.concat([len, typed, crc])
  }

  /** Minimal zlib stream using one uncompressed ("stored") deflate block. */
  private zlibStore(raw: Buffer): Buffer {
    const len = raw.length // < 65536 for a 32x32 image, fits one stored block
    const header = Buffer.from([0x78, 0x01]) // CMF/FLG
    const block = Buffer.alloc(5)
    block[0] = 0x01 // BFINAL=1, BTYPE=00 (stored)
    block.writeUInt16LE(len, 1)
    block.writeUInt16LE(~len & 0xffff, 3)
    const adler = Buffer.alloc(4)
    adler.writeUInt32BE(this.adler32(raw), 0)
    return Buffer.concat([header, block, raw, adler])
  }

  /** Standard PNG/zlib CRC32 (polynomial 0xEDB88320). */
  private crc32(buf: Buffer): number {
    let crc = 0xffffffff
    for (let i = 0; i < buf.length; i++) {
      crc ^= buf[i]
      for (let k = 0; k < 8; k++) {
        crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
      }
    }
    return (crc ^ 0xffffffff) >>> 0
  }

  /** Adler-32 checksum for the zlib trailer. */
  private adler32(buf: Buffer): number {
    let a = 1
    let b = 0
    const MOD = 65521
    for (let i = 0; i < buf.length; i++) {
      a = (a + buf[i]) % MOD
      b = (b + a) % MOD
    }
    return ((b << 16) | a) >>> 0
  }
}
