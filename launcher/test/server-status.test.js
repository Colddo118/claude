'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const { pingServer, varInt, readVarInt, plainText } = require('../src/main/server-status')

// 가짜 마인크래프트 서버: 핸드셰이크 + 상태 요청을 받으면 상태 JSON 을 돌려준다
function fakeServer (status, { split = false } = {}) {
  const server = net.createServer(sock => {
    let buf = Buffer.alloc(0)
    sock.on('data', d => {
      buf = Buffer.concat([buf, d])
      // 패킷 두 개(핸드셰이크, 상태 요청)를 다 받으면 응답
      let o = 0; let n = 0
      for (;;) {
        const len = readVarInt(buf, o)
        if (!len || buf.length < o + len.size + len.value) break
        o += len.size + len.value; n++
      }
      if (n < 2) return
      const json = Buffer.from(JSON.stringify(status), 'utf8')
      const body = Buffer.concat([varInt(0), varInt(json.length), json])
      const pkt = Buffer.concat([varInt(body.length), body])
      if (split) { sock.write(pkt.subarray(0, 5)); setTimeout(() => sock.write(pkt.subarray(5)), 20) } else sock.write(pkt)
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)))
}

test('서버 상태: 켜져 있으면 접속 인원 · 버전 · MOTD', async () => {
  const server = await fakeServer({
    version: { name: 'NeoForge 1.21.1', protocol: 767 },
    players: { max: 20, online: 3 },
    description: { text: '§6KubejsRPG ', extra: [{ text: '서버' }] }
  }, { split: true })
  try {
    const r = await pingServer({ address: '127.0.0.1', port: server.address().port })
    assert.equal(r.online, true)
    assert.deepEqual(r.players, { online: 3, max: 20 })
    assert.equal(r.version, 'NeoForge 1.21.1')
    assert.equal(r.motd, 'KubejsRPG 서버')
  } finally {
    server.close()
  }
})

test('서버 상태: 꺼져 있거나 응답이 없으면 꺼짐', async () => {
  const closed = await fakeServer({})
  const port = closed.address().port
  await new Promise(resolve => closed.close(resolve))
  const off = await pingServer({ address: '127.0.0.1', port })
  assert.equal(off.online, false)

  const silent = net.createServer(() => {}) // 연결은 받지만 아무 말도 안 함
  await new Promise(resolve => silent.listen(0, '127.0.0.1', resolve))
  try {
    const r = await pingServer({ address: '127.0.0.1', port: silent.address().port }, { timeout: 300 })
    assert.deepEqual(r, { online: false, error: '응답 없음' })
  } finally {
    silent.close()
  }
})

test('VarInt 와 MOTD 글자', () => {
  for (const n of [0, 1, 127, 128, 25565, 2147483647, -1]) {
    const b = varInt(n)
    assert.equal(readVarInt(b, 0).value, n)
  }
  assert.equal(readVarInt(Buffer.from([0x80]), 0), null) // 아직 덜 옴
  assert.equal(plainText('§aHello'), 'Hello')
})
