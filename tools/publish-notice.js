#!/usr/bin/env node
'use strict'

// 런처 공지를 올린다 (notice.bat 에서 실행됨). 패치 없이 친구들 런처 위쪽에 바로 뜬다.
//   node tools/publish-notice.js --file <공지.txt>     (GITHUB_TOKEN 필요)
// 공지 글이 비어 있으면 공지를 내린다.
// 첫 줄이 "!" 로 시작하면 강조(빨간) 공지.

const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const { packageTarget, getOrCreateRelease, replaceAsset } = require('./publish-launcher')

function parseNotice (raw) {
  let text = String(raw || '').replace(/^﻿/, '').replace(/\r\n/g, '\n').trim()
  let level = 'info'
  if (text.startsWith('!')) { level = 'warn'; text = text.slice(1).trim() }
  return { text, level }
}

async function publishNotice ({ file, token = process.env.GITHUB_TOKEN, now = new Date(), log = () => {} }) {
  if (!token) throw new Error('GITHUB_TOKEN 이 필요합니다')
  const pkg = JSON.parse(await fsp.readFile(path.join(__dirname, '..', 'launcher', 'package.json'), 'utf8'))
  const target = packageTarget(pkg)
  const { text, level } = parseNotice(await fsp.readFile(file, 'utf8'))
  const notice = { id: now.toISOString(), text, level }
  const out = path.join(path.dirname(file), 'notice.json')
  await fsp.writeFile(out, JSON.stringify(notice, null, 2))
  const release = await getOrCreateRelease(token, target.repo, target.tag)
  await replaceAsset(token, target.repo, release, out, 'notice.json', log)
  return notice
}

if (require.main === module) {
  const args = process.argv.slice(2)
  const i = args.indexOf('--file')
  if (i < 0) { console.log('사용법: node tools/publish-notice.js --file <공지.txt>'); process.exit(1) }
  publishNotice({ file: path.resolve(args[i + 1]) })
    .then(n => console.log(n.text ? `✔ 공지를 올렸습니다${n.level === 'warn' ? ' (강조)' : ''}. 친구들 런처에 몇 분 안에 뜹니다.` : '✔ 공지를 내렸습니다.'))
    .catch(e => { console.error(`✘ ${e.message}`); process.exit(1) })
}

module.exports = { publishNotice, parseNotice }
