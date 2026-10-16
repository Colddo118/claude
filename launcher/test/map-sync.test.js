'use strict'

// 대륙 맵: 관리자 싱글 월드 → 서버 패키지 → 서버(관리자가 고친 region 만 덮음) → 맵보내기 → 관리자 받기

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { build } = require('../../tools/build-manifest')
const { makeKit } = require('../../tools/make-server-kit')
const mapSync = require('../../tools/lib/map-sync')
const secret = require('../src/common/secret')

let tmp, server, base
const www = () => path.join(tmp, 'www')

function write (root, rel, content) {
  const p = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}
const read = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8')
const exists = (root, rel) => fs.existsSync(path.join(root, ...rel.split('/')))

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'map-sync-'))
  // 가짜 GitHub: /api = REST, /uploads = 첨부 올리기, 나머지 = 릴리스 다운로드
  let release = null
  let assets = []
  let nextId = 1
  const mapDir = () => path.join(www(), 'me', 'modpack', 'releases', 'download', 'server-map')
  server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', d => chunks.push(d))
    req.on('end', () => {
      const url = new URL(req.url, 'http://x')
      const p = url.pathname
      const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)) }
      if (p.startsWith('/api/') || p.startsWith('/uploads/')) {
        if (req.headers.authorization !== 'Bearer github_pat_test') return json(401, { message: 'Bad credentials' })
        if (req.method === 'GET' && p === '/api/repos/me/modpack/releases/tags/server-map') return release ? json(200, release) : json(404, { message: 'Not Found' })
        if (req.method === 'POST' && p === '/api/repos/me/modpack/releases') {
          const b = JSON.parse(Buffer.concat(chunks))
          assert.equal(b.prerelease, true)
          assert.equal(b.make_latest, 'false')
          release = { id: 1, tag_name: b.tag_name, upload_url: `${base}/uploads/1/assets{?name,label}` }
          return json(201, release)
        }
        if (req.method === 'GET' && p === '/api/repos/me/modpack/releases/1/assets') return json(200, Number(url.searchParams.get('page') || 1) > 1 ? [] : assets)
        if (req.method === 'POST' && p === '/uploads/1/assets') {
          const name = url.searchParams.get('name')
          fs.mkdirSync(mapDir(), { recursive: true })
          fs.writeFileSync(path.join(mapDir(), name), Buffer.concat(chunks))
          const a = { id: nextId++, name }
          assets.push(a)
          return json(201, a)
        }
        const del = p.match(/^\/api\/repos\/me\/modpack\/releases\/assets\/(\d+)$/)
        if (del && req.method === 'DELETE') {
          const a = assets.find(x => x.id === Number(del[1]))
          assets = assets.filter(x => x !== a)
          fs.rmSync(path.join(mapDir(), a.name), { force: true })
          return json(204)
        }
        return json(404, { message: `no route ${req.method} ${p}` })
      }
      const file = path.join(www(), decodeURIComponent(p))
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end() }
      res.writeHead(200, { 'Content-Length': fs.statSync(file).size })
      if (req.method === 'HEAD') return res.end()
      fs.createReadStream(file).pipe(res)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
  process.env.GITHUB_WEB_URL = base
  process.env.GITHUB_API_URL = `${base}/api`
  process.env.MODRINTH_API_URL = `${base}/no-modrinth`
})

after(() => {
  delete process.env.GITHUB_WEB_URL
  delete process.env.GITHUB_API_URL
  server.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function publishLocally (r, repo = 'me/modpack') {
  const relDir = path.join(www(), ...repo.split('/'), 'releases', 'download', `pack-${r.manifest.version}`)
  fs.mkdirSync(relDir, { recursive: true })
  for (const f of r.newAssets) fs.copyFileSync(f, path.join(relDir, path.basename(f)))
  for (const name of ['manifest.json', 'server-manifest.bin']) {
    write(www(), `${repo}/releases/latest/download/${name}`, fs.readFileSync(path.join(relDir, name)))
  }
}

function run (cwd, args, env = {}) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env } })
    let out = ''
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { out += d })
    p.on('close', code => resolve({ code, out }))
  })
}

