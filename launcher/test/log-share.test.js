'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { buildReport, uploadReport, sanitize } = require('../src/main/log-share')

test('로그 공유: 최근 크래시 리포트 + 게임 로그를 묶고, 사용자 이름·토큰은 가린다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logshare-'))
  try {
    fs.mkdirSync(path.join(dir, 'crash-reports'))
    fs.mkdirSync(path.join(dir, 'logs'))
    const old = path.join(dir, 'crash-reports', 'crash-old.txt')
    fs.writeFileSync(old, 'old crash')
    fs.utimesSync(old, new Date('2020-01-01'), new Date('2020-01-01'))
    fs.writeFileSync(path.join(dir, 'crash-reports', 'crash-new.txt'), '---- Minecraft Crash Report ----\nDescription: Ticking entity')
    fs.writeFileSync(path.join(dir, 'logs', 'latest.log'), 'line1\nC:\\Users\\ColdDo\\AppData\\Roaming\\x --accessToken abc.def\nline3')

    const r = await buildReport({ instanceDir: dir, since: Date.now() - 60000, info: { appName: 'KubejsRPG', launcherVersion: '0.3.0', packVersion: '1.0.3', memoryMB: 8192 } })
    assert.equal(r.crashReport, 'crash-new.txt') // 이번 실행 전의 오래된 리포트는 안 씀
    assert.match(r.text, /런처 v0\.3\.0 · 모드팩 v1\.0\.3/)
    assert.match(r.text, /Ticking entity/)
    assert.doesNotMatch(r.text, /old crash/)

    const s = sanitize('C:\\Users\\ColdDo\\AppData --accessToken eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4 C:/Users/ColdDo/x', { home: 'C:\\Users\\ColdDo', user: 'ColdDo' })
    assert.doesNotMatch(s, /ColdDo|eyJhbGci/)
    assert.match(s, /%USERPROFILE%\\AppData/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('로그 공유: mclo.gs 에 올리고 링크를 돌려준다', async () => {
  let sent
  const fetchImpl = async (url, opts) => {
    sent = { url, body: new URLSearchParams(opts.body).get('content') }
    return { ok: true, status: 200, json: async () => ({ success: true, id: 'abc123', url: 'https://mclo.gs/abc123' }) }
  }
  assert.equal(await uploadReport('hello log', { fetchImpl }), 'https://mclo.gs/abc123')
  assert.equal(sent.url, 'https://api.mclo.gs/1/log')
  assert.equal(sent.body, 'hello log')
  const failing = async () => ({ ok: false, status: 400, json: async () => ({ success: false, error: 'Required POST argument content is empty.' }) })
  await assert.rejects(uploadReport('', { fetchImpl: failing }), /empty/)
})
