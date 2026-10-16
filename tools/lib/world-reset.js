'use strict'

// 맵 초기화 — 오버월드 · 네더 · 엔드에서 **점유한 청크만 남기고** 나머지 청크를 지운다.
// 지운 청크는 누가 가면 같은 시드로 새로 생긴다(지형 · 광물 · 구조물 · 상자 원상복구).
// 남기는 청크는 region 파일 안 압축 데이터를 바이트 그대로 옮긴다(블록 · 상자 · 상자 안 아이템 · 엔티티 · poi).
//
// 남기는 것
//   · FTB Chunks 점유(world/ftbchunks/*.snbt — 팀마다 한 파일)
//   · 바닐라 /forceload 청크(<차원>/data/chunks.dat)
//   · 시련의 탑 수정구 자리(kubejs_persistent_data.nbt rpgTowerOrbs — 운영자가 놓은 입구)
// 같이 고치는 것 (지운 땅 좌표를 기억하는 기록 — 안 고치면 새 땅에서 옛 기록이 살아난다)
//   · kubejs_persistent_data.nbt: rpgFarmGuardChunks(팜 판정 — 새 땅 몹 스폰이 막힘) · rpgClaimGuardPlaced(남이 지은 블록 — 새 땅 점유가 막힘)
//     rpgLifeOre · rpgGoldPlaced(놓은 광석 · 작물 — 새로 생긴 광석이 '놓은 것'으로 보임) · rpgStationMarks(모루 이름표)
//     rpgDungeonReturns · rpgDungeonRuns 의 돌아갈 자리(끊긴 던전 판)
//   · playerdata: 지운 땅에서 접속을 끊은 사람 → 월드 스폰으로(새 지형 속에 끼지 않게) · 대륙 들어가기 전 자리(rpgContRet)가 지운 땅이면 지움(→ 월드 스폰)
//   · level.dat: 엔드 가운데 섬을 지우면 드래곤 싸움 기록(DragonFight)을 지운다 → 드래곤 · 출구 포탈 · 관문이 처음처럼 다시 생긴다
// 대륙 · 던전 · 스폰 같은 kubejs 차원과 그 밖의 월드 데이터는 건드리지 않는다.

const fs = require('node:fs')
const path = require('node:path')
const nbt = require('./nbt')

const DIMS = [
  { id: 'minecraft:overworld', dir: '', label: '오버월드' },
  { id: 'minecraft:the_nether', dir: 'DIM-1', label: '네더' },
  { id: 'minecraft:the_end', dir: 'DIM1', label: '엔드' }
]
const RESET_DIMS = new Set(DIMS.map(d => d.id))
const PARTS = ['region', 'entities', 'poi']
const SECTOR = 4096
const HEADER = SECTOR * 2

const ck = (cx, cz) => `${cx},${cz}`
const chunkOf = v => Math.floor(Number(v)) >> 4

// ── 남길 청크 ────────────────────────────────────────────

// FTB Chunks 팀 파일(SNBT) 의 chunks: { "차원": [ { x: 1, z: 2, ... } ... ] }
function parseFtbClaims (text) {
  const out = []
  const m = /\bchunks\s*:\s*\{/.exec(text)
  if (!m) return out
  let depth = 0
  let end = -1
  let inStr = false
  for (let j = m.index + m[0].length - 1; j < text.length; j++) {
    const c = text[j]
    if (inStr) { if (c === '\\') j++; else if (c === '"') inStr = false; continue }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') { if (--depth === 0) { end = j; break } }
  }
  const body = text.slice(m.index + m[0].length, end < 0 ? text.length : end)
  const dimRe = /"?([a-z0-9_.-]+:[a-z0-9_./-]+)"?\s*:\s*\[([^\]]*)\]/g
  let d
  while ((d = dimRe.exec(body))) {
    const entryRe = /\{([^}]*)\}/g
    let e
    while ((e = entryRe.exec(d[2]))) {
      const x = /\bx\s*:\s*(-?\d+)/.exec(e[1])
      const z = /\bz\s*:\s*(-?\d+)/.exec(e[1])
      if (x && z) out.push({ dim: d[1], cx: Number(x[1]), cz: Number(z[1]) })
    }
  }
  return out
}

function readNbtIfExists (file) {
  try { return nbt.readFile(fs.readFileSync(file)) } catch (e) { if (e.code === 'ENOENT') return null; throw new Error(`${file} 을 읽지 못했습니다: ${e.message}`) }
}

