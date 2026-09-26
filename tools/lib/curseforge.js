'use strict'

// 커스포지 앱이 설치한 모드/리소스팩은 커스포지 CDN 에서 바로 받을 수 있다.
// 인스턴스 폴더의 minecraftinstance.json 에 파일 이름과 다운로드 주소가 들어 있다.

const fsp = require('node:fs').promises
const path = require('node:path')

function cdnUrl (file) {
  if (typeof file.downloadUrl === 'string' && /^https?:\/\//.test(file.downloadUrl)) return file.downloadUrl
  if (!Number.isInteger(file.id) || !file.fileName) return null
  // 파일 id 5846880 → files/5846/880/<이름>
  return `https://edge.forgecdn.net/files/${Math.floor(file.id / 1000)}/${file.id % 1000}/${encodeURIComponent(file.fileName)}`
}

/**
 * 디스크 상 파일 이름(소문자) → CDN 주소
 */
async function readCurseForgeFiles (sourceDir) {
  let info
  try {
    info = JSON.parse(await fsp.readFile(path.join(sourceDir, 'minecraftinstance.json'), 'utf8'))
  } catch {
    return new Map()
  }
  const map = new Map()
  for (const addon of info.installedAddons || []) {
    const file = addon.installedFile
    if (!file) continue
    const url = cdnUrl(file)
    const onDisk = addon.fileNameOnDisk || file.fileNameOnDisk || file.fileName
    if (url && onDisk) map.set(onDisk.toLowerCase(), url)
  }
  return map
}

// 모드/리소스팩/셰이더 폴더 바로 아래 파일만 CDN 대상으로 본다.
const CDN_DIRS = ['mods', 'resourcepacks', 'shaderpacks']

function cdnUrlFor (map, relPath) {
  const parts = relPath.split('/')
  if (parts.length !== 2 || !CDN_DIRS.includes(parts[0])) return null
  return map.get(parts[1].toLowerCase()) || null
}

// CDN 주소가 실제로 같은 크기의 파일을 주는지 확인한다. 실패하면 null.
async function checkUrl (url, size) {
  try {
    let res = await fetch(url, { method: 'HEAD', redirect: 'follow' })
    if (res.status === 405 || res.status === 403) {
      res = await fetch(url, { headers: { Range: 'bytes=0-0' }, redirect: 'follow' })
      if (res.body) await res.body.cancel()
      const range = res.headers.get('content-range') // bytes 0-0/12345
      const total = range && Number(range.split('/')[1])
      return res.ok && (!total || total === size)
    }
    const len = Number(res.headers.get('content-length'))
    return res.ok && (!len || len === size)
  } catch {
    return false
  }
}

module.exports = { readCurseForgeFiles, cdnUrlFor, cdnUrl, checkUrl }
