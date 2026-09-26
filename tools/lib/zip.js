'use strict'

// 외부 패키지 없이 쓰는 최소 zip 작성기 (deflate, UTF-8 파일명). 모드팩 설정 묶음 정도의 크기를 가정한다.

const fs = require('node:fs')
const fsp = fs.promises
const zlib = require('node:zlib')

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32 (buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const UTF8_FLAG = 0x0800
const DOS_TIME = 0 // 00:00:00
const DOS_DATE = (0 << 9) | (1 << 5) | 1 // 1980-01-01, 같은 입력이면 같은 zip 이 나오도록 고정

/**
 * entries: [{ name: 'config/a.toml', file: '/abs/path' }]
 */
async function writeZip (outFile, entries) {
  const out = await fsp.open(outFile, 'w')
  const central = []
  let offset = 0
  try {
    for (const { name, file } of entries) {
      const data = await fsp.readFile(file)
      const compressed = zlib.deflateRawSync(data)
      const useDeflate = compressed.length < data.length
      const body = useDeflate ? compressed : data
      const nameBuf = Buffer.from(name, 'utf8')
      const crc = crc32(data)
      if (data.length > 0xfffffffe || offset > 0xfffffffe) throw new Error('4GB 이상의 묶음은 지원하지 않습니다')

      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(20, 4)
      local.writeUInt16LE(UTF8_FLAG, 6)
      local.writeUInt16LE(useDeflate ? 8 : 0, 8)
      local.writeUInt16LE(DOS_TIME, 10)
      local.writeUInt16LE(DOS_DATE, 12)
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(body.length, 18)
      local.writeUInt32LE(data.length, 22)
      local.writeUInt16LE(nameBuf.length, 26)
      local.writeUInt16LE(0, 28)
      await out.write(local)
      await out.write(nameBuf)
      await out.write(body)

      const cen = Buffer.alloc(46)
      cen.writeUInt32LE(0x02014b50, 0)
      cen.writeUInt16LE(20, 4)
      cen.writeUInt16LE(20, 6)
      cen.writeUInt16LE(UTF8_FLAG, 8)
      cen.writeUInt16LE(useDeflate ? 8 : 0, 10)
      cen.writeUInt16LE(DOS_TIME, 12)
      cen.writeUInt16LE(DOS_DATE, 14)
      cen.writeUInt32LE(crc, 16)
      cen.writeUInt32LE(body.length, 20)
      cen.writeUInt32LE(data.length, 24)
      cen.writeUInt16LE(nameBuf.length, 28)
      cen.writeUInt32LE(offset, 42)
      central.push(cen, nameBuf)
      offset += local.length + nameBuf.length + body.length
    }
    if (entries.length > 0xffff) throw new Error('파일이 너무 많습니다 (65535개 초과)')
    const cenBuf = Buffer.concat(central)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(entries.length, 8)
    end.writeUInt16LE(entries.length, 10)
    end.writeUInt32LE(cenBuf.length, 12)
    end.writeUInt32LE(offset, 16)
    await out.write(cenBuf)
    await out.write(end)
  } finally {
    await out.close()
  }
}

module.exports = { writeZip, crc32 }
