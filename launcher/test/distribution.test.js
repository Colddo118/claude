'use strict'

// 호스팅 없이 배포하는 구성: 모드는 커스포지 CDN, 나머지는 zip 묶음 하나(GitHub Releases 등).
// 로컬 서버로 CDN / 릴리스 / GitHub API 를 흉내 내서 전체 흐름을 확인한다.

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { build } = require('../../tools/build-manifest')
const { cdnUrl } = require('../../tools/lib/curseforge')
const { publishRelease } = require('../../tools/lib/github')
const updater = require('../src/main/updater')

let tmp, server, base
const hits = []
const api = []

function write (root, rel, content) {
  const p = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}
const read = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8')

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'launcher-dist-'))
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      // 가짜 GitHub API
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) {
        api.push({ method: req.method, path: url.pathname, query: url.search, body })
        res.writeHead(req.method === 'POST' ? 201 : 200, { 'Content-Type': 'application/json' })
        if (url.pathname === '/api/repos/me/modpack/releases') {
          return res.end(JSON.stringify({ id: 7, upload_url: `${base}/uploads/repos/me/modpack/releases/7/assets{?name,label}` }))
        }
        return res.end('{}')
      }
      // 가짜 CDN / 릴리스 파일
      hits.push(`${req.method} ${url.pathname}`)
      const file = path.join(tmp, 'www', decodeURIComponent(url.pathname))
      if (!fs.existsSync(file)) {
        res.writeHead(404)
        return res.end()
      }
      res.writeHead(200, { 'Content-Length': fs.statSync(file).size })
      if (req.method === 'HEAD') return res.end()
      fs.createReadStream(file).pipe(res)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  server.close()
  await fsp.rm(tmp, { recursive: true, force: true })
})

function instanceJson (addons) {
  return JSON.stringify({
    gameVersion: '1.21.1',
    baseModLoader: { name: 'neoforge-21.1.77' },
    installedAddons: addons.map(([fileName, id]) => ({
      fileNameOnDisk: fileName,
      installedFile: { id, fileName, downloadUrl: `${base}/cdn/files/${id}/${fileName}` }
    }))
  })
}

async function sync (manifestUrl, instance, stateFile) {
  const manifest = await updater.fetchManifest(manifestUrl)
  const state = await updater.loadState(stateFile)
  const plan = await updater.planUpdate({ manifest, instanceDir: instance, state })
  if (plan.needsUpdate) await updater.applyUpdate({ manifest, manifestUrl, instanceDir: instance, stateFile, state, plan })
  return plan
}

