#!/usr/bin/env node
'use strict'

// 서버 컴용: GitHub 최신 릴리스의 서버 패키지(server-manifest.bin)를 받아 서버 폴더에 적용한다.
// 서버 폴더에 server-update.json 이 있어야 한다: { "repo": "아이디/modpack", "key": "...", "start": "run.bat" }
//
//   node server-update.js            업데이트만
//   node server-update.js --check    바뀔 내용만 보여주기 (아무것도 안 바꿈)
//   node server-update.js --start    월드 백업 → 업데이트 → 서버 실행 (서버시작.bat 이 이걸 부름)
//   node server-update.js --backup   월드 백업만
//   node server-update.js --restore  백업 목록에서 골라 되돌리기 (백업복원.bat)
//
// server-update.json 의 "keep": ["kubejs/data/rpg/telemetry.json"] 처럼 적은 파일은
// 서버에 있으면 절대 덮어쓰지 않는다 (서버가 직접 기록하는 데이터용)
//
// - 모드는 관리자 인스턴스와 똑같이 맞추고, 설정/KubeJS 는 관리자가 바꿨을 때만 덮어쓴다
//   (서버가 실행 중에 기록하는 데이터 보존)
// - 월드, server.properties 등 목록에 없는 파일은 건드리지 않는다
// - 바뀌거나 지워지는 파일은 .update-backup/<시각>/ 에 먼저 복사해 둔다

const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const { spawn } = require('node:child_process')
const updater = require('../launcher/src/main/updater')
const secret = require('../launcher/src/common/secret')
const { validateManifest, matchesAny } = require('../launcher/src/common/manifest')
const github = require('./lib/github')
const setup = require('./lib/server-setup')
const backup = require('./lib/backup')
const { ADMIN_MANAGED } = require('./lib/server-files')

const CONFIG_FILE = 'server-update.json'
const STATE_FILE = '.server-update-state.json'

async function fetchServerManifest (repo, key) {
  const url = new URL(github.manifestUrl(repo).replace(/manifest\.json$/, 'server-manifest.bin'))
  url.searchParams.set('_', Date.now().toString())
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`서버 패키지를 받지 못했습니다 (HTTP ${res.status}). 관리자가 서버 키를 넣고 배포했는지 확인하세요.`)
  const manifest = JSON.parse(secret.decrypt(Buffer.from(await res.arrayBuffer()), key).toString('utf8'))
  return { manifest: validateManifest(manifest), url: url.toString() }
}

function listJars (serverDir) {
  try {
    return fs.readdirSync(path.join(serverDir, 'mods'), { withFileTypes: true }).filter(e => e.isFile()).map(e => `mods/${e.name}`)
  } catch {
    return []
  }
}

// keep: 서버에 이미 있으면 절대 덮어쓰지 않을 파일 (server-update.json 의 "keep", 서버가 직접 기록하는 데이터 등)
// check: true 면 바뀔 내용만 계산하고 아무것도 바꾸지 않는다
async function updateServer ({ serverDir, repo, key, keep = [], check = false, log = () => {} }) {
  const { manifest, url } = await fetchServerManifest(repo, key)
  const stateFile = path.join(serverDir, STATE_FILE)
  const state = await updater.loadState(stateFile)
  const plan = await updater.planUpdate({ manifest, instanceDir: serverDir, state })

  // 서버에 있으면 안 되는 클라이언트 전용 모드 (추적 여부와 무관하게 치움)
  const clientOnly = manifest.clientOnly || []
  const listed = new Set(manifest.files.map(f => f.path.toLowerCase()))
  const clientOnlyJars = listJars(serverDir).filter(p => !listed.has(p.toLowerCase()) && matchesAny(p.toLowerCase(), clientOnly))
  plan.removals.push(...clientOnlyJars.filter(p => !plan.removals.includes(p)))

  // 보존 목록: 서버에 있으면 받지 않고, "설치된 것" 으로 기록해 둔다 (관리자가 바꿔도 서버 것을 유지)
  const kept = []
  plan.downloads = plan.downloads.filter(f => {
    const local = path.join(serverDir, ...f.path.split('/'))
    if (!matchesAny(f.path, keep) || !fs.existsSync(local)) return true
    const st = fs.statSync(local)
    plan.records[f.path] = { sha1: f.sha1, size: st.size, mtimeMs: st.mtimeMs }
    kept.push(f.path)
    return false
  })
  plan.removals = plan.removals.filter(p => !matchesAny(p, keep))

  // 서버 데이터 보호: 관리자 관리 영역이 아닌 파일은, 서버에서 바뀌었으면 절대 덮어쓰거나 지우지 않는다.
  // "서버에서 바뀜" = 이 도구가 마지막으로 설치한 내용과 다름 (설치한 적 없는데 서버에 있으면 서버 것으로 봄)
  const protectedFiles = []
  const serverChanged = async p => {
    const local = path.join(serverDir, ...p.split('/'))
    if (!fs.existsSync(local)) return false
    const rec = state.files[p]
    if (!rec || !rec.sha1) return true
    return await updater.sha1File(local) !== rec.sha1
  }
  const stillDownload = []
  for (const f of plan.downloads) {
    if (!matchesAny(f.path, ADMIN_MANAGED) && await serverChanged(f.path)) {
      if (state.files[f.path]) plan.records[f.path] = state.files[f.path]
      protectedFiles.push(f.path)
    } else {
      stillDownload.push(f)
    }
  }
  plan.downloads = stillDownload
  const stillRemove = []
  for (const p of plan.removals) {
    if (!matchesAny(p, ADMIN_MANAGED) && !p.startsWith('mods/') && await serverChanged(p)) protectedFiles.push(p)
    else stillRemove.push(p)
  }
  plan.removals = stillRemove

  const neededBundles = new Set(plan.downloads.filter(f => f.bundle && !f.url).map(f => f.bundle))
  plan.downloadBytes = plan.downloads.filter(f => !f.bundle || f.url).reduce((n, f) => n + f.size, 0) +
    (manifest.bundles || []).filter(b => neededBundles.has(b.id)).reduce((n, b) => n + b.size, 0)

  const report = {
    fromVersion: state.installedVersion,
    toVersion: manifest.version,
    downloads: plan.downloads.map(f => f.path),
    removals: plan.removals,
    loader: manifest.loader,
    kept,
    protectedFiles,
    manifest,
    loaderMissing: false,
    backupDir: null
  }

  if (!check && (plan.needsUpdate || plan.removals.length)) {
    report.backupDir = path.join(serverDir, '.update-backup', new Date().toISOString().replace(/[:.]/g, '-'))
    let lastPct = -1
    await updater.applyUpdate({
      manifest,
      manifestUrl: url,
      instanceDir: serverDir,
      stateFile,
      state,
      plan,
      decrypt: buf => secret.decrypt(buf, key),
      backupDir: report.backupDir,
      onProgress: p => {
        if (p.phase !== 'download' || !p.total) return
        const pct = Math.floor((p.current / p.total) * 10) * 10
        if (pct !== lastPct) { lastPct = pct; log(`  받는 중 ${pct}%`) }
      }
    })
    if (!fs.existsSync(report.backupDir)) report.backupDir = null
  }
  try {
    report.loaderMissing = !setup.loaderInstalled(serverDir, manifest.loader)
  } catch {
    report.loaderMissing = true
  }
  return report
}

