#!/usr/bin/env node
'use strict'

// 관리자용: 커스포지 인스턴스(개발용)의 내용을 서버 폴더에 반영한다.
//
//   node tools/sync-server.js --source "<커스포지 인스턴스>" --server "<서버 폴더>" [--dry-run]
//
// 원칙
// - 서버에 필요한 폴더만 다룬다: mods, config, defaultconfigs, kubejs(서버 스크립트·데이터 포함), scripts
//   월드, server.properties, whitelist, ops, 로그 등은 절대 건드리지 않는다.
// - 클라이언트 전용 모드(셰이더, 렌더링 최적화 등)는 서버에 넣지 않는다 (넣으면 서버가 안 켜짐).
// - mods 는 항상 인스턴스와 똑같이. 나머지 파일은 "관리자가 인스턴스에서 바꿨을 때만" 덮어쓴다.
//   → 서버가 실행 중에 쓰는 파일(예: kubejs 스크립트가 기록하는 데이터)은 보존된다.
// - 이전에 이 도구가 넣었는데 인스턴스에서 지운 파일은 서버에서도 지운다.
//   서버에만 있는 파일(서버 전용 모드 등)은 건드리지 않는다.
// - 바꾸거나 지우는 파일은 전부 <서버>/.sync-backup/<시각>/ 에 먼저 백업한다.

const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const { matchesAny, isSafeRelPath } = require('../launcher/src/common/manifest')
const { DEFAULT_CONFIG, readJsonIfExists, sha1File, walk } = require('./build-manifest')

const SERVER_DIRS = ['mods', 'config', 'defaultconfigs', 'kubejs', 'scripts']
const STATE_FILE = '.sync-state.json'

// 서버에 넣으면 크래시가 나는 대표적인 클라이언트 전용 모드 (파일 이름 기준, 대소문자 무시)
const DEFAULT_CLIENT_ONLY = [
  'mods/iris*', 'mods/oculus*', 'mods/sodium*', 'mods/embeddium*', 'mods/rubidium*',
  'mods/immediatelyfast*', 'mods/dynamic*fps*', 'mods/entityculling*', 'mods/fancymenu*',
  'mods/drippyloadingscreen*', 'mods/controlling*', 'mods/mousetweaks*', 'mods/betterf3*',
  'mods/legendarytooltips*', 'mods/ambientsounds*', 'mods/notenoughanimations*',
  'mods/skinlayers3d*', 'mods/3dskinlayers*', 'mods/chat_heads*', 'mods/chat-heads*',
  'mods/catalogue*', 'mods/fpsreducer*', 'mods/distanthorizons*'
]

function parseArgs (argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '')
    if (key === 'dry-run' || key === 'help') args[key] = true
    else if (['source', 'server', 'config'].includes(key) && argv[i + 1] !== undefined) args[key] = argv[++i]
    else throw new Error(`알 수 없는 옵션: ${argv[i]}`)
  }
  return args
}

const USAGE = `사용법:
  node tools/sync-server.js --source <커스포지 인스턴스 폴더> --server <서버 폴더> [--dry-run]

  --dry-run   실제로 바꾸지 않고 무엇이 바뀔지만 보여준다 (처음엔 꼭 이걸로 확인)
  서버는 반드시 끈 상태에서 실행하세요.

  pack.config.json 에서 추가로 정할 수 있는 것:
    "clientOnly": ["mods/파일이름*"]   서버에 넣지 않을 클라이언트 전용 모드 (기본 목록에 더해짐)
    "serverDir": "D:/mcserver"         --server 를 생략했을 때 쓸 서버 폴더`

const lower = list => list.map(p => p.toLowerCase())

