'use strict'

// 맵 패치: 관리자가 싱글 월드에서 만든 차원(예: 도시 전용 차원)을 서버 월드의 같은 차원으로 통째로 교체한다.
//
// pack.config.json:
//   "maps": [{ "world": "도시개발", "dimension": "kubejsrpg:city", "version": 1 }]
//     world     = 인스턴스 saves 폴더 안의 싱글 월드 폴더 이름
//     dimension = 차원 id (메인 오버월드는 안 됨: 플레이어 진행이 다 날아가므로)
//     version   = 올리면 서버가 교체한다. 그대로면 다시 올리지도, 교체하지도 않는다
//
// - 차원 파일은 서버 패키지 안에만, 암호화해서 올라간다 (친구들에게 안 감)
// - 서버는 버전이 바뀌었을 때만 교체하고, 원래 차원 폴더는 .update-backup/<시각>/maps/ 로 옮겨 둔다
//   (서버시작.bat 은 그 전에 월드 백업도 한다)

const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')

const MAP_SUBDIRS = ['region', 'entities', 'poi', 'data']
const STATE_FILE = '.map-state.json'

// 차원 id → 월드 폴더 안 경로
function dimensionRelPath (dimension) {
  const m = String(dimension || '').match(/^([a-z0-9_.-]+):([a-z0-9_./-]+)$/)
  if (!m || m[2].split('/').some(s => !s || s === '.' || s === '..')) throw new Error(`차원 id 형식이 잘못되었습니다: ${dimension} (예: kubejsrpg:city)`)
  if (dimension === 'minecraft:overworld') throw new Error('메인 오버월드(minecraft:overworld)는 맵 패치로 바꿀 수 없습니다 (플레이어 진행이 모두 덮어씌워짐)')
  if (dimension === 'minecraft:the_nether') return 'DIM-1'
  if (dimension === 'minecraft:the_end') return 'DIM1'
  return `dimensions/${m[1]}/${m[2]}`
}

function validateMapConfig (m) {
  if (!m || typeof m.world !== 'string' || !m.world || /[\\/]|\.\./.test(m.world)) throw new Error(`maps[].world 는 saves 안 월드 폴더 이름이어야 합니다: ${JSON.stringify(m && m.world)}`)
  dimensionRelPath(m.dimension)
  if (!Number.isInteger(m.version) || m.version < 1) throw new Error(`maps[].version 은 1 이상의 정수여야 합니다 (${m.dimension})`)
}

// 게임이 월드를 열고 있으면 session.lock 을 잠근다 (윈도우에서는 읽기도 막힘)
function isWorldOpen (worldDir) {
  try {
    fs.readFileSync(path.join(worldDir, 'session.lock'))
    return false
  } catch (e) {
    return e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES'
  }
}

async function walk (abs, rel, out) {
  let entries
  try { entries = await fsp.readdir(abs, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (e.name === 'session.lock' || e.name.endsWith('.tmp')) continue
    const a = path.join(abs, e.name)
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) await walk(a, r, out)
    else if (e.isFile()) out.push({ path: r, abs: a })
  }
}

// 차원 폴더의 파일 목록 (경로는 차원 폴더 기준)
async function collectDimensionFiles (worldDir, dimension) {
  const dimDir = path.join(worldDir, ...dimensionRelPath(dimension).split('/'))
  const out = []
  for (const sub of MAP_SUBDIRS) await walk(path.join(dimDir, sub), sub, out)
  return { dimDir, files: out }
}

async function readState (serverDir) {
  try { return JSON.parse(await fsp.readFile(path.join(serverDir, STATE_FILE), 'utf8')) } catch { return {} }
}

/**
 * 서버: 매니페스트의 maps 중 새 버전인 것만 교체한다.
 * @returns {Promise<Array<{dimension, version, fileCount, applied}>>}
 */
async function applyMaps ({ serverDir, manifest, manifestUrl, levelName, decrypt, check = false, now = new Date(), log = () => {}, downloadVerified, extractFromBundle }) {
  const maps = manifest.maps || []
  if (!maps.length) return []
  const state = await readState(serverDir)
  const results = []
  for (const m of maps) {
    const rel = dimensionRelPath(m.dimension)
    const target = path.join(serverDir, levelName, ...rel.split('/'))
    const need = state[m.dimension] !== m.version || !fs.existsSync(target)
    results.push({ dimension: m.dimension, version: m.version, fileCount: m.files.length, applied: need && !check, pending: need })
    if (!need || check) continue

    log(`맵 교체: ${m.dimension} v${m.version} (파일 ${m.files.length}개)`)
    const incoming = `${target}.incoming`
    await fsp.rm(incoming, { recursive: true, force: true })
    await fsp.mkdir(incoming, { recursive: true })
    const tmpDir = path.join(serverDir, '.launcher-tmp', 'maps')
    try {
      for (const b of (manifest.bundles || []).filter(b => m.files.some(f => f.bundle === b.id))) {
        const zipFile = path.join(tmpDir, `${b.sha1}.bin`)
        const url = new URL(b.url, manifestUrl).toString()
        try {
          await downloadVerified({ url, dest: zipFile, sha1: b.sha1, size: b.size })
        } catch (e) {
          throw new Error(`${e.message} — 맵 묶음 ${b.id} (${url.split('/').slice(-2).join('/')})`)
        }
        let buf = await fsp.readFile(zipFile)
        if (b.enc) buf = decrypt(buf)
        await extractFromBundle(buf, m.files.filter(f => f.bundle === b.id), incoming, async () => {})
        await fsp.rm(zipFile, { force: true })
      }
    } catch (e) {
      await fsp.rm(incoming, { recursive: true, force: true })
      throw e
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true })
    }
    // 원래 차원은 지우지 않고 옆으로 옮겨 둔다 (같은 드라이브라 순식간)
    if (fs.existsSync(target)) {
      const stamp = now.toISOString().replace(/[:.]/g, '-')
      const aside = path.join(serverDir, '.update-backup', stamp, 'maps', levelName, ...rel.split('/'))
      await fsp.mkdir(path.dirname(aside), { recursive: true })
      await fsp.rename(target, aside)
      log(`  원래 차원은 여기로 옮겨 뒀습니다: ${path.relative(serverDir, aside)}`)
    }
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.rename(incoming, target)
    state[m.dimension] = m.version
    await fsp.writeFile(path.join(serverDir, STATE_FILE), JSON.stringify(state, null, 2))
  }
  return results
}

module.exports = { dimensionRelPath, validateMapConfig, isWorldOpen, collectDimensionFiles, applyMaps, MAP_SUBDIRS }