function startServer (serverDir, command, binDir) {
  const env = { ...process.env }
  // 자바를 서버 폴더(runtime)에 받았으면 run.bat 이 그 자바를 쓰도록 PATH 앞에 둔다
  if (binDir) env.PATH = `${binDir}${path.delimiter}${env.PATH || env.Path || ''}`
  return new Promise(resolve => {
    const p = spawn(command, { cwd: serverDir, stdio: 'inherit', shell: true, env })
    p.on('close', code => resolve(code))
  })
}

function ask (question) {
  return new Promise(resolve => {
    process.stdout.write(question)
    process.stdin.resume()
    process.stdin.once('data', d => {
      process.stdin.pause()
      resolve(String(d).trim().toLowerCase())
    })
  })
}
const yes = a => ['y', 'yes', 'ㅛ', '예', '네'].includes(a)

async function main () {
  const serverDir = process.cwd()
  const configPath = path.join(serverDir, CONFIG_FILE)
  if (!fs.existsSync(configPath)) throw new Error(`${CONFIG_FILE} 이 없습니다. 관리자에게 받은 서버 키트 파일을 서버 폴더에 넣으세요.`)
  const cfg = JSON.parse(await fsp.readFile(configPath, 'utf8'))
  const start = process.argv.includes('--start')
  const check = process.argv.includes('--check')

  if (process.argv.includes('--restore')) return restoreMenu(serverDir, cfg)

  // 서버를 켜기 전에 월드 백업 (바뀐 파일만 저장하므로 보통 금방 끝남)
  if (start || process.argv.includes('--backup')) {
    const ok = await runBackup(serverDir, cfg)
    if (!start) return process.exit(ok ? 0 : 1)
    if (!ok && !yes(await ask('백업을 못 했습니다. 그래도 계속할까요? (y/n) '))) return process.exit(1)
  }

  console.log(check ? '서버 패치 미리보기 (아무것도 바꾸지 않음)...' : '서버 패치 확인 중...')
  let failed = false
  let r = null
  try {
    r = await updateServer({ serverDir, repo: cfg.repo, key: cfg.key, keep: cfg.keep || [], check, log: console.log })
    if (check) {
      console.log(`설치된 버전: ${r.fromVersion || '(없음)'} → 최신: v${r.toVersion}`)
      for (const p of r.downloads) console.log(`  + 받을 파일: ${p}`)
      for (const p of r.removals) console.log(`  - 지울 파일: ${p}`)
      for (const p of r.kept) console.log(`  = 보존 (keep): ${p}`)
      for (const p of r.protectedFiles) console.log(`  = 서버 데이터라 유지: ${p}`)
      console.log(`합계: 받을 파일 ${r.downloads.length}개, 지울 파일 ${r.removals.length}개, 보존 ${r.kept.length + r.protectedFiles.length}개`)
      if (r.loaderMissing) console.log(`• ${r.loader.type} ${r.loader.version} 서버가 아직 없습니다 → 실제 실행 때 자동 설치`)
      return process.exit(0)
    }
    if (!r.downloads.length && !r.removals.length) {
      console.log(`✔ 최신 버전입니다 (v${r.toVersion})`)
    } else {
      console.log(`✔ 패치 적용: v${r.fromVersion || '(처음)'} → v${r.toVersion}  (받은 파일 ${r.downloads.length}개, 지운 파일 ${r.removals.length}개)`)
      for (const p of r.removals) console.log(`  - ${p}`)
      if (r.backupDir) console.log(`  이전 파일 백업: ${r.backupDir}`)
    }
    if (r.protectedFiles.length) {
      console.log(`  서버에서 바뀐 데이터 파일 ${r.protectedFiles.length}개는 관리자 패치와 상관없이 그대로 뒀습니다:`)
      for (const p of r.protectedFiles) console.log(`    = ${p}`)
    }
  } catch (e) {
    console.error(`✘ 패치 실패: ${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ''}`)
    failed = true
  }

  // 모드로더 서버가 없으면 (새 서버, 또는 관리자가 버전을 올림) 자동 설치
  let java = null
  if (r && r.loaderMissing) {
    try {
      console.log('')
      java = await setup.prepareJava(serverDir, setup.requiredJava(r.manifest), console.log)
      await setup.installLoader({ serverDir, manifest: r.manifest, javaPath: java.javaPath, log: console.log })
      console.log(`✔ ${r.loader.type} ${r.loader.version} 서버 설치 완료`)
    } catch (e) {
      console.error(`✘ ${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ''}`)
      failed = true
    }
  }

  if (!start) return process.exit(failed ? 1 : 0)
  if (failed && !yes(await ask('\n문제가 있었습니다. 그래도 서버를 켤까요? (y/n) '))) return process.exit(1)

  if (!java && r) java = await setup.prepareJava(serverDir, setup.requiredJava(r.manifest), console.log)
  if (!setup.eulaAccepted(serverDir)) {
    console.log('\n서버를 켜려면 마인크래프트 EULA 에 동의해야 합니다: https://aka.ms/MinecraftEULA')
    if (!yes(await ask('EULA 에 동의합니까? (y/n) '))) return process.exit(1)
    await setup.acceptEula(serverDir)
  }
  const mem = await setup.ensureMemory(serverDir)
  if (mem) console.log(`서버 메모리를 ${mem} 로 설정했습니다 (user_jvm_args.txt 에서 바꿀 수 있어요)`)

  console.log(`\n서버 시작: ${cfg.start || 'run.bat'}\n`)
  process.exit(await startServer(serverDir, cfg.start || 'run.bat', java && java.binDir))
}

