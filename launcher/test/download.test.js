'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const crypto = require('node:crypto')
const { downloadVerified } = require('../src/main/updater')

test('다운로드: 중간에 멈춘 연결은 끊고 다시 받는다', async () => {
  const body = crypto.randomBytes(200000)
  const sha1 = crypto.createHash('sha1').update(body).digest('hex')
  let hits = 0
  const server = http.createServer((req, res) => {
    hits++
    res.writeHead(200, { 'Content-Length': body.length })
    if (hits === 1) { res.write(body.subarray(0, 1000)); return } // 첫 요청은 조금 보내고 멈춤
    res.end(body)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'))
  try {
    const dest = path.join(dir, 'f.bin')
    let bytes = 0
    await downloadVerified({ url: `http://127.0.0.1:${server.address().port}/f`, dest, sha1, size: body.length, stallMs: 300, onBytes: n => { bytes += n } })
    assert.deepEqual(fs.readFileSync(dest), body)
    assert.equal(hits, 2)
    assert.equal(bytes, body.length) // 실패한 시도에서 받은 만큼은 진행률에서 빠진다
  } finally {
    server.closeAllConnections()
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