async function syncServer ({ source, server, config: configPath, dryRun = false, log = () => {} }) {
  const sourceDir = path.resolve(source)
  const serverDir = path.resolve(server)
  const userConfig = await readJsonIfExists(configPath ? path.resolve(configPath) : path.join(sourceDir, 'pack.config.json')) || {}
  const exclude = [...DEFAULT_CONFIG.exclude, ...(userConfig.exclude || [])]
  const clientOnly = lower([...DEFAULT_CLIENT_ONLY, ...(userConfig.clientOnly || [])])

  if (!fs.existsSync(serverDir)) throw new Error(`서버 폴더가 없습니다: ${serverDir}`)
  if (sourceDir === serverDir) throw new Error('인스턴스 폴더와 서버 폴더가 같습니다')

  // 서버에 보낼 파일 목록
  const wanted = new Map() // rel → { sha1, strict }
  const skippedClientOnly = []
  for (const rel of (await walk(sourceDir)).sort()) {
    if (!matchesAny(rel, SERVER_DIRS) || matchesAny(rel, exclude)) continue
    if (!isSafeRelPath(rel)) continue
    if (matchesAny(rel.toLowerCase(), clientOnly)) {
      skippedClientOnly.push(rel)
      continue
    }
    wanted.set(rel, { sha1: await sha1File(path.join(sourceDir, ...rel.split('/'))), strict: rel.startsWith('mods/') })
  }

  const statePath = path.join(serverDir, STATE_FILE)
  const state = await readJsonIfExists(statePath) || { files: {} }
  const serverFile = rel => path.join(serverDir, ...rel.split('/'))
  const exists = rel => fs.existsSync(serverFile(rel))

  const copies = [] // { rel, reason }
  for (const [rel, { sha1, strict }] of wanted) {
    if (!exists(rel)) {
      copies.push({ rel, reason: '새 파일' })
    } else if (strict || state.files[rel] !== sha1) {
      // mods 는 항상 인스턴스와 같게, 나머지는 인스턴스 쪽이 바뀌었을 때만
      if (await sha1File(serverFile(rel)) !== sha1) copies.push({ rel, reason: strict ? '모드 교체' : '인스턴스에서 수정됨' })
    }
  }

  // 이 도구가 예전에 넣었는데 이제 목록에 없는 파일 → 삭제 (클라이언트 전용으로 바뀐 모드 포함)
  const removals = Object.keys(state.files).filter(rel => !wanted.has(rel) && exists(rel))
  // 서버에 있는 클라이언트 전용 모드는 추적 여부와 상관없이 치운다 (그대로 두면 서버가 안 켜짐)
  for (const rel of (await walk(path.join(serverDir, 'mods')).catch(() => [])).map(p => `mods/${p}`)) {
    if (!rel.slice(5).includes('/') && matchesAny(rel.toLowerCase(), clientOnly) && !removals.includes(rel)) removals.push(rel)
  }
  // 서버에만 있는 모드 (알려주기만 하고 유지)
  const serverOnlyMods = ((await walk(path.join(serverDir, 'mods')).catch(() => [])))
    .map(p => `mods/${p}`)
    .filter(rel => !rel.slice(5).includes('/') && rel.endsWith('.jar') && !wanted.has(rel) && !state.files[rel] && !removals.includes(rel))

  const report = { copies, removals, skippedClientOnly, serverOnlyMods, dryRun }
  if (dryRun) return report

  const backupRoot = path.join(serverDir, '.sync-backup', new Date().toISOString().replace(/[:.]/g, '-'))
  const backup = async rel => {
    if (!exists(rel)) return
    const dest = path.join(backupRoot, ...rel.split('/'))
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    await fsp.copyFile(serverFile(rel), dest)
  }

  const copied = new Set()
  try {
    for (const rel of removals) {
      await backup(rel)
      await fsp.rm(serverFile(rel), { force: true })
      delete state.files[rel]
      log(`  - 삭제 ${rel}`)
    }
    for (const { rel, reason } of copies) {
      await backup(rel)
      await fsp.mkdir(path.dirname(serverFile(rel)), { recursive: true })
      await fsp.copyFile(path.join(sourceDir, ...rel.split('/')), serverFile(rel))
      copied.add(rel)
      log(`  + ${reason}: ${rel}`)
    }
  } catch (e) {
    if (e.code === 'EBUSY' || e.code === 'EPERM') {
      throw new Error(`파일이 사용 중이라 바꿀 수 없습니다 (${e.path}). 서버를 끄고 다시 실행하세요.`)
    }
    throw e
  } finally {
    // "인스턴스의 어떤 내용을 서버에 반영했는지" 기록. 복사가 필요했는데 실패한 파일은 기록하지 않아서 다음에 다시 시도한다.
    const pending = new Set(copies.map(c => c.rel))
    for (const [rel, { sha1 }] of wanted) {
      if (copied.has(rel) || (!pending.has(rel) && exists(rel))) state.files[rel] = sha1
    }
    await fsp.writeFile(statePath, JSON.stringify({ syncedAt: new Date().toISOString(), files: state.files }, null, 2))
  }
  report.backupDir = copies.length || removals.length ? backupRoot : null
  return report
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  const source = args.source
  const userConfig = source ? await readJsonIfExists(path.join(path.resolve(source), 'pack.config.json')) || {} : {}
  const server = args.server || userConfig.serverDir
  if (args.help || !source || !server) {
    console.log(USAGE)
    process.exit(args.help ? 0 : 1)
  }
  console.log(`${args['dry-run'] ? '[미리보기] ' : ''}${path.resolve(source)} → ${path.resolve(server)}`)
  const r = await syncServer({ source, server, config: args.config, dryRun: args['dry-run'], log: console.log })

  if (r.dryRun) {
    for (const { rel, reason } of r.copies) console.log(`  + ${reason}: ${rel}`)
    for (const rel of r.removals) console.log(`  - 삭제: ${rel}`)
  }
  console.log(`✔ ${r.dryRun ? '바뀔 예정' : '완료'}: 복사 ${r.copies.length}개, 삭제 ${r.removals.length}개`)
  if (r.skippedClientOnly.length) {
    console.log(`  클라이언트 전용이라 서버에 안 넣은 모드 ${r.skippedClientOnly.length}개: ${r.skippedClientOnly.map(p => path.basename(p)).join(', ')}`)
  }
  if (r.serverOnlyMods.length) {
    console.log(`  서버에만 있는 모드 (그대로 둠): ${r.serverOnlyMods.map(p => path.basename(p)).join(', ')}`)
  }
  if (r.backupDir) console.log(`  바뀐/지운 파일의 원래 내용은 여기 백업됨: ${r.backupDir}`)
  if (r.dryRun) console.log('  실제로 반영하려면 --dry-run 을 빼고 다시 실행하세요. (서버는 꺼 둔 상태로)')
}

if (require.main === module) {
  main().catch(e => {
    console.error(`✘ ${e.message}`)
    process.exit(1)
  })
}

module.exports = { syncServer, DEFAULT_CLIENT_ONLY }
