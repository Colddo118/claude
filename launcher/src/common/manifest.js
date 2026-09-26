'use strict'

// 서버(tools/build-manifest.js)와 런처가 함께 쓰는 매니페스트 규칙.

const FORMAT_VERSION = 1
const FILE_MODES = ['overwrite', 'once']
const LOADER_TYPES = ['vanilla', 'forge', 'neoforge', 'fabric', 'quilt']

function hasGlobChars (pattern) {
  return /[*?]/.test(pattern)
}

function escapeRegExp (s) {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}

function globToRegExp (glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          re += '(?:.*/)?'
        } else {
          re += '.*'
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += escapeRegExp(c)
    }
  }
  return new RegExp(`^${re}$`)
}

// 글롭 문자가 없는 패턴("mods", "options.txt")은 그 파일 또는 그 폴더 전체와 일치한다.
function matchesPattern (relPath, pattern) {
  pattern = pattern.replace(/\/+$/, '')
  if (!hasGlobChars(pattern)) {
    return relPath === pattern || relPath.startsWith(pattern + '/')
  }
  return globToRegExp(pattern).test(relPath)
}

function matchesAny (relPath, patterns) {
  return (patterns || []).some(p => matchesPattern(relPath, p))
}

// 매니페스트 경로는 항상 '/' 구분자의 상대경로여야 하고 인스턴스 폴더 밖을 가리킬 수 없다.
function isSafeRelPath (p) {
  if (typeof p !== 'string' || p.length === 0) return false
  if (p.includes('\\') || p.includes('\0')) return false
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return false
  return p.split('/').every(seg => seg !== '' && seg !== '.' && seg !== '..')
}

function objectPath (sha1) {
  return `objects/${sha1.slice(0, 2)}/${sha1}`
}

// "1.20.1" / "1.2.10" / "2024.05.01-hotfix" 처럼 숫자 구간을 숫자로 비교한다.
function compareVersions (a, b) {
  const pa = String(a).split(/[.\-+]/)
  const pb = String(b).split(/[.\-+]/)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i]
    const y = pb[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x) ? Number(x) : NaN
    const ny = /^\d+$/.test(y) ? Number(y) : NaN
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx < ny ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

function validateManifest (m) {
  const fail = msg => { throw new Error(`잘못된 매니페스트: ${msg}`) }
  if (!m || typeof m !== 'object') fail('JSON 객체가 아님')
  if (m.formatVersion !== FORMAT_VERSION) fail(`지원하지 않는 formatVersion ${m.formatVersion} (런처를 업데이트하세요)`)
  if (typeof m.version !== 'string' || !m.version) fail('version 누락')
  if (typeof m.minecraft !== 'string' || !m.minecraft) fail('minecraft 버전 누락')
  if (!m.loader || !LOADER_TYPES.includes(m.loader.type)) fail(`loader.type 은 ${LOADER_TYPES.join('/')} 중 하나여야 함`)
  if (m.loader.type !== 'vanilla' && !m.loader.version) fail('loader.version 누락')
  if (!Array.isArray(m.files)) fail('files 배열 누락')
  const seen = new Set()
  for (const f of m.files) {
    if (!isSafeRelPath(f.path)) fail(`안전하지 않은 경로 ${JSON.stringify(f.path)}`)
    if (seen.has(f.path.toLowerCase())) fail(`중복 경로 ${f.path}`)
    seen.add(f.path.toLowerCase())
    if (!/^[0-9a-f]{40}$/.test(f.sha1)) fail(`${f.path}: sha1 형식 오류`)
    if (!Number.isInteger(f.size) || f.size < 0) fail(`${f.path}: size 형식 오류`)
    if (f.mode !== undefined && !FILE_MODES.includes(f.mode)) fail(`${f.path}: mode 는 ${FILE_MODES.join('/')} 중 하나`)
  }
  for (const d of m.strictDirs || []) {
    if (!isSafeRelPath(d)) fail(`안전하지 않은 strictDirs 항목 ${JSON.stringify(d)}`)
  }
  return m
}

module.exports = {
  FORMAT_VERSION,
  FILE_MODES,
  LOADER_TYPES,
  globToRegExp,
  matchesPattern,
  matchesAny,
  isSafeRelPath,
  objectPath,
  compareVersions,
  validateManifest
}
