#!/usr/bin/env node
'use strict'

// 런처 설치 패키지를 GitHub 릴리스에 올린다 (launcher.bat 에서 실행됨).
//
// 이미 설치된 런처는 launcher.json 의 버전을 보고 스스로 업데이트한다 (src/main/self-update.js).
// 친구들에게 주는 KubejsRPG-Setup.exe 는 1MB 남짓한 "작은 설치 파일" 이고, 실행하면
// launcher/package.json 의 nsisWeb.appPackageUrl 주소에서 런처 본체(약 100MB)를 받아 설치한다.
// 그 주소는 버전과 상관없이 고정이라, 여기서 본체만 바꿔 올리면 예전에 나눠 준 설치 파일로도 최신 런처가 깔린다.
//
// - 릴리스는 "사전 배포(prerelease)" 로 만든다. 모드팩 런처가 보는 releases/latest 에 절대 잡히지 않게.
// - 새 파일을 임시 이름으로 다 올린 뒤에 이름을 바꿔 끼우므로, 올리는 도중에도 기존 파일은 받을 수 있다.
//
//   node tools/publish-launcher.js [--dist launcher/dist/nsis-web]   (GITHUB_TOKEN 필요)

const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const github = require('./lib/github')
const { checkUrl } = require('./lib/curseforge')

const LAUNCHER_DIR = path.join(__dirname, '..', 'launcher')
const SETUP_NAME = 'KubejsRPG-Setup.exe'

// appPackageUrl = https://github.com/<owner>/<repo>/releases/download/<tag>/<파일 이름>
function packageTarget (pkg) {
  const url = pkg.build && pkg.build.nsisWeb && pkg.build.nsisWeb.appPackageUrl
  const m = url && url.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/releases\/download\/([^/]+)\/([^/]+)$/)
  if (!m) throw new Error('launcher/package.json 의 build.nsisWeb.appPackageUrl 이 GitHub 릴리스 주소가 아닙니다')
  return { url, repo: m[1], tag: m[2], packageName: m[3] }
}

function findBuild (distDir, version) {
  const pkgFile = path.join(distDir, `modpack-launcher-${version}-x64.nsis.7z`)
  const setupFile = path.join(distDir, SETUP_NAME)
  for (const f of [pkgFile, setupFile]) {
    if (!fs.existsSync(f)) throw new Error(`빌드 결과가 없습니다: ${f}\n  먼저 launcher 폴더에서 npm run build:win 을 실행하세요.`)
  }
  return { pkgFile, setupFile }
}

async function getOrCreateRelease (token, repo, tag) {
  try {
    return await github.api(token, 'GET', `${github.API()}/repos/${repo}/releases/tags/${tag}`)
  } catch (e) {
    if (e.status !== 404) throw e
  }
  return github.api(token, 'POST', `${github.API()}/repos/${repo}/releases`, {
    tag_name: tag,
    name: 'KubejsRPG 런처',
    body: '런처 설치 파일',
    prerelease: true,
    make_latest: 'false'
  })
}

// 임시 이름으로 올리고 → 같은 이름의 예전 파일 삭제 → 이름 바꾸기
async function replaceAsset (token, repo, release, file, name, log) {
  const data = await fsp.readFile(file)
  const uploadBase = release.upload_url.replace(/\{.*\}$/, '')
  const tmpName = `uploading-${Date.now()}-${name}`
  log(`  올리는 중: ${name} (${(data.length / 1024 / 1024).toFixed(1)} MB)`)
  const uploaded = await github.api(token, 'POST', `${uploadBase}?name=${encodeURIComponent(tmpName)}`, data, { 'Content-Type': 'application/octet-stream' })
  const assets = await github.api(token, 'GET', `${github.API()}/repos/${repo}/releases/${release.id}/assets?per_page=100`)
  for (const a of assets) {
    if (a.name === name || (a.name.startsWith('uploading-') && a.id !== uploaded.id)) {
      await github.api(token, 'DELETE', `${github.API()}/repos/${repo}/releases/assets/${a.id}`)
    }
  }
  await github.api(token, 'PATCH', `${github.API()}/repos/${repo}/releases/assets/${uploaded.id}`, { name })
  return data.length
}

async function publishLauncher ({ distDir = path.join(LAUNCHER_DIR, 'dist', 'nsis-web'), token = process.env.GITHUB_TOKEN, log = () => {}, verifyTries = 6 } = {}) {
  if (!token) throw new Error('GITHUB_TOKEN 이 필요합니다')
  const pkg = JSON.parse(await fsp.readFile(path.join(LAUNCHER_DIR, 'package.json'), 'utf8'))
  const target = packageTarget(pkg)
  const { pkgFile, setupFile } = findBuild(distDir, pkg.version)

  const release = await getOrCreateRelease(token, target.repo, target.tag)
  const size = await replaceAsset(token, target.repo, release, pkgFile, target.packageName, log)
  await replaceAsset(token, target.repo, release, setupFile, SETUP_NAME, log)
  // 설치된 런처들이 보는 버전 정보. 본체·설치 파일을 다 올린 뒤 마지막에 올려야 반쯤 올라간 걸 받지 않는다
  const infoFile = path.join(distDir, 'launcher.json')
  await fsp.writeFile(infoFile, JSON.stringify({ version: pkg.version, setup: SETUP_NAME, date: new Date().toISOString() }, null, 2))
  await replaceAsset(token, target.repo, release, infoFile, 'launcher.json', log)
  const setupUrl = `${github.releaseDownloadPrefix(target.repo)}${target.tag}/${SETUP_NAME}`
  await github.api(token, 'PATCH', `${github.API()}/repos/${target.repo}/releases/${release.id}`, {
    name: `KubejsRPG 런처 v${pkg.version}`,
    body: [
      `런처 v${pkg.version} · ${new Date().toISOString().slice(0, 10)}`,
      '',
      `친구들에게는 **${SETUP_NAME}** 만 주면 됩니다 (작은 설치 파일, 실행하면 런처 본체를 받아 설치).`,
      `바로 받기: ${setupUrl}`,
      '',
      `${target.packageName} 은 설치 파일이 받아 가는 본체입니다. 이름을 바꾸거나 지우지 마세요.`
    ].join('\n'),
    prerelease: true,
    make_latest: 'false'
  })
  // 이름을 바꾼 직후엔 GitHub 다운로드 주소에 잠깐 늦게 반영될 수 있어서 몇 번 다시 확인
  let reachable = false
  const packageUrl = `${github.releaseDownloadPrefix(target.repo)}${target.tag}/${target.packageName}`
  for (let i = 0; i < verifyTries && !reachable; i++) {
    if (i) await new Promise(resolve => setTimeout(resolve, 5000))
    reachable = await checkUrl(packageUrl, size)
  }
  return { version: pkg.version, packageUrl: target.url, setupUrl, reachable }
}

if (require.main === module) {
  const args = process.argv.slice(2)
  const i = args.indexOf('--dist')
  publishLauncher({ distDir: i >= 0 ? path.resolve(args[i + 1]) : undefined, log: console.log })
    .then(r => {
      console.log(`✔ 런처 v${r.version} 를 올렸습니다.`)
      console.log(`  친구들에게 줄 설치 파일: ${r.setupUrl}`)
      if (!r.reachable) console.log('  ! 방금 올린 본체를 아직 받을 수 없습니다. 1~2분 뒤에 위 주소로 설치가 되는지 확인해 주세요.')
    })
    .catch(e => {
      console.error(`✘ ${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ''}`)
      process.exit(1)
    })
}

module.exports = { publishLauncher, packageTarget, getOrCreateRelease, replaceAsset }
