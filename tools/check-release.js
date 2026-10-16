#!/usr/bin/env node
'use strict'

// 배포 점검 (check.bat 에서 실행됨): GitHub 최신 배포가 가리키는 파일을 친구용·서버용 모두 실제로 받아 볼 수 있는지 확인한다.
// 서버 목록은 암호화돼 있으므로 서버 키(SERVER_PACK_KEY)로 풀어서 본다.
// --repair 를 주면 빠진 파일을 로컬 배포 폴더(pack-dist-gh\release-<버전>)에서 찾아 그 릴리스에 다시 올린다 (GITHUB_TOKEN 필요).
//
//   node tools/check-release.js --repo me/modpack --out pack-dist-gh [--repair]

const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const github = require('./lib/github')
const secret = require('../launcher/src/common/secret')
const { checkUrl } = require('./lib/curseforge')

async function fetchBuffer (url) {
  const u = new URL(url)
  u.searchParams.set('_', Date.now().toString())
  const res = await fetch(u, { cache: 'no-store' })
  if (!res.ok) throw new Error(`${url.split('/').slice(-2).join('/')} 를 받지 못했습니다 (HTTP ${res.status})`)
  return Buffer.from(await res.arrayBuffer())
}

async function mapLimit (items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }))
  return out
}

// 목록이 가리키는 GitHub 파일들 (CDN·모드린스 주소는 남의 서버라 제외)
function references (manifest, label, ownPrefix) {
  const refs = []
  for (const b of manifest.bundles || []) refs.push({ url: b.url, size: b.size, what: `${label} 묶음 ${b.id}` })
  for (const f of manifest.files || []) if (f.url && f.url.startsWith(ownPrefix)) refs.push({ url: f.url, size: f.size, what: `${label} ${f.path}` })
  return refs
}

async function checkRelease ({ repo, serverKey, outDir, repair = false, token, log = console.log }) {
  const latest = github.manifestUrl(repo)
  const ownPrefix = github.releaseDownloadPrefix(repo)
  const client = JSON.parse((await fetchBuffer(latest)).toString('utf8'))
  log(`최신 배포: v${client.version}`)
  const refs = references(client, '친구용', ownPrefix)
  if (serverKey) {
    const server = JSON.parse(secret.decrypt(await fetchBuffer(latest.replace(/manifest\.json$/, 'server-manifest.bin')), serverKey).toString('utf8'))
    if (server.version !== client.version) log(`! 서버용 목록 버전(v${server.version})이 친구용(v${client.version})과 다릅니다`)
    refs.push(...references(server, '서버용', ownPrefix))
  } else {
    log('! 서버 키가 없어 서버용 목록은 확인하지 않습니다')
  }
  const unique = [...new Map(refs.map(r => [r.url, r])).values()]
  log(`GitHub 파일 ${unique.length}개 확인 중...`)
  const ok = await mapLimit(unique, 8, r => checkUrl(r.url, r.size))
  const missing = unique.filter((_, i) => !ok[i])
  if (!missing.length) {
    log('✔ 전부 받을 수 있습니다.')
    return { version: client.version, checked: unique.length, missing: [], repaired: [] }
  }
  log(`✘ 받을 수 없는 파일 ${missing.length}개:`)
  for (const r of missing) log(`    ${r.what}  →  ${r.url.slice(ownPrefix.length)}`)

  const repaired = []
  if (repair) {
    if (!token) throw new Error('다시 올리려면 GITHUB_TOKEN 이 필요합니다')
    const releases = new Map()
    for (const r of missing) {
      const [tag, name] = r.url.slice(ownPrefix.length).split('/').map(decodeURIComponent)
      const version = tag.replace(/^pack-/, '')
      const local = path.join(outDir, `release-${version}`, name)
      if (!fs.existsSync(local) || (await fsp.stat(local)).size !== r.size) {
        log(`  - ${name}: 내 컴(${path.relative(process.cwd(), local)})에도 없어 다시 올릴 수 없습니다`)
        continue
      }
      if (!releases.has(tag)) releases.set(tag, await github.api(token, 'GET', `${github.API()}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`))
      const release = releases.get(tag)
      // 반쯤 올라가다 만 같은 이름의 파일이 있으면 지우고 다시
      for (const a of release.assets || []) {
        if (a.name === name) await github.api(token, 'DELETE', `${github.API()}/repos/${repo}/releases/assets/${a.id}`)
      }
      const uploadBase = release.upload_url.replace(/\{.*\}$/, '')
      await github.api(token, 'POST', `${uploadBase}?name=${encodeURIComponent(name)}`, await fsp.readFile(local), { 'Content-Type': 'application/octet-stream' })
      repaired.push(r.url)
      log(`  ✔ 다시 올림: ${tag}/${name}`)
    }
  }
  return { version: client.version, checked: unique.length, missing, repaired }
}

function parseArgs (argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--repair') args.repair = true
    else if (a === '--repo' || a === '--out') args[a.slice(2)] = argv[++i]
    else throw new Error(`알 수 없는 인자: ${a}`)
  }
  return args
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2))
  if (!args.repo) {
    console.log('사용법: node tools/check-release.js --repo 아이디/modpack [--out pack-dist-gh] [--repair]')
    process.exit(1)
  }
  checkRelease({ repo: args.repo, outDir: path.resolve(args.out || 'pack-dist-gh'), repair: args.repair, serverKey: process.env.SERVER_PACK_KEY, token: process.env.GITHUB_TOKEN })
    .then(r => {
      if (r.missing.length > r.repaired.length) {
        console.log('')
        console.log('빠진 파일이 남아 있습니다. 위 목록을 그대로 알려 주세요. (patch.bat 으로 새 버전을 배포해도 빠진 파일은 다시 만들어 올립니다)')
        process.exit(2)
      }
      if (r.repaired.length) console.log('✔ 빠진 파일을 다시 올렸습니다. 서버에서 서버시작.bat 을 다시 실행하세요.')
    })
    .catch(e => {
      console.error(`✘ ${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ''}`)
      process.exit(1)
    })
}

module.exports = { checkRelease }
