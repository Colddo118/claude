'use strict'

// 게임 파일 위치 (유저가 설정창에서 바꿀 수 있음).
// 설정 · 계정 · 위치 기록은 늘 %APPDATA%\<dataFolderName> 에 두고, 무거운 게임 파일만 고른 곳으로 옮긴다.
// 런처 설치 폴더는 업데이트 때 통째로 지워지므로(electron-builder 제거기의 RMDir /r $INSTDIR) 그 안에는 못 둔다.

const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')

// 게임 파일 폴더에 들어가는 것 (여기 없는 settings.json · account.json 등은 옮기지 않음)
const DATA_ENTRIES = ['instance', 'minecraft', 'runtime', 'cache', 'logs', 'state.json']
const POINTER_FILE = 'data-location.json'

function exists (p) {
  try { fs.accessSync(p); return true } catch { return false }
}

async function readPointer (configBase) {
  try {
    const { dir } = JSON.parse(await fsp.readFile(path.join(configBase, POINTER_FILE), 'utf8'))
    if (typeof dir === 'string' && path.isAbsolute(dir)) return path.resolve(dir)
  } catch {}
  return null
}

async function resolveDataDir (configBase) {
  return (await readPointer(configBase)) || configBase
}

async function writePointer (configBase, dir) {
  const file = path.join(configBase, POINTER_FILE)
  if (samePath(dir, configBase)) {
    await fsp.rm(file, { force: true })
    return
  }
  await fsp.mkdir(configBase, { recursive: true })
  await fsp.writeFile(file, JSON.stringify({ dir }, null, 2))
}

// 윈도우는 대소문자 구분 없음
const norm = p => {
  const r = path.resolve(p)
  return process.platform === 'win32' ? r.toLowerCase() : r
}
const samePath = (a, b) => norm(a) === norm(b)
function isInside (child, parent) {
  const rel = path.relative(norm(parent), norm(child))
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function isGameFolder (dir) {
  return exists(path.join(dir, 'state.json')) || exists(path.join(dir, 'instance'))
}

// 유저가 고른 폴더 → 실제 게임 파일 폴더.
// 이미 게임 파일 폴더면 그대로, 아니면 그 안에 <dataFolderName> 하위 폴더를 만든다 (D:\ 를 골라도 D:\ 바로 아래에 흩뿌리지 않게).
function targetFromPicked (picked, dataFolderName) {
  const p = path.resolve(picked)
  if (isGameFolder(p) || path.basename(p).toLowerCase() === dataFolderName.toLowerCase()) return p
  return path.join(p, dataFolderName)
}

// 바꿀 수 없는 위치면 이유(문장), 괜찮으면 null
function checkTarget ({ target, current, installDir }) {
  if (samePath(target, current)) return '지금 쓰는 위치와 같습니다.'
  if (installDir && (samePath(target, installDir) || isInside(target, installDir))) {
    return '런처 설치 폴더 안에는 둘 수 없습니다. 런처를 업데이트할 때 설치 폴더가 통째로 지워집니다.'
  }
  if (installDir && isInside(installDir, target)) return '런처 설치 폴더를 품은 폴더에는 둘 수 없습니다.'
  if (isInside(target, current)) return '지금 게임 파일 폴더 안으로는 옮길 수 없습니다.'
  if (isInside(current, target) && !isGameFolder(target)) return '지금 게임 파일 폴더를 품은 폴더로는 옮길 수 없습니다.'
  if (!exists(path.parse(target).root)) return `${path.parse(target).root} 드라이브를 찾을 수 없습니다.`
  return null
}

// 'switch' = 고른 곳에 이미 게임 파일이 있어 위치만 바꿈 · 'move' = 지금 파일을 옮김 · 'empty' = 옮길 게 없음
function planChange ({ target, current }) {
  if (isGameFolder(target)) return 'switch'
  return DATA_ENTRIES.some(e => exists(path.join(current, e))) ? 'move' : 'empty'
}

async function walk (p, out) {
  const st = await fsp.lstat(p)
  if (st.isDirectory()) {
    out.dirs.push(p)
    for (const name of await fsp.readdir(p)) await walk(path.join(p, name), out)
  } else if (st.isFile()) {
    out.files.push({ p, size: st.size })
    out.bytes += st.size
  }
  return out
}

/**
 * current 의 게임 파일을 target 으로 옮긴다. 같은 드라이브면 이름만 바꾸고, 다른 드라이브면 복사 → 다 되면 원본 삭제.
 * 중간에 실패하면 옮긴 것을 되돌리고 오류를 던진다 (원본은 그대로).
 */
async function moveData ({ current, target, onProgress = () => {}, renameImpl = fsp.rename }) {
  const entries = DATA_ENTRIES.filter(e => exists(path.join(current, e)))
  await fsp.mkdir(target, { recursive: true })
  for (const e of entries) {
    if (exists(path.join(target, e))) throw new Error(`옮길 곳에 이미 ${e} 가 있습니다: ${target}`)
  }

  const renamed = []
  const toCopy = []
  const copied = []
  async function rollback () {
    for (const e of renamed) await renameImpl(path.join(target, e), path.join(current, e)).catch(() => {})
    for (const e of copied) await fsp.rm(path.join(target, e), { recursive: true, force: true }).catch(() => {})
  }

  for (const e of entries) {
    try {
      await renameImpl(path.join(current, e), path.join(target, e))
      renamed.push(e)
    } catch (err) {
      if (err.code !== 'EXDEV' && err.code !== 'EPERM') {
        await rollback()
        throw err
      }
      toCopy.push(e)
    }
  }

  if (toCopy.length) {
    onProgress({ phase: 'move', text: '옮길 파일 세는 중...' })
    const lists = []
    let total = 0
    for (const e of toCopy) {
      const sub = await walk(path.join(current, e), { dirs: [], files: [], bytes: 0 })
      lists.push([e, sub])
      total += sub.bytes
    }
    let done = 0
    let lastSent = 0
    try {
      for (const [e, sub] of lists) {
        copied.push(e)
        for (const d of sub.dirs) await fsp.mkdir(path.join(target, path.relative(current, d)), { recursive: true })
        for (const f of sub.files) {
          const to = path.join(target, path.relative(current, f.p))
          await fsp.mkdir(path.dirname(to), { recursive: true })
          await fsp.copyFile(f.p, to)
          done += f.size
          if (done - lastSent > 8 * 1024 * 1024 || done === total) {
            lastSent = done
            onProgress({ phase: 'move', current: done, total })
          }
        }
      }
    } catch (err) {
      await rollback()
      throw new Error(`게임 파일을 옮기지 못했습니다 (${err.code || err.message}). 원래 위치의 파일은 그대로입니다.`)
    }
  }
  return { entries, copied: toCopy }
}

// 다른 드라이브로 복사한 원본 지우기 (위치 기록을 바꾼 뒤에 부름). 비어 버린 옛 폴더도 지움 (기본 위치 제외).
async function removeOld ({ current, copied, configBase }) {
  for (const e of copied) await fsp.rm(path.join(current, e), { recursive: true, force: true }).catch(() => {})
  if (!samePath(current, configBase)) {
    try {
      if (!(await fsp.readdir(current)).length) await fsp.rmdir(current)
    } catch {}
  }
}

module.exports = {
  DATA_ENTRIES,
  POINTER_FILE,
  readPointer,
  resolveDataDir,
  writePointer,
  targetFromPicked,
  checkTarget,
  planChange,
  moveData,
  removeOld,
  samePath,
  isInside
}