test('커스포지 CDN + zip 묶음 배포: 설치와 업데이트', async () => {
  const src = path.join(tmp, 'instance-src')
  const out = path.join(tmp, 'www', 'dist')
  const instance = path.join(tmp, 'user', 'instance')
  const stateFile = path.join(tmp, 'user', 'state.json')

  write(src, 'mods/jei.jar', 'jei-bytes')
  write(src, 'mods/create.jar', 'create-bytes')
  write(src, 'mods/broken.jar', 'broken-bytes') // CDN 에 없음 → 묶음으로
  write(src, 'mods/custom.jar', 'custom-bytes') // 커스포지 모드 아님 → 묶음으로
  write(src, 'config/한글설정.toml', 'a=1')
  write(src, 'options.txt', 'gamma:0.5')
  write(src, 'minecraftinstance.json', instanceJson([['jei.jar', 1001], ['create.jar', 1002], ['broken.jar', 1003]]))
  write(src, 'pack.config.json', JSON.stringify({ packName: '테스트팩', bundleUrl: `${base}/dist/pack-{version}.zip` }))
  write(path.join(tmp, 'www'), 'cdn/files/1001/jei.jar', 'jei-bytes')
  write(path.join(tmp, 'www'), 'cdn/files/1002/create.jar', 'create-bytes')

  const r1 = await build({ source: src, out, version: '1.0.0', notes: '- 첫 배포' })
  assert.equal(r1.mode, 'bundle')
  assert.equal(r1.cdnCount, 2)
  assert.deepEqual(r1.cdnFailed, ['mods/broken.jar'])
  assert.deepEqual(fs.readdirSync(out).sort(), ['manifest.json', 'pack-1.0.0.zip'])
  const byPath = Object.fromEntries(r1.manifest.files.map(f => [f.path, f]))
  assert.equal(byPath['mods/jei.jar'].url, `${base}/cdn/files/1001/jei.jar`)
  assert.equal(byPath['mods/broken.jar'].url, undefined)
  assert.equal(r1.manifest.bundle.url, `${base}/dist/pack-1.0.0.zip`)

  hits.length = 0
  await sync(`${base}/dist/manifest.json`, instance, stateFile)
  assert.equal(read(instance, 'mods/jei.jar'), 'jei-bytes')
  assert.equal(read(instance, 'mods/broken.jar'), 'broken-bytes')
  assert.equal(read(instance, 'mods/custom.jar'), 'custom-bytes')
  assert.equal(read(instance, 'config/한글설정.toml'), 'a=1')
  assert.equal(read(instance, 'options.txt'), 'gamma:0.5')
  assert.ok(hits.includes('GET /cdn/files/1001/jei.jar'))
  assert.equal(hits.filter(h => h === 'GET /dist/pack-1.0.0.zip').length, 1)
  assert.ok(!fs.existsSync(path.join(instance, '.launcher-tmp')))

  // v1.1.0: 설정 파일만 바뀜 → CDN 은 안 건드리고 묶음만 받는다
  write(instance, 'options.txt', 'gamma:1.0') // 유저 설정
  write(src, 'config/한글설정.toml', 'a=2')
  await build({ source: src, out, version: '1.1.0', notes: '- 설정 변경' })
  const manifest = await updater.fetchManifest(`${base}/dist/manifest.json`)
  const plan = await updater.planUpdate({ manifest, instanceDir: instance, state: await updater.loadState(stateFile) })
  assert.deepEqual(plan.downloads.map(f => f.path), ['config/한글설정.toml'])
  assert.equal(plan.downloadBytes, manifest.bundle.size)

  hits.length = 0
  await sync(`${base}/dist/manifest.json`, instance, stateFile)
  assert.equal(read(instance, 'config/한글설정.toml'), 'a=2')
  assert.equal(read(instance, 'options.txt'), 'gamma:1.0')
  // 매니페스트 + 묶음 zip 두 번만 요청하고 CDN 은 건드리지 않는다
  assert.deepEqual(hits, ['GET /dist/manifest.json', 'GET /dist/pack-1.1.0.zip'])

  // CDN 파일이 매니페스트와 다르면 거부
  write(path.join(tmp, 'www'), 'cdn/files/1001/jei.jar', 'jei-TAMPERED')
  fs.rmSync(path.join(instance, 'mods', 'jei.jar'))
  await assert.rejects(sync(`${base}/dist/manifest.json`, instance, stateFile), /jei\.jar 다운로드 실패/)
})

test('GitHub 릴리스 자동 게시: 초안 → 파일 첨부 → 공개 순서', async () => {
  process.env.GITHUB_API_URL = `${base}/api`
  const zip = path.join(tmp, 'pack-2.0.0.zip')
  const man = path.join(tmp, 'manifest.json')
  write(tmp, 'pack-2.0.0.zip', 'zip')
  write(tmp, 'manifest.json', '{}')
  api.length = 0
  await publishRelease({ repo: 'me/modpack', token: 't', version: '2.0.0', notes: '- 노트', files: [zip, man] })
  assert.deepEqual(api.map(a => `${a.method} ${a.path}${a.query}`), [
    'POST /api/repos/me/modpack/releases',
    'POST /uploads/repos/me/modpack/releases/7/assets?name=pack-2.0.0.zip',
    'POST /uploads/repos/me/modpack/releases/7/assets?name=manifest.json',
    'PATCH /api/repos/me/modpack/releases/7'
  ])
  assert.deepEqual(JSON.parse(api[0].body), { tag_name: 'pack-2.0.0', name: '모드팩 v2.0.0', body: '- 노트', draft: true })
  assert.deepEqual(JSON.parse(api[3].body), { draft: false, make_latest: 'true' })
  await assert.rejects(publishRelease({ repo: 'me/modpack', version: '2.0.0', files: [] }), /GITHUB_TOKEN/)
  delete process.env.GITHUB_API_URL
})

test('커스포지 CDN 주소 만들기', () => {
  assert.equal(cdnUrl({ id: 5846880, fileName: 'jei-1.21.1.jar' }), 'https://edge.forgecdn.net/files/5846/880/jei-1.21.1.jar')
  assert.equal(cdnUrl({ id: 5846007, fileName: 'a b.jar' }), 'https://edge.forgecdn.net/files/5846/7/a%20b.jar')
  assert.equal(cdnUrl({ id: 1, fileName: 'x.jar', downloadUrl: 'https://edge.forgecdn.net/files/0/1/x.jar' }), 'https://edge.forgecdn.net/files/0/1/x.jar')
})
