'use strict'

// 마인크래프트 멀티플레이 서버 목록(servers.dat, 압축 없는 NBT)을 읽고 써서
// 우리 서버가 항상 목록에 있게 한다. 사용자가 추가한 다른 서버와 순서는 그대로 둔다.

const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const zlib = require('node:zlib')

const T = { END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6, BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12 }

// ---------------------------------------------------------------- NBT (자바의 modified UTF-8 포함)

function encodeString (str) {
  const bytes = []
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    if (c !== 0 && c < 0x80) bytes.push(c)
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
  }
  const len = Buffer.alloc(2)
  len.writeUInt16BE(bytes.length)
  return Buffer.concat([len, Buffer.from(bytes)])
}

function decodeString (buf) {
  let out = ''
  for (let i = 0; i < buf.length;) {
    const a = buf[i++]
    if (a < 0x80) out += String.fromCharCode(a)
    else if ((a & 0xe0) === 0xc0) out += String.fromCharCode(((a & 0x1f) << 6) | (buf[i++] & 0x3f))
    else out += String.fromCharCode(((a & 0x0f) << 12) | ((buf[i++] & 0x3f) << 6) | (buf[i++] & 0x3f))
  }
  return out
}

// 태그 = { t: 종류, v: 값 } · 목록 v = { et: 원소 종류, items: [값] } · 묶음 v = Map(이름 → 태그)
function readNbt (buf) {
  let o = 0
  const str = () => { const n = buf.readUInt16BE(o); o += 2; const s = decodeString(buf.subarray(o, o + n)); o += n; return s }
  const payload = t => {
    switch (t) {
      case T.BYTE: return buf.readInt8(o++)
      case T.SHORT: { const v = buf.readInt16BE(o); o += 2; return v }
      case T.INT: { const v = buf.readInt32BE(o); o += 4; return v }
      case T.LONG: { const v = buf.readBigInt64BE(o); o += 8; return v }
      case T.FLOAT: { const v = buf.readFloatBE(o); o += 4; return v }
      case T.DOUBLE: { const v = buf.readDoubleBE(o); o += 8; return v }
      case T.BYTE_ARRAY: { const n = buf.readInt32BE(o); o += 4; const v = Buffer.from(buf.subarray(o, o + n)); o += n; return v }
      case T.STRING: return str()
      case T.LIST: {
        const et = buf.readInt8(o++)
        const n = buf.readInt32BE(o); o += 4
        const items = []
        for (let i = 0; i < n; i++) items.push(payload(et))
        return { et, items }
      }
      case T.COMPOUND: {
        const m = new Map()
        for (;;) {
          const ct = buf.readInt8(o++)
          if (ct === T.END) return m
          const name = str()
          m.set(name, { t: ct, v: payload(ct) })
        }
      }
      case T.INT_ARRAY: { const n = buf.readInt32BE(o); o += 4; const v = []; for (let i = 0; i < n; i++, o += 4) v.push(buf.readInt32BE(o)); return v }
      case T.LONG_ARRAY: { const n = buf.readInt32BE(o); o += 4; const v = []; for (let i = 0; i < n; i++, o += 8) v.push(buf.readBigInt64BE(o)); return v }
      default: throw new Error(`알 수 없는 NBT 태그 ${t}`)
    }
  }
  const t = buf.readInt8(o++)
  if (t !== T.COMPOUND) throw new Error('NBT 루트가 묶음(compound)이 아닙니다')
  const name = str()
  return { name, root: payload(T.COMPOUND) }
}

function writeNbt ({ name = '', root }) {
  const parts = []
  const num = (fn, size, v) => { const b = Buffer.alloc(size); b[fn](v); parts.push(b) }
  const payload = (t, v) => {
    switch (t) {
      case T.BYTE: return num('writeInt8', 1, v)
      case T.SHORT: return num('writeInt16BE', 2, v)
      case T.INT: return num('writeInt32BE', 4, v)
      case T.LONG: return num('writeBigInt64BE', 8, v)
      case T.FLOAT: return num('writeFloatBE', 4, v)
      case T.DOUBLE: return num('writeDoubleBE', 8, v)
      case T.BYTE_ARRAY: num('writeInt32BE', 4, v.length); parts.push(Buffer.from(v)); return
      case T.STRING: parts.push(encodeString(v)); return
      case T.LIST: num('writeInt8', 1, v.items.length ? v.et : T.END); num('writeInt32BE', 4, v.items.length); for (const x of v.items) payload(v.et, x); return
      case T.COMPOUND:
        for (const [k, tag] of v) { num('writeInt8', 1, tag.t); parts.push(encodeString(k)); payload(tag.t, tag.v) }
        num('writeInt8', 1, T.END)
        return
      case T.INT_ARRAY: num('writeInt32BE', 4, v.length); for (const x of v) num('writeInt32BE', 4, x); return
      case T.LONG_ARRAY: num('writeInt32BE', 4, v.length); for (const x of v) num('writeBigInt64BE', 8, x); return
      default: throw new Error(`알 수 없는 NBT 태그 ${t}`)
    }
  }
  num('writeInt8', 1, T.COMPOUND)
  parts.push(encodeString(name))
  payload(T.COMPOUND, root)
  return Buffer.concat(parts)
}

// ---------------------------------------------------------------- 서버 목록

// "Host:25565" 와 "host" 는 같은 서버
const sameAddress = (a, b) => {
  const norm = s => String(s || '').trim().toLowerCase().replace(/:25565$/, '')
  return norm(a) === norm(b)
}

function listServers (nbt) {
  const tag = nbt.root.get('servers')
  if (!tag || tag.t !== T.LIST || !tag.v.items.length) return []
  return tag.v.items.map(m => ({ name: m.get('name') && m.get('name').v, ip: m.get('ip') && m.get('ip').v }))
}

/**
 * 서버 목록에 { name, address } 가 없으면 맨 위에 추가한다. 이미 있으면 아무것도 안 바꾼다.
 * 파일을 못 읽으면(깨짐) 원래 파일을 .launcher-bak 으로 남기고 새로 만든다.
 * @returns {Promise<'added'|'exists'|'created'>}
 */
async function ensureServer (instanceDir, { name, address }) {
  const file = path.join(instanceDir, 'servers.dat')
  let nbt = null
  let result = 'created'
  if (fs.existsSync(file)) {
    try {
      let buf = await fsp.readFile(file)
      if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf)
      nbt = readNbt(buf)
      result = 'added'
    } catch {
      await fsp.copyFile(file, file + '.launcher-bak')
    }
  }
  if (!nbt) nbt = { name: '', root: new Map() }
  let tag = nbt.root.get('servers')
  if (!tag || tag.t !== T.LIST || (tag.v.items.length && tag.v.et !== T.COMPOUND)) {
    tag = { t: T.LIST, v: { et: T.COMPOUND, items: [] } }
    nbt.root.set('servers', tag)
  }
  tag.v.et = T.COMPOUND
  if (tag.v.items.some(m => m.get('ip') && sameAddress(m.get('ip').v, address))) return 'exists'

  const entry = new Map([
    ['ip', { t: T.STRING, v: address }],
    ['name', { t: T.STRING, v: name }],
    ['hidden', { t: T.BYTE, v: 0 }]
  ])
  tag.v.items.unshift(entry)
  await fsp.mkdir(instanceDir, { recursive: true })
  const tmp = file + '.tmp'
  await fsp.writeFile(tmp, writeNbt(nbt))
  await fsp.rename(tmp, file)
  return result
}

module.exports = { ensureServer, listServers, readNbt, writeNbt, T }
