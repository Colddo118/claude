'use strict'

// 런처 본체를 GitHub 릴리스(launcher 태그, 사전 배포)에 올리는 흐름 (가짜 GitHub)

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { publishLauncher } = require('../../tools/publish-launcher')

test('런처 올리기: 릴리스를 사전 배포로 만들고, 임시 이름으로 올린 뒤 예전 파일과 바꿔 끼운다', async () => {
  const version = require('../package.json').version
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-launcher-'))
  fs.writeFileSync(path.join(tmp, `modpack-launcher-${version}-x64.nsis.7z`), 'package-bytes')
  fs.writeFileSync(path.join(tmp, 'KubejsRPG-Setup.exe'), 'stub')

  let release = null
  let assets = []
  let nextId = 100
  const calls = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      const url = new URL(req.url, 'http://x')
      calls.push(`${req.method} ${url.pathname}${url.search}`)
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)) }
      const p = url.pathname
      if (p === '/api/repos/colddo118/modpack/releases/tags/launcher') return release ? json(200, release) : json(404, { message: 'Not Found' })
      if (req.method === 'POST' && p === '/api/repos/colddo118/modpack/releases') {
        release = { id: 1, ...JSON.parse(body), upload_url: `http://${req.headers.host}/uploads/1/assets{?name,label}` }
        return json(201, release)
      }
      if (req.method === 'POST' && p === '/uploads/1/assets') {
        const a = { id: nextId++, name: url.searchParams.get('name'), size: body.length }
        assets.push(a)
        return json(201, a)
      }
      if (req.method === 'GET' && p === '/api/repos/colddo118/modpack/releases/1/assets') return json(200, assets)
      const del = p.match(/^\/api\/repos\/colddo118\/modpack\/releases\/assets\/(\d+)$/)
      if (del && req.method === 'DELETE') { assets = assets.filter(a => a.id !== Number(del[1])); return json(204) }
      if (del && req.method === 'PATCH') { const a = assets.find(x => x.id === Number(del[1])); Object.assign(a, JSON.parse(body)); return json(200, a) }
      if (req.method === 'PATCH' && p === '/api/repos/colddo118/modpack/releases/1') { Object.assign(release, JSON.parse(body)); return json(200, release) }
      json(404, { message: 'unexpected ' + p })
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  process.env.GITHUB_API_URL = `${base}/api`
  process.env.GITHUB_WEB_URL = base
  try {
    const r1 = await publishLauncher({ distDir: tmp, token: 't', verifyTries: 1 })
    assert.equal(release.prerelease, true) // releases/latest(모드팩)에 잡히면 안 됨
    assert.equal(release.make_latest, 'false')
    assert.deepEqual(assets.map(a => a.name).sort(), ['KubejsRPG-Setup.exe', 'KubejsRPG-x64.nsis.7z'])
    assert.equal(r1.version, version)
    assert.match(r1.setupUrl, /\/colddo118\/modpack\/releases\/download\/launcher\/KubejsRPG-Setup\.exe$/)

    // 다시 올리면 같은 이름의 예전 파일은 새 파일로 바뀌고, 개수는 그대로
    const oldIds = assets.map(a => a.id)
    fs.writeFileSync(path.join(tmp, `modpack-launcher-${version}-x64.nsis.7z`), 'package-bytes-v2')
    calls.length = 0
    await publishLauncher({ distDir: tmp, token: 't', verifyTries: 1 })
    assert.equal(assets.length, 2)
    assert.ok(assets.every(a => !oldIds.includes(a.id)))
    assert.equal(assets.find(a => a.name === 'KubejsRPG-x64.nsis.7z').size, 'package-bytes-v2'.length)
    // 새 파일을 올린 다음에 예전 파일을 지운다 (도중에도 받을 수 있게)
    const firstUpload = calls.findIndex(c => c.startsWith('POST /uploads'))
    const firstDelete = calls.findIndex(c => c.startsWith('DELETE'))
    assert.ok(firstUpload >= 0 && firstUpload < firstDelete)

    await assert.rejects(publishLauncher({ distDir: path.join(tmp, 'none'), token: 't', verifyTries: 1 }), /빌드 결과가 없습니다/)
  } finally {
    delete process.env.GITHUB_API_URL
    delete process.env.GITHUB_WEB_URL
    server.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