function collectKeep (worldAbs, persistent) {
  const keep = new Map(DIMS.map(d => [d.id, new Set()]))
  const sources = { claims: 0, teams: 0, forced: 0, orbs: 0 }
  const add = (dim, cx, cz) => { if (keep.has(dim)) keep.get(dim).add(ck(cx, cz)) }

  const ftbDir = path.join(worldAbs, 'ftbchunks')
  let files = []
  try { files = fs.readdirSync(ftbDir).filter(f => f.endsWith('.snbt')) } catch {}
  for (const f of files) {
    const claims = parseFtbClaims(fs.readFileSync(path.join(ftbDir, f), 'utf8'))
    let n = 0
    for (const c of claims) { if (keep.has(c.dim)) { add(c.dim, c.cx, c.cz); n++ } }
    if (n) { sources.teams++; sources.claims += n }
  }

  for (const d of DIMS) {
    const root = readNbtIfExists(path.join(worldAbs, d.dir, 'data', 'chunks.dat'))
    const forced = root && nbt.get(root, 'data', 'Forced')
    for (const v of (forced && forced.value) || []) {
      const big = BigInt.asUintN(64, BigInt(v))
      const cx = Number(BigInt.asIntN(32, big & 0xFFFFFFFFn))
      const cz = Number(BigInt.asIntN(32, big >> 32n))
      add(d.id, cx, cz); sources.forced++
    }
  }

  const orbs = persistent && persistent.value.get('rpgTowerOrbs')
  if (orbs && orbs.type === nbt.T.STRING && orbs.value) {
    for (const part of orbs.value.split(';')) {
      const p = part.split('|')
      if (p.length >= 4 && keep.has(p[0])) { add(p[0], chunkOf(p[1]), chunkOf(p[3])); sources.orbs++ }
    }
  }
  return { keep, sources }
}

// ── region 파일 ─────────────────────────────────────────

function regionCoords (name) {
  const m = /^r\.(-?\d+)\.(-?\d+)\.mca$/.exec(name)
  return m ? { rx: Number(m[1]), rz: Number(m[2]) } : null
}

// 헤더만 읽어 들어 있는 청크 목록
function readHeader (file) {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    if (size < HEADER) return { size, entries: [] }
    const buf = Buffer.alloc(HEADER)
    fs.readSync(fd, buf, 0, HEADER, 0)
    const entries = []
    for (let i = 0; i < 1024; i++) {
      const loc = buf.readUInt32BE(i * 4)
      if (loc === 0) continue
      entries.push({ index: i, offset: loc >>> 8, sectors: loc & 0xFF, timestamp: buf.readUInt32BE(SECTOR + i * 4) })
    }
    return { size, entries }
  } finally {
    fs.closeSync(fd)
  }
}

function planRegionDir (dirAbs, dimId, keepSet) {
  const files = []
  let names = []
  try { names = fs.readdirSync(dirAbs) } catch { return files }
  for (const name of names.sort()) {
    const rc = regionCoords(name)
    if (!rc) continue
    const abs = path.join(dirAbs, name)
    const { entries } = readHeader(abs)
    const kept = []
    const dropped = []
    for (const e of entries) {
      const cx = rc.rx * 32 + (e.index & 31)
      const cz = rc.rz * 32 + (e.index >> 5)
      ;(keepSet.has(ck(cx, cz)) ? kept : dropped).push({ ...e, cx, cz })
    }
    const action = !dropped.length ? 'keep' : (kept.length ? 'rewrite' : 'delete')
    files.push({ abs, name, dim: dimId, action, kept, dropped })
  }
  return files
}

// 남길 청크만 담은 새 region 파일. 큰 청크(.mcc 외부 파일)는 헤더만 옮기고 파일은 그대로 둔다.
function buildRegion (buf, kept, warn) {
  const parts = [Buffer.alloc(HEADER)]
  const header = parts[0]
  let sector = 2
  for (const e of kept.slice().sort((a, b) => a.index - b.index)) {
    const off = e.offset * SECTOR
    if (e.offset < 2 || off + 5 > buf.length) { warn(`청크 ${e.cx},${e.cz} 자리가 파일 밖이라 옮기지 못했습니다(이미 깨진 청크 — 게임도 새로 만듭니다)`); continue }
    const len = buf.readUInt32BE(off)
    if (len < 1 || off + 4 + len > buf.length) { warn(`청크 ${e.cx},${e.cz} 길이가 잘못돼 옮기지 못했습니다(이미 깨진 청크 — 게임도 새로 만듭니다)`); continue }
    const count = Math.ceil((4 + len) / SECTOR)
    const chunk = Buffer.alloc(count * SECTOR)
    buf.copy(chunk, 0, off, off + 4 + len)
    header.writeUInt32BE(((sector << 8) | count) >>> 0, e.index * 4)
    header.writeUInt32BE(e.timestamp >>> 0, SECTOR + e.index * 4)
    parts.push(chunk)
    sector += count
  }
  return Buffer.concat(parts)
}