test('대륙 맵: 올리기는 관리자가 고친 region 만 덮고, 받기는 양쪽에서 고친 파일을 물어본다', async () => {
  const key = secret.newKey()
  const src = path.join(tmp, 'instance')
  const out = path.join(tmp, 'pack-dist')
  const srv = path.join(tmp, 'server')
  const dev = 'saves/dev/dimensions/kubejs/continent'
  const sw = 'world/dimensions/kubejs/continent'

  write(src, 'minecraftinstance.json', JSON.stringify({ gameVersion: '1.21.1', baseModLoader: { name: 'neoforge-21.1.77' } }))
  write(src, 'pack.config.json', JSON.stringify({ github: 'me/modpack', map: { world: 'saves/dev', dims: ['dimensions/kubejs/continent'] } }))
  write(src, 'mods/create.jar', 'create-v1')
  write(src, 'kubejs/server_scripts/a.js', 'script')
  write(src, `${dev}/region/r.0.0.mca`, 'MAPDATA_A1')
  write(src, `${dev}/region/r.1.0.mca`, 'MAPDATA_B1')
  write(src, `${dev}/poi/r.0.0.mca`, 'MAPDATA_P1')
  write(src, `${dev}/entities/r.0.0.mca`, 'MAPDATA_E1')
  write(src, `${dev}/data/raids.dat`, 'dev raids')

  // 맵 없이 첫 배포 → 서버 패키지에 맵 없음
  const r0 = await build({ source: src, out, version: '1.0.0', notes: '', serverKey: key })
  assert.equal(r0.serverPackage.map.carried, 0)
  publishLocally(r0)
  write(srv, 'run.bat', 'echo run')
  write(srv, 'world/level.dat', 'world')
  write(srv, `${sw}/data/raids.dat`, 'server raids')
  write(srv, 'libraries/net/neoforged/neoforge/21.1.77/neoforge-21.1.77-server.jar', 'x') // 서버 설치 파일 받기 건너뜀 (테스트는 인터넷 없이)
  makeKit({ out: srv, repo: 'me/modpack', key })
  const u0 = await run(srv, ['server-update.js'])
  assert.equal(u0.code, 0, u0.out)
  assert.equal(exists(srv, `${sw}/region/r.0.0.mca`), false)

  // 맵 올리기 (처음: 전부)
  const r1 = await build({ source: src, out, version: '1.0.1', notes: '', serverKey: key, map: true })
  assert.deepEqual([r1.serverPackage.map.changed, r1.serverPackage.map.kept], [3, 0])
  await mapSync.writeSync(out, r1.serverPackage.map.sync) // build-manifest main 이 업로드 성공 뒤 하는 일
  publishLocally(r1)
  for (const f of r1.newAssets) assert.ok(!fs.readFileSync(f).includes('MAPDATA'), `공개 릴리스에 맵 원문: ${path.basename(f)}`)
  assert.ok(!r1.manifest.files.some(f => mapSync.isMapPath(f.path)), '친구용 매니페스트에 맵이 있으면 안 됨')
  const u1 = await run(srv, ['server-update.js'])
  assert.equal(u1.code, 0, u1.out)
  assert.match(u1.out, /대륙 맵: 관리자가 고친 region · poi 파일 3개/)
  assert.equal(read(srv, `${sw}/region/r.0.0.mca`), 'MAPDATA_A1')
  assert.equal(read(srv, `${sw}/poi/r.0.0.mca`), 'MAPDATA_P1')
  assert.equal(exists(srv, `${sw}/entities/r.0.0.mca`), false) // entities 는 안 감
  assert.equal(read(srv, `${sw}/data/raids.dat`), 'server raids') // data 는 서버 것

  // 서버에서 두 region 이 바뀌고, 관리자는 r.1.0 만 고쳐서 올림 → r.1.0 만 덮임
  write(srv, `${sw}/region/r.0.0.mca`, 'MAPDATA_A_srv')
  write(srv, `${sw}/region/r.1.0.mca`, 'MAPDATA_B_srv')
  write(src, `${dev}/region/r.1.0.mca`, 'MAPDATA_B2')
  const r2 = await build({ source: src, out, version: '1.0.2', notes: '', serverKey: key, map: true })
  assert.deepEqual([r2.serverPackage.map.changed, r2.serverPackage.map.kept], [1, 2])
  await mapSync.writeSync(out, r2.serverPackage.map.sync)
  publishLocally(r2)
  assert.equal((await run(srv, ['server-update.js'])).code, 0)
  assert.equal(read(srv, `${sw}/region/r.0.0.mca`), 'MAPDATA_A_srv')
  assert.equal(read(srv, `${sw}/region/r.1.0.mca`), 'MAPDATA_B2')

  // 맵 없이 패치: 관리자가 r.0.0 을 고쳤어도 안 실림, 서버 맵 그대로 · 지우지도 않음
  write(src, `${dev}/region/r.0.0.mca`, 'MAPDATA_A2')
  write(src, 'mods/create.jar', 'create-v2')
  const r3 = await build({ source: src, out, version: '1.0.3', notes: '', serverKey: key })
  assert.equal(r3.serverPackage.map.carried, 3)
  publishLocally(r3)
  const u3 = await run(srv, ['server-update.js'])
  assert.equal(u3.code, 0, u3.out)
  assert.equal(read(srv, 'mods/create.jar'), 'create-v2')
  assert.equal(read(srv, `${sw}/region/r.0.0.mca`), 'MAPDATA_A_srv')
  assert.equal(read(srv, `${sw}/region/r.1.0.mca`), 'MAPDATA_B2')

  // 서버 → 관리자: 토큰 없거나 틀리면 실패
  write(srv, `${sw}/region/r.1.0.mca`, 'MAPDATA_B_srv2')
  assert.match((await run(srv, ['server-update.js', '--send-map'], { GITHUB_TOKEN: '' })).out, /GitHub 토큰이 없습니다/)
  assert.notEqual((await run(srv, ['server-update.js', '--send-map'], { GITHUB_TOKEN: 'github_pat_wrong' })).code, 0)
  const s1 = await run(srv, ['server-update.js', '--send-map'], { GITHUB_TOKEN: 'github_pat_test' })
  assert.equal(s1.code, 0, s1.out)
  assert.match(s1.out, /파일 3개 중 새로 올린 것 3개/)
  for (const f of fs.readdirSync(path.join(www(), 'me/modpack/releases/download/server-map'))) {
    assert.ok(!fs.readFileSync(path.join(www(), 'me/modpack/releases/download/server-map', f)).includes('MAPDATA'), f)
  }
  // 다시 보내면 안 바뀐 파일은 안 올림
  const s2 = await run(srv, ['server-update.js', '--send-map'], { GITHUB_TOKEN: 'github_pat_test' })
  assert.match(s2.out, /새로 올린 것 0개/)

  // 관리자: 상태 확인 → r.1.0 받기, r.0.0 은 양쪽에서 고침, poi 같음
  const tools = path.join(__dirname, '..', '..', 'tools')
  const env = { SERVER_PACK_KEY: key }
  const st = await run(tools, ['map.js', 'status', '--source', src, '--out', out], env)
  assert.equal(st.code, 0, st.out)
  const status = JSON.parse(st.out.trim().split('\n').pop())
  assert.equal(status.worldInUse, false)
  assert.equal(status.devChanged, 1) // r.0.0 (A2)
  assert.deepEqual([status.server.newer, status.server.take, status.server.conflicts, status.server.same], [true, 1, 1, 1])

  const pl = await run(tools, ['map.js', 'pull', '--source', src, '--out', out, '--conflict', 'keep'], env)
  assert.equal(pl.code, 0, pl.out)
  assert.match(pl.out, /1개 덮음, 이미 같은 파일 1개, 내 것 유지 1개/)
  assert.equal(read(src, `${dev}/region/r.1.0.mca`), 'MAPDATA_B_srv2')
  assert.equal(read(src, `${dev}/region/r.0.0.mca`), 'MAPDATA_A2') // 내 것 유지
  const backups = fs.readdirSync(path.join(out, 'map-backup'))
  assert.equal(read(path.join(out, 'map-backup', backups[0]), `${sw}/region/r.1.0.mca`), 'MAPDATA_B2')
  const st2 = JSON.parse((await run(tools, ['map.js', 'status', '--source', src, '--out', out], env)).out.trim().split('\n').pop())
  assert.equal(st2.server.newer, false)
  assert.equal(st2.devChanged, 1) // 유지한 r.0.0 은 다음 올리기에 실린다

  // 받은 뒤 올리기: 받기만 한 r.1.0 은 서버 것 유지, 내가 고친 r.0.0 만 덮임
  write(srv, `${sw}/region/r.1.0.mca`, 'MAPDATA_B_srv3') // 받은 뒤에도 서버는 계속 돈다
  const r4 = await build({ source: src, out, version: '1.0.4', notes: '', serverKey: key, map: true })
  assert.equal(r4.serverPackage.map.changed, 1)
  await mapSync.writeSync(out, r4.serverPackage.map.sync)
  publishLocally(r4)
  assert.equal((await run(srv, ['server-update.js'])).code, 0)
  assert.equal(read(srv, `${sw}/region/r.0.0.mca`), 'MAPDATA_A2')
  assert.equal(read(srv, `${sw}/region/r.1.0.mca`), 'MAPDATA_B_srv3')
  assert.equal(read(srv, 'world/level.dat'), 'world')
})

