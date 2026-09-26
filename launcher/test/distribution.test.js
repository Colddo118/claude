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

// 빌드 결과를 가짜 GitHub 에 "업로드" 한다 (릴리스 파일 + latest/download/manifest.json)
function publishLocally (r) {
  const tag = `pack-${r.manifest.version}`
  const relDir = path.join(tmp, 'www', 'me', 'modpack', 'releases', 'download', tag)
  fs.mkdirSync(relDir, { recursive: true })
  for (const f of r.newAssets) fs.copyFileSync(f, path.join(relDir, path.basename(f)))
  write(path.join(tmp, 'www'), 'me/modpack/releases/latest/download/manifest.json', fs.readFileSync(r.manifestFile))
  return r.newAssets.map(f => path.basename(f)).sort()
}

test('커스포지 CDN + GitHub 릴리스 배포: 설치, 부분 업데이트, 이전 릴리스 재사용', async () => {
  process.env.GITHUB_WEB_URL = base
  const src = path.join(tmp, 'instance-src')
  const out = path.join(tmp, 'pack-dist')
  const instance = path.join(tmp, 'user', 'instance')
  const stateFile = path.join(tmp, 'user', 'state.json')
  const manifestUrl = `${base}/me/modpack/releases/latest/download/manifest.json`

  write(src, 'mods/jei.jar', 'jei-bytes')
  write(src, 'mods/create.jar', 'create-bytes')
  write(src, 'mods/broken.jar', 'broken-bytes') // CDN 에 없음 → 직접 올림
  write(src, 'mods/custom.jar', 'custom-bytes') // 커스포지 모드 아님 → 직접 올림
  write(src, 'mods/big-custom.jar', Buffer.alloc(5000, 7)) // 큰 파일 → 릴리스에 파일째
  write(src, 'config/한글설정.toml', 'a=1')
  write(src, 'kubejs/startup_scripts/main.js', 'console.log(1)')
  write(src, 'kubejs/assets/rpg/textures/sword.png', 'png-bytes')
  write(src, 'options.txt', 'gamma:0.5')
  write(src, 'minecraftinstance.json', instanceJson([['jei.jar', 1001], ['create.jar', 1002], ['broken.jar', 1003]]))
  // 테스트용으로 기준 크기를 아주 작게: 1KB 이상은 큰 파일, 묶음은 폴더마다 따로
  write(src, 'pack.config.json', JSON.stringify({ packName: '테스트팩', github: 'me/modpack', largeFileMB: 1 / 1024, bundleSizeMB: 1 / 1024 / 1024 * 20 }))
  write(path.join(tmp, 'www'), 'cdn/files/1001/jei.jar', 'jei-bytes')
  write(path.join(tmp, 'www'), 'cdn/files/1002/create.jar', 'create-bytes')

  // 업로드 안 한 채로 같은 버전을 --force 로 다시 빌드해도, 없는 파일을 "재사용" 하면 안 된다
  const r0 = await build({ source: src, out, version: '1.0.0', notes: '- 첫 배포' })
  const r1 = await build({ source: src, out, version: '1.0.0', notes: '- 첫 배포', force: true })
  assert.equal(r1.reused, 0)
  assert.deepEqual(r1.newAssets.map(f => path.basename(f)).sort(), r0.newAssets.map(f => path.basename(f)).sort())
  assert.equal(r1.mode, 'github')
  assert.equal(r1.cdnCount, 2)
  assert.deepEqual(r1.cdnFailed, ['mods/broken.jar'])
  const byPath = Object.fromEntries(r1.manifest.files.map(f => [f.path, f]))
  assert.equal(byPath['mods/jei.jar'].url, `${base}/cdn/files/1001/jei.jar`)
  assert.match(byPath['mods/big-custom.jar'].url, /\/me\/modpack\/releases\/download\/pack-1\.0\.0\/f-[0-9a-f]{40}$/)
  assert.ok(byPath['config/한글설정.toml'].bundle)
  assert.notEqual(byPath['config/한글설정.toml'].bundle, byPath['kubejs/startup_scripts/main.js'].bundle) // 폴더마다 다른 묶음
  const assets1 = publishLocally(r1)
  assert.ok(assets1.includes('manifest.json'))
  assert.equal(r1.reused, 0)

  hits.length = 0
  await sync(manifestUrl, instance, stateFile)
  for (const [p, v] of [['mods/jei.jar', 'jei-bytes'], ['mods/broken.jar', 'broken-bytes'], ['mods/custom.jar', 'custom-bytes'],
    ['config/한글설정.toml', 'a=1'], ['kubejs/assets/rpg/textures/sword.png', 'png-bytes'], ['options.txt', 'gamma:0.5']]) {
    assert.equal(read(instance, p), v, p)
  }
  assert.equal(fs.readFileSync(path.join(instance, 'mods', 'big-custom.jar')).length, 5000)
  assert.ok(hits.includes('GET /cdn/files/1001/jei.jar'))
  assert.ok(!fs.existsSync(path.join(instance, '.launcher-tmp')))

  // v1.1.0: 설정 파일 하나만 바뀜 → 그 폴더 묶음 하나만 새로 올리고, 유저도 그것만 받는다
  write(instance, 'options.txt', 'gamma:1.0') // 유저 설정
  write(src, 'config/한글설정.toml', 'a=2')
  const r2 = await build({ source: src, out, version: '1.1.0', notes: '- 설정 변경' })
  const assets2 = publishLocally(r2)
  assert.equal(assets2.length, 2) // 새 config 묶음 + manifest.json
  assert.ok(r2.reused >= 3) // 큰 파일, kubejs 묶음들, mods 묶음 등은 1.0.0 릴리스 것을 재사용
  const reusedBig = r2.manifest.files.find(f => f.path === 'mods/big-custom.jar').url
  assert.match(reusedBig, /pack-1\.0\.0/)

  const manifest = await updater.fetchManifest(manifestUrl)
  const plan = await updater.planUpdate({ manifest, instanceDir: instance, state: await updater.loadState(stateFile) })
  assert.deepEqual(plan.downloads.map(f => f.path), ['config/한글설정.toml'])
  const configBundle = manifest.bundles.find(b => b.id === plan.downloads[0].bundle)
  assert.equal(plan.downloadBytes, configBundle.size)

  hits.length = 0
  await sync(manifestUrl, instance, stateFile)
  assert.equal(read(instance, 'config/한글설정.toml'), 'a=2')
  assert.equal(read(instance, 'options.txt'), 'gamma:1.0')
  assert.deepEqual(hits, [
    'GET /me/modpack/releases/latest/download/manifest.json',
    `GET /me/modpack/releases/download/pack-1.1.0/${path.basename(configBundle.url)}`
  ])

  // CDN 파일이 매니페스트와 다르면 거부
  write(path.join(tmp, 'www'), 'cdn/files/1001/jei.jar', 'jei-TAMPERED')
  fs.rmSync(path.join(instance, 'mods', 'jei.jar'))
  await assert.rejects(sync(manifestUrl, instance, stateFile), /jei\.jar 다운로드 실패/)
  delete process.env.GITHUB_WEB_URL
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