function writeAtomic (file, data) {
  const tmp = `${file}.reset.tmp`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

// ── 좌표 기록 정리 ───────────────────────────────────────

function makeGone (keep) {
  return (dim, x, z) => RESET_DIMS.has(String(dim)) && !keep.get(String(dim)).has(ck(chunkOf(x), chunkOf(z)))
}
const goneChunk = (keep, dim, cx, cz) => RESET_DIMS.has(dim) && !keep.get(dim).has(ck(cx, cz))

function jsonOf (tag) {
  if (!tag || tag.type !== nbt.T.STRING || !tag.value) return null
  try { return JSON.parse(tag.value) } catch { return null }
}

// kubejs_persistent_data.nbt 안 기록을 고친다(root 를 직접 바꾼다) → 고친 수
function prunePersistent (root, keep) {
  const gone = makeGone(keep)
  const out = {}
  const count = (k, n) => { if (n) out[k] = (out[k] || 0) + n }
  const v = root.value

  for (const key of ['rpgFarmGuardChunks', 'rpgClaimGuardPlaced']) {           // 키 = 차원;청크x;청크z
    const t = v.get(key)
    if (!t || t.type !== nbt.T.COMPOUND) continue
    for (const k of [...t.value.keys()]) {
      const m = /^(.+);(-?\d+);(-?\d+)$/.exec(k)
      if (m && goneChunk(keep, m[1], Number(m[2]), Number(m[3]))) { t.value.delete(k); count(key, 1) }
    }
  }
  for (const [key, sep] of [['rpgLifeOre', ' '], ['rpgGoldPlaced', '|']]) {     // 키 = 차원 x y z
    const t = v.get(key)
    if (!t || t.type !== nbt.T.COMPOUND) continue
    for (const k of [...t.value.keys()]) {
      const p = k.split(sep)
      if (p.length === 4 && gone(p[0], p[1], p[3])) { t.value.delete(k); count(key, 1) }
    }
  }
  const setJson = (key, obj) => { v.get(key).value = JSON.stringify(obj) }

  const marks = jsonOf(v.get('rpgStationMarks'))                               // { 차원: { "x,y,z": 1 } }
  if (marks) {
    let n = 0
    for (const dim of Object.keys(marks)) {
      for (const pos of Object.keys(marks[dim] || {})) {
        const p = pos.split(',')
        if (p.length === 3 && gone(dim, p[0], p[2])) { delete marks[dim][pos]; n++ }
      }
    }
    if (n) { setJson('rpgStationMarks', marks); count('rpgStationMarks', n) }
  }
  const ptGone = pt => pt && typeof pt === 'object' && gone(pt.dim, pt.x, pt.z)
  const rets = jsonOf(v.get('rpgDungeonReturns'))                              // { 사람: {dim,x,y,z} }
  if (rets) {
    let n = 0
    for (const k of Object.keys(rets)) if (ptGone(rets[k])) { delete rets[k]; n++ }
    if (n) { setJson('rpgDungeonReturns', rets); count('rpgDungeonReturns', n) }
  }
  const runs = jsonOf(v.get('rpgDungeonRuns'))                                 // { 판: { rp: { 사람: {dim,x,y,z} } } }
  if (runs) {
    let n = 0
    for (const id of Object.keys(runs)) {
      const rp = runs[id] && runs[id].rp
      if (!rp || typeof rp !== 'object') continue
      for (const k of Object.keys(rp)) if (ptGone(rp[k])) { delete rp[k]; n++ }
    }
    if (n) { setJson('rpgDungeonRuns', runs); count('rpgDungeonRuns', n) }
  }
  return out
}

function spawnOf (level) {
  const g = k => { const t = nbt.get(level, 'Data', k); return t ? Number(t.value) : 0 }
  return { x: g('SpawnX') + 0.5, y: g('SpawnY'), z: g('SpawnZ') + 0.5 }
}

function setPos (tag, sp) {
  const pos = nbt.get(tag, 'Pos')
  if (pos && pos.type === nbt.T.LIST) pos.value = { elem: nbt.T.DOUBLE, items: [sp.x, sp.y, sp.z].map(n => ({ type: nbt.T.DOUBLE, value: n })) }
  const fall = nbt.get(tag, 'FallDistance')
  if (fall) fall.value = 0
}

// 플레이어 태그 하나 → { moved, contRet } (태그를 직접 바꾼다)
function fixPlayer (tag, keep, spawn) {
  const gone = makeGone(keep)
  const r = { moved: false, contRet: false }
  const dim = nbt.get(tag, 'Dimension')
  const pos = nbt.get(tag, 'Pos')
  const xyz = pos && pos.value.items.length === 3 ? pos.value.items.map(i => i.value) : null
  const atSpawn = xyz && dim && dim.value === 'minecraft:overworld' && xyz[0] === spawn.x && xyz[1] === spawn.y && xyz[2] === spawn.z
  if (dim && xyz && !atSpawn && gone(dim.value, xyz[0], xyz[2])) {
    dim.value = 'minecraft:overworld'
    setPos(tag, spawn)
    const ride = nbt.get(tag, 'RootVehicle', 'Entity')                          // 타고 있던 탈것도 같이
    if (ride) setPos(ride, spawn)
    r.moved = true
  }
  const kj = nbt.get(tag, 'KubeJSPersistentData')
  const ret = kj && kj.value.get('rpgContRet')
  if (ret && ret.type === nbt.T.STRING) {
    let pt = null
    try { pt = JSON.parse(ret.value) } catch {}
    if (pt && gone(pt.dim, pt.x, pt.z)) { kj.value.delete('rpgContRet'); r.contRet = true }
  }
  return r
}

// ── 계획 · 적용 ─────────────────────────────────────────

function planReset (worldAbs) {
  if (!fs.existsSync(path.join(worldAbs, 'level.dat'))) throw new Error(`월드가 아닙니다 (level.dat 없음): ${worldAbs}`)
  const persistentFile = path.join(worldAbs, 'kubejs_persistent_data.nbt')
  const persistent = readNbtIfExists(persistentFile)
  const { keep, sources } = collectKeep(worldAbs, persistent)

  const dims = DIMS.map(d => {
    const files = []
    for (const part of PARTS) for (const f of planRegionDir(path.join(worldAbs, d.dir, part), d.id, keep.get(d.id))) files.push({ ...f, part })
    const region = files.filter(f => f.part === 'region')
    return {
      ...d,
      keepCount: keep.get(d.id).size,
      chunks: region.reduce((n, f) => n + f.kept.length + f.dropped.length, 0),
      keptChunks: region.reduce((n, f) => n + f.kept.length, 0),
      files
    }
  })

  const level = nbt.readFile(fs.readFileSync(path.join(worldAbs, 'level.dat')))
  const spawn = spawnOf(level)
  const records = persistent ? prunePersistent(nbt.readFile(fs.readFileSync(persistentFile)), keep) : {}

  const players = []
  const pdDir = path.join(worldAbs, 'playerdata')
  let pds = []
  try { pds = fs.readdirSync(pdDir).filter(f => f.endsWith('.dat')) } catch {}
  for (const f of pds) {
    let tag
    try { tag = nbt.readFile(fs.readFileSync(path.join(pdDir, f))) } catch { continue }
    const r = fixPlayer(tag, keep, spawn)
    if (r.moved || r.contRet) players.push({ file: f, uuid: f.replace(/\.dat$/, ''), ...r })
  }
  const sp = nbt.get(level, 'Data', 'Player')                                   // 싱글 월드는 플레이어가 level.dat 안에
  const singleMoved = sp ? fixPlayer(sp, keep, spawn) : { moved: false, contRet: false }

  // 출구 포탈(0,0 둘레) 청크를 실제로 지울 때만 — 엔드에 아무도 안 갔으면 기록이 처음 그대로라 손댈 것이 없다
  const CENTER = new Set([ck(-1, -1), ck(-1, 0), ck(0, -1), ck(0, 0)])
  const endFiles = dims.find(d => d.id === 'minecraft:the_end').files.filter(f => f.part === 'region')
  const endCenterGone = endFiles.some(f => f.dropped.some(c => CENTER.has(ck(c.cx, c.cz))))
  const dragonReset = endCenterGone && !!nbt.get(level, 'Data', 'DragonFight')

  return { worldAbs, keep, sources, dims, spawn, records, players, singleMoved, dragonReset, claimCount: sources.claims }
}

function describePlan (plan) {
  const L = []
  const s = plan.sources
  L.push(`남길 청크: FTB 점유 ${s.claims}개(팀 ${s.teams}) · /forceload ${s.forced}개 · 시련의 탑 수정구 ${s.orbs}곳`)
  for (const d of plan.dims) {
    const byAction = a => d.files.filter(f => f.action === a).length
    L.push(`  ${d.label}: 만들어진 청크 ${d.chunks}개 중 ${d.keptChunks}개 남김 · ${d.chunks - d.keptChunks}개 지움` +
      `  (region · entities · poi 파일: 고쳐 씀 ${byAction('rewrite')} · 통째로 지움 ${byAction('delete')} · 그대로 ${byAction('keep')})`)
  }
  const rec = Object.entries(plan.records)
  L.push(rec.length ? `지운 땅의 좌표 기록 정리: ${rec.map(([k, n]) => `${k} ${n}`).join(' · ')}` : '지운 땅의 좌표 기록: 없음')
  const moved = plan.players.filter(p => p.moved).length + (plan.singleMoved.moved ? 1 : 0)
  const ret = plan.players.filter(p => p.contRet).length + (plan.singleMoved.contRet ? 1 : 0)
  L.push(`지운 땅에서 접속을 끊은 사람: ${moved}명 → 월드 스폰(${Math.floor(plan.spawn.x)}, ${plan.spawn.y}, ${Math.floor(plan.spawn.z)})으로` +
    (ret ? ` · 대륙에서 돌아갈 자리가 지운 땅인 사람 ${ret}명 → 월드 스폰으로` : ''))
  L.push(plan.dragonReset ? '엔드 가운데 섬을 지웁니다 → 엔더 드래곤 · 출구 포탈 · 관문이 처음처럼 다시 생깁니다' : '엔드 드래곤 기록: 그대로')
  return L
}

function applyReset (plan, { log = () => {} } = {}) {
  const warnings = []
  const warn = m => { warnings.push(m); log(`  ! ${m}`) }
  let rewritten = 0
  let deleted = 0
  let mcc = 0
  for (const d of plan.dims) {
    for (const f of d.files) {
      if (f.action === 'keep') continue
      if (f.action === 'rewrite') { writeAtomic(f.abs, buildRegion(fs.readFileSync(f.abs), f.kept, warn)); rewritten++ } else { fs.unlinkSync(f.abs); deleted++ }
      for (const c of f.dropped) {                                              // 지운 청크의 큰 청크 파일
        const ext = path.join(path.dirname(f.abs), `c.${c.cx}.${c.cz}.mcc`)
        if (fs.existsSync(ext)) { fs.unlinkSync(ext); mcc++ }
      }
    }
    log(`  ${d.label}: ${d.keptChunks}개 남기고 ${d.chunks - d.keptChunks}개 지움`)
  }

  const persistentFile = path.join(plan.worldAbs, 'kubejs_persistent_data.nbt')
  if (Object.keys(plan.records).length) {
    const root = nbt.readFile(fs.readFileSync(persistentFile))
    prunePersistent(root, plan.keep)
    writeAtomic(persistentFile, nbt.writeFile(root))
  }

  for (const p of plan.players) {
    const file = path.join(plan.worldAbs, 'playerdata', p.file)
    const tag = nbt.readFile(fs.readFileSync(file))
    fixPlayer(tag, plan.keep, plan.spawn)
    writeAtomic(file, nbt.writeFile(tag))
  }

  if (plan.dragonReset || plan.singleMoved.moved || plan.singleMoved.contRet) {
    const file = path.join(plan.worldAbs, 'level.dat')
    const level = nbt.readFile(fs.readFileSync(file))
    if (plan.dragonReset) nbt.get(level, 'Data').value.delete('DragonFight')
    const sp = nbt.get(level, 'Data', 'Player')
    if (sp) fixPlayer(sp, plan.keep, plan.spawn)
    writeAtomic(file, nbt.writeFile(level))
  }
  return { rewritten, deleted, mcc, warnings }
}

module.exports = { planReset, describePlan, applyReset, parseFtbClaims, buildRegion, readHeader, prunePersistent, fixPlayer, DIMS }