test('대륙 맵: 업로드가 중간에 끊긴 배포가 있어도 다음 배포는 GitHub 에 있는 맵 파일만 가리킨다', async () => {
  const key = secret.newKey()
  const src = path.join(tmp, 'instance2')
  const out = path.join(tmp, 'pack-dist2')
  const srv = path.join(tmp, 'server2')
  const dev = 'saves/dev/dimensions/kubejs/continent'
  const sw = 'world/dimensions/kubejs/continent'
  write(src, 'minecraftinstance.json', JSON.stringify({ gameVersion: '1.21.1', baseModLoader: { name: 'neoforge-21.1.77' } }))
  write(src, 'pack.config.json', JSON.stringify({ github: 'me/town', map: { world: 'saves/dev', dims: ['dimensions/kubejs/continent'] } }))
  write(src, 'mods/create.jar', 'create-v1')
  write(src, `${dev}/region/r.0.0.mca`, 'TOWN_A1')
  write(src, `${dev}/region/r.1.0.mca`, 'TOWN_B1')

  // 맵을 실은 2.0.0 은 GitHub 에 올라가다 끊김 (창을 닫음) → 로컬 기록만 남고 공개는 안 됨
  const r0 = await build({ source: src, out, version: '2.0.0', notes: '', serverKey: key, map: true })
  assert.equal(r0.serverPackage.map.changed, 2)
  await mapSync.writeSync(out, r0.serverPackage.map.sync)
  // 그 뒤 r.1.0 만 더 고치고, 맵 없이 2.0.1 배포 → 끊긴 2.0.0 의 맵 항목을 그대로 이어 가면 안 된다
  write(src, `${dev}/region/r.1.0.mca`, 'TOWN_B2')
  const r1 = await build({ source: src, out, version: '2.0.1', notes: '', serverKey: key })
  assert.deepEqual([r1.serverPackage.map.repaired, r1.serverPackage.map.lost], [1, 1])
  publishLocally(r1, 'me/town')

  write(srv, 'run.bat', 'echo run')
  write(srv, 'world/level.dat', 'world')
  write(srv, 'libraries/net/neoforged/neoforge/21.1.77/neoforge-21.1.77-server.jar', 'x')
  makeKit({ out: srv, repo: 'me/town', key })
  const u = await run(srv, ['server-update.js'])
  assert.equal(u.code, 0, u.out)
  assert.equal(read(srv, `${sw}/region/r.0.0.mca`), 'TOWN_A1')
  assert.equal(exists(srv, `${sw}/region/r.1.0.mca`), false) // 바뀐 r.1.0 은 맵을 올릴 때 실린다

  // 맵을 올리면 r.1.0 도 들어간다
  const r2 = await build({ source: src, out, version: '2.0.2', notes: '', serverKey: key, map: true })
  publishLocally(r2, 'me/town')
  const u2 = await run(srv, ['server-update.js'])
  assert.equal(u2.code, 0, u2.out)
  assert.equal(read(srv, `${sw}/region/r.1.0.mca`), 'TOWN_B2')
})
