'use strict'

// 마인크래프트 서버 목록 핑(Server List Ping)으로 서버가 켜져 있는지, 몇 명이 접속해 있는지 확인한다.
// 게임의 멀티플레이 목록이 하는 것과 같은 방식이라 서버에 아무것도 설치할 필요가 없다.

const net = require('node:net')
const dns = require('node:dns').promises

function varInt (n) {
  const out = []
  let v = n >>> 0
  do {
    let b = v & 0x7f
    v >>>= 7
    if (v) b |= 0x80
    out.push(b)
  } while (v)
  return Buffer.from(out)
}

function packet (id, ...fields) {
  const body = Buffer.concat([varInt(id), ...fields])
  return Buffer.concat([varInt(body.length), body])
}

function mcString (s) {
  const b = Buffer.from(s, 'utf8')
  return Buffer.concat([varInt(b.length), b])
}

// buf[offset] 부터 VarInt 하나. 아직 덜 왔으면 null
function readVarInt (buf, offset) {
  let value = 0
  for (let i = 0; i < 5; i++) {
    if (offset + i >= buf.length) return null
    const b = buf[offset + i]
    value |= (b & 0x7f) << (7 * i)
    if (!(b & 0x80)) return { value, size: i + 1 }
  }
  throw new Error('잘못된 VarInt')
}

// 포트를 안 적은 주소는 SRV 레코드(_minecraft._tcp)를 먼저 본다 (게임과 같은 순서)
async function resolveTarget (address, port) {
  if (port) return { host: address, port }
  try {
    const [srv] = await dns.resolveSrv(`_minecraft._tcp.${address}`)
    if (srv) return { host: srv.name, port: srv.port }
  } catch {}
  return { host: address, port: 25565 }
}

// MOTD(description) 는 글자이거나 { text, extra: [...] } 형태
function plainText (d) {
  if (d == null) return ''
  if (typeof d === 'string') return d.replace(/§./g, '')
  return (plainText(d.text) + (Array.isArray(d.extra) ? d.extra.map(plainText).join('') : '')).replace(/§./g, '')
}

/**
 * @returns {Promise<{online: true, players: {online, max}, version, motd, latencyMs} | {online: false, error}>}
 */
async function pingServer ({ address, port }, { timeout = 5000 } = {}) {
  let target
  try {
    target = await resolveTarget(address, port)
  } catch (e) {
    return { online: false, error: e.message }
  }
  return new Promise(resolve => {
    const started = Date.now()
    const socket = net.createConnection({ host: target.host, port: target.port })
    let buf = Buffer.alloc(0)
    let done = false
    const finish = r => { if (done) return; done = true; socket.destroy(); resolve(r) }
    socket.setTimeout(timeout, () => finish({ online: false, error: '응답 없음' }))
    socket.on('error', e => finish({ online: false, error: e.code || e.message }))
    socket.on('close', () => finish({ online: false, error: '연결이 끊김' }))
    socket.on('connect', () => {
      const portBuf = Buffer.alloc(2)
      portBuf.writeUInt16BE(target.port)
      // 핸드셰이크(프로토콜 -1 = 상태 확인만) → 상태 요청
      socket.write(packet(0x00, varInt(-1), mcString(address), portBuf, varInt(1)))
      socket.write(packet(0x00))
    })
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk])
      try {
        const len = readVarInt(buf, 0)
        if (!len || buf.length < len.size + len.value) return
        let o = len.size
        const id = readVarInt(buf, o); o += id.size
        const strLen = readVarInt(buf, o); o += strLen.size
        const json = JSON.parse(buf.subarray(o, o + strLen.value).toString('utf8'))
        finish({
          online: true,
          players: { online: (json.players && json.players.online) || 0, max: (json.players && json.players.max) || 0 },
          version: json.version && json.version.name,
          motd: plainText(json.description),
          latencyMs: Date.now() - started
        })
      } catch (e) {
        finish({ online: false, error: e.message })
      }
    })
  })
}

module.exports = { pingServer, varInt, readVarInt, plainText }
