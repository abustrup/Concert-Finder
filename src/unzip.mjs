// A ZIP reader in about 150 lines, with no dependencies.
//
// This exists for one reason: the promise on the front of the site is that a
// person's listening history never leaves their browser. A third-party unzip
// library would be a script from someone else's server, running with full
// access to the file the user just dropped in. The promise would then rest on
// that vendor's good behaviour rather than on anything we control.
//
// DecompressionStream('deflate-raw') is in every current browser and in Node
// 22, so the deflate work is the platform's, and the only code here is the
// container format.

const EOCD_SIG = 0x06054b50
const EOCD64_LOCATOR_SIG = 0x07064b50
const EOCD64_SIG = 0x06064b50
const CDH_SIG = 0x02014b50
const LFH_SIG = 0x04034b50

class Reader {
  constructor(buf) {
    this.view = new DataView(buf)
    this.bytes = new Uint8Array(buf)
  }
  u16(o) {
    return this.view.getUint16(o, true)
  }
  u32(o) {
    return this.view.getUint32(o, true)
  }
  u64(o) {
    // ZIP64 sizes. Beyond Number.MAX_SAFE_INTEGER we would be lying anyway.
    const lo = this.view.getUint32(o, true)
    const hi = this.view.getUint32(o + 4, true)
    return hi * 0x100000000 + lo
  }
  str(o, len) {
    return new TextDecoder('utf-8').decode(this.bytes.subarray(o, o + len))
  }
}

function findEOCD(r) {
  // The EOCD is at the end, but a trailing comment can push it back up to 64KB.
  const max = Math.min(r.bytes.length, 0xffff + 22)
  for (let i = 22; i <= max; i++) {
    const off = r.bytes.length - i
    if (off < 0) break
    if (r.u32(off) === EOCD_SIG) return off
  }
  return -1
}

/**
 * List the entries in a zip. Returns [{name, size, read()}] where read() is
 * lazy: a Spotify export can hold hundreds of megabytes of files we do not
 * want, and inflating them all to find four would be gratuitous.
 */
export function openZip(arrayBuffer) {
  const r = new Reader(arrayBuffer)
  const eocd = findEOCD(r)
  if (eocd < 0) throw new Error('Not a zip file (no end-of-central-directory record found)')

  let entryCount = r.u16(eocd + 10)
  let cdOffset = r.u32(eocd + 16)

  // ZIP64, when the archive has more than 65535 entries or is over 4GB.
  const locatorOff = eocd - 20
  if (locatorOff >= 0 && r.u32(locatorOff) === EOCD64_LOCATOR_SIG) {
    const eocd64Off = r.u64(locatorOff + 8)
    if (eocd64Off >= 0 && eocd64Off < r.bytes.length && r.u32(eocd64Off) === EOCD64_SIG) {
      entryCount = r.u64(eocd64Off + 32)
      cdOffset = r.u64(eocd64Off + 48)
    }
  }

  const entries = []
  let p = cdOffset
  for (let i = 0; i < entryCount; i++) {
    if (p + 46 > r.bytes.length || r.u32(p) !== CDH_SIG) break
    const method = r.u16(p + 10)
    let compressedSize = r.u32(p + 20)
    let uncompressedSize = r.u32(p + 24)
    const nameLen = r.u16(p + 28)
    const extraLen = r.u16(p + 30)
    const commentLen = r.u16(p + 32)
    let localOffset = r.u32(p + 42)
    const name = r.str(p + 46, nameLen)

    // ZIP64 extended information, when any field is the 0xffffffff sentinel.
    if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      let e = p + 46 + nameLen
      const end = e + extraLen
      while (e + 4 <= end) {
        const id = r.u16(e)
        const sz = r.u16(e + 2)
        if (id === 0x0001) {
          let q = e + 4
          if (uncompressedSize === 0xffffffff) {
            uncompressedSize = r.u64(q)
            q += 8
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = r.u64(q)
            q += 8
          }
          if (localOffset === 0xffffffff) {
            localOffset = r.u64(q)
            q += 8
          }
          break
        }
        e += 4 + sz
      }
    }

    p += 46 + nameLen + extraLen + commentLen

    if (name.endsWith('/')) continue // directory

    entries.push({
      name,
      size: uncompressedSize,
      compressedSize,
      method,
      async read() {
        if (r.u32(localOffset) !== LFH_SIG) throw new Error(`Corrupt entry: ${name}`)
        const lNameLen = r.u16(localOffset + 26)
        const lExtraLen = r.u16(localOffset + 28)
        const start = localOffset + 30 + lNameLen + lExtraLen
        const raw = r.bytes.subarray(start, start + compressedSize)

        if (method === 0) return new TextDecoder('utf-8').decode(raw)
        if (method !== 8) throw new Error(`Unsupported compression method ${method} in ${name}`)

        const ds = new DecompressionStream('deflate-raw')
        const stream = new Blob([raw]).stream().pipeThrough(ds)
        return new Response(stream).text()
      },
    })
  }

  if (!entries.length) throw new Error('Zip contains no files')
  return entries
}
