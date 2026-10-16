#!/usr/bin/env node
'use strict'

// 관리자용: 대륙 맵 상태 확인 / 서버가 보낸 맵 받기 (patch.bat 이 부른다). 서버 키는 SERVER_PACK_KEY 환경변수.
//
//   node tools/map.js status --source <인스턴스> --out <pack-dist-gh>   상태를 JSON 한 줄로
//   node tools/map.js pull   --source <인스턴스> --out <pack-dist-gh> [--conflict keep|take]
//
// 싱글 월드 · 차원은 <인스턴스>/pack.config.json 의 "map" 을 따른다.

const fs = require('node:fs')
const path = require('node:path')
const mapSync = require('./lib/map-sync')

function parse (argv) {
  const args = { cmd: argv[0] }
  for (let i = 1; i < argv.length; i++) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`알 수 없는 인자: ${argv[i]}`)
    args[argv[i].slice(2)] = argv[++i]
  }
  return args
}

async function context ({ source, out }) {
  if (!source || !out) throw new Error('--source 와 --out 이 필요합니다')
  const config = JSON.parse(fs.readFileSync(path.join(source, 'pack.config.json'), 'utf8').replace(/^﻿/, ''))
  const map = mapSync.mapSettings(config)
  if (!map) throw new Error('pack.config.json 에 "map" 설정이 없습니다')
  const key = process.env.SERVER_PACK_KEY
  if (!key) throw new Error('SERVER_PACK_KEY 환경변수가 필요합니다')
  return { repo: config.github, key, map, worldAbs: path.resolve(source, map.world), outDir: path.resolve(out) }
}

async function status (ctx) {
  const sync = await mapSync.readSync(ctx.outDir)
  const inUse = mapSync.worldInUse(ctx.worldAbs)
  const { all, changed } = await mapSync.devChanges(ctx.worldAbs, ctx.map, sync)
  const serverMap = await mapSync.fetchServerMap(ctx.repo, ctx.key)
  let server = null
  if (serverMap) {
    const plan = await mapSync.planPull({ worldAbs: ctx.worldAbs, serverMap, sync })
    server = {
      sentAt: serverMap.sentAt,
      newer: serverMap.sentAt !== sync.pulledSentAt,
      take: plan.take.length,
      conflicts: plan.conflict.length,
      same: plan.same.length
    }
  }
  // patch.ps1 이 ConvertFrom-Json 으로 읽는다 (영문 · 숫자만)
  console.log(JSON.stringify({ worldInUse: inUse, devTotal: all.length, devChanged: changed.length, server }))
}

async function pull (ctx, conflict) {
  const serverMap = await mapSync.fetchServerMap(ctx.repo, ctx.key)
  if (!serverMap) throw new Error('서버가 보낸 맵이 없습니다 (서버 컴에서 맵보내기.bat 을 먼저 실행)')
  const backupDir = path.join(ctx.outDir, 'map-backup', new Date().toISOString().replace(/[:.]/g, '-'))
  const r = await mapSync.pullServerMap({ ...ctx, serverMap, conflict, backupDir, log: console.log })
  console.log(`✔ 서버 맵 받음: ${r.taken}개 덮음, 이미 같은 파일 ${r.same}개${r.keptConflicts ? `, 내 것 유지 ${r.keptConflicts}개 (다음 올리기에 실림)` : ''}`)
  if (r.taken && fs.existsSync(backupDir)) console.log(`  덮기 전 싱글 월드 파일: ${backupDir}`)
}

async function main () {
  const args = parse(process.argv.slice(2))
  const ctx = await context(args)
  if (args.cmd === 'status') return status(ctx)
  if (args.cmd === 'pull') return pull(ctx, args.conflict === 'take' ? 'take' : 'keep')
  throw new Error('사용법: node tools/map.js status|pull --source <인스턴스> --out <pack-dist-gh> [--conflict keep|take]')
}

main().catch(e => {
  console.error(`✘ ${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ''}`)
  process.exit(1)
})
