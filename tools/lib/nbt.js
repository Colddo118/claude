'use strict'

// 마인크래프트 NBT 읽기 · 쓰기 (맵 초기화가 level.dat · playerdata · kubejs_persistent_data.nbt 를 고칠 때 쓴다).
//   태그 = { type, value } — 읽은 그대로 다시 쓰면 바이트가 같아야 한다(형식을 바꾸지 않는다).
//   compound = Map(이름 → 태그, 순서 유지) · list = { elem, items: [태그] } · long = BigInt · 배열 = 일반 배열
//   문자열은 자바 '변형 UTF-8'(널 = C0 80, 보조 문자 = 서로게이트 두 개를 3바이트씩)

const zlib = require('node:zlib')

const T = { END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6, BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12 }

function decodeMutf8 (buf, start, end) {
  let s = ''
  let i = start
  while (i < end) {
    const a = buf[i]
    if (a < 0x80) { s += String.fromCharCode(a); i += 1 } else if ((a & 0xE0) === 0xC0) {
      s += String.fromCharCode(((a & 0x1F) << 6) | (buf[i + 1] & 0x3F)); i += 2
    } else {
      s += String.fromCharCode(((a & 0x0F) << 12) | ((buf[i + 1] & 0x3F) << 6) | (buf[i + 2] & 0x3F)); i += 3
    }
  }
  return s
}

function encodeMutf8 (str) {
  const out = []
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    if (c >= 1 && c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F))
    else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F))
  }
  if (out.length > 65535) throw new Error('NBT 문자열이 너무 깁니다')
  return Buffer.from(out)
}

class Reader {
  constructor (buf) { this.b = buf; this.o = 0 }
  u8 () { return this.b[this.o++] }
  i8 () { const v = this.b.readInt8(this.o); this.o += 1; return v }
  i16 () { const v = this.b.readInt16BE(this.o); this.o += 2; return v }
  u16 () { const v = this.b.readUInt16BE(this.o); this.o += 2; return v }
  i32 () { const v = this.b.readInt32BE(this.o); this.o += 4; return v }
  i64 () { const v = this.b.readBigInt64BE(this.o); this.o += 8; return v }
  f32 () { const v = this.b.readFloatBE(this.o); this.o += 4; return v }
  f64 () { const v = this.b.readDoubleBE(this.o); this.o += 8; return v }
  str () { const n = this.u16(); const s = decodeMutf8(this.b, this.o, this.o + n); this.o += n; return s }
  payload (type) {
    switch (type) {
      case T.BYTE: return this.i8()
      case T.SHORT: return this.i16()
      case T.INT: return this.i32()
      case T.LONG: return this.i64()
      case T.FLOAT: return this.f32()
      case T.DOUBLE: return this.f64()
      case T.BYTE_ARRAY: { const n = this.i32(); const a = []; for (let i = 0; i < n; i++) a.push(this.i8()); return a }
      case T.STRING: return this.str()
      case T.LIST: {
        const elem = this.u8(); const n = this.i32(); const items = []
        for (let i = 0; i < n; i++) items.push({ type: elem, value: this.payload(elem) })
        return { elem, items }
      }
      case T.COMPOUND: {
        const m = new Map()
        for (;;) {
          const t = this.u8()
          if (t === T.END) return m
          const name = this.str()
          m.set(name, { type: t, value: this.payload(t) })
        }
      }
      case T.INT_ARRAY: { const n = this.i32(); const a = []; for (let i = 0; i < n; i++) a.push(this.i32()); return a }
      case T.LONG_ARRAY: { const n = this.i32(); const a = []; for (let i = 0; i < n; i++) a.push(this.i64()); return a }
      default: throw new Error(`알 수 없는 NBT 태그 종류 ${type} (위치 ${this.o})`)
    }
  }
}

class Writer {
  constructor () { this.parts = [] }
  push (buf) { this.parts.push(buf) }
  num (fn, size, v) { const b = Buffer.alloc(size); b[fn](v, 0); this.push(b) }
  str (s) { const e = encodeMutf8(s); this.num('writeUInt16BE', 2, e.length); this.push(e) }
  payload (type, v) {
    switch (type) {
      case T.BYTE: return this.num('writeInt8', 1, v)
      case T.SHORT: return this.num('writeInt16BE', 2, v)
      case T.INT: return this.num('writeInt32BE', 4, v)
      case T.LONG: return this.num('writeBigInt64BE', 8, BigInt(v))
      case T.FLOAT: return this.num('writeFloatBE', 4, v)
      case T.DOUBLE: return this.num('writeDoubleBE', 8, v)
      case T.BYTE_ARRAY: { this.num('writeInt32BE', 4, v.length); const b = Buffer.alloc(v.length); v.forEach((x, i) => b.writeInt8(x, i)); return this.push(b) }
      case T.STRING: return this.str(v)
      case T.LIST: {
        const elem = v.items.length ? v.items[0].type : v.elem
        this.push(Buffer.from([elem])); this.num('writeInt32BE', 4, v.items.length)
        for (const it of v.items) this.payload(elem, it.value)
        return
      }
      case T.COMPOUND:
        for (const [name, tag] of v) { this.push(Buffer.from([tag.type])); this.str(name); this.payload(tag.type, tag.value) }
        return this.push(Buffer.from([T.END]))
      case T.INT_ARRAY: { this.num('writeInt32BE', 4, v.length); const b = Buffer.alloc(v.length * 4); v.forEach((x, i) => b.writeInt32BE(x, i * 4)); return this.push(b) }
      case T.LONG_ARRAY: { this.num('writeInt32BE', 4, v.length); const b = Buffer.alloc(v.length * 8); v.forEach((x, i) => b.writeBigInt64BE(BigInt(x), i * 8)); return this.push(b) }
      default: throw new Error(`알 수 없는 NBT 태그 종류 ${type}`)
    }
  }
}

// 이름 있는 루트 태그 하나 (보통 이름 '' 인 compound)
function parse (buf) {
  const r = new Reader(buf)
  const type = r.u8()
  const name = r.str()
  return { name, type, value: r.payload(type) }
}

function serialize (root) {
  const w = new Writer()
  w.push(Buffer.from([root.type])); w.str(root.name); w.payload(root.type, root.value)
  return Buffer.concat(w.parts)
}

const isGzip = buf => buf.length > 2 && buf[0] === 0x1F && buf[1] === 0x8B
function readFile (buf) { return parse(isGzip(buf) ? zlib.gunzipSync(buf) : buf) }
function writeFile (root) { return zlib.gzipSync(serialize(root)) }

// compound 안 경로 따라가기 — get(tag, 'Data', 'DragonFight') → 태그 또는 null
function get (tag, ...keys) {
  let cur = tag
  for (const k of keys) {
    if (!cur || cur.type !== T.COMPOUND) return null
    cur = cur.value.get(k) || null
  }
  return cur
}

module.exports = { T, parse, serialize, readFile, writeFile, get, isGzip }