async function runBackup (serverDir, cfg) {
  const b = backup.DEFAULTS
  const conf = { ...b, ...(cfg.backup || {}) }
  if (!conf.enabled) return true
  console.log(`월드 백업 중... (${path.resolve(serverDir, conf.dir)})`)
  try {
    const r = await backup.createBackup({ serverDir, config: cfg.backup, log: console.log })
    console.log(`✔ 백업 ${r.name}: 월드 ${backup.formatSize(r.totalBytes)} 중 새로 저장 ${backup.formatSize(r.storedBytes)} (파일 ${r.storedFiles}개) · 최근 ${conf.keep}개 보관`)
    return true
  } catch (e) {
    console.error(`✘ 백업 실패: ${e.message}`)
    return false
  }
}

async function restoreMenu (serverDir, cfg) {
  const list = await backup.listBackups(serverDir, cfg.backup)
  if (!list.length) {
    console.log('백업이 없습니다.')
    return process.exit(0)
  }
  console.log('서버가 꺼져 있는지 먼저 확인하세요.\n')
  list.forEach((b, i) => console.log(`  ${String(i + 1).padStart(2)}. ${b.name}   (파일 ${b.fileCount}개, ${backup.formatSize(b.totalBytes)})`))
  const n = Number(await ask('\n되돌릴 백업 번호 (그냥 Enter = 취소): '))
  const pick = list[n - 1]
  if (!pick) { console.log('취소했습니다.'); return process.exit(0) }
  if (!yes(await ask(`${pick.name} 시점으로 월드를 되돌릴까요? 지금 월드는 지우지 않고 옆에 남겨 둡니다 (y/n) `))) {
    console.log('취소했습니다.')
    return process.exit(0)
  }
  const r = await backup.restoreBackup({ serverDir, config: cfg.backup, name: pick.name, log: console.log })
  console.log(`✔ ${r.name} 로 되돌렸습니다 (파일 ${r.fileCount}개).`)
  if (r.moved.length) {
    console.log('  되돌리기 전 것은 이름을 바꿔 남겨 뒀습니다. 문제없으면 나중에 지워도 됩니다:')
    for (const m of r.moved) console.log(`    ${m}`)
  }
  return process.exit(0)
}

if (require.main === module) {
  main().catch(e => {
    console.error(`✘ ${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ''}`)
    process.exit(1)
  })
}

module.exports = { updateServer, main }
