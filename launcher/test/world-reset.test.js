'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const nbt = require('../../tools/lib/nbt')
const wr = require('../../tools/lib/world-reset')

const { T } = nbt
const S = v => ({ type: T.STRING, value: v })
const I = v => ({ type: T.INT, value: v })
const D = v => ({ type: T.DOUBLE, value: v })
const C = obj => ({ type: T.COMPOUND, value: new Map(Object.entries(obj)) })
const L = (elem, items) => ({ type: T.LIST, value: { elem, items } })
const root = obj => ({ name: '', ...C(obj) })

// region 파일 하나: chunks = [{ cx, cz, data(Buffer), external }]
function makeRegion (chunks) {
  const header = Buffer.alloc(8192)
  const body = []
  let sector = 2
  for (const c of chunks) {
    const i = (c.cx & 31) + (c.cz & 31) * 32
    const payload = c.external ? Buffer.alloc(0) : c.data
    const head = Buffer.alloc(5)
    head.writeUInt32BE(payload.length + 1, 0)
    head[4] = c.external ? 0x82 : 2
    const raw = Buffer.concat([head, payload])
    const count = Math.ceil(raw.length / 4096)
    const padded = Buffer.alloc(count * 4096)
    raw.copy(padded)
    header.writeUInt32BE((sector << 8) | count, i * 4)
    header.writeUInt32BE(1000 + i, 4096 + i * 4)
    body.push(padded)
    sector += count
  }
  return Buffer.concat([header, ...body])
}

function chunkMap (file) {
  const out = new Map()
  if (!fs.existsSync(file)) return out
  const buf = fs.readFileSync(file)
  for (const e of wr.readHeader(file).entries) {
    const off = e.offset * 4096
    const len = buf.readUInt32BE(off)
    out.set(e.index, { raw: buf.subarray(off, off + 4 + len).toString('hex'), ts: e.timestamp })
  }
  return out
}

function write (dir, rel, data) {
  const p = path.join(dir, ...rel.split('/'))
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, data)
}

function makeWorld () {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'world-reset-'))
  write(w, 'level.dat', nbt.writeFile(root({ Data: C({ SpawnX: I(100), SpawnY: I(70), SpawnZ: I(-50), DragonFight: C({ DragonKilled: { type: T.BYTE, value: 1 } }) }) })))
  write(w, 'ftbchunks/team-a.snbt', `{
\tmax_claim_chunks: 4
\tchunks: {
\t\t"minecraft:overworld": [
\t\t\t{ x: 1, z: 2, time: 1L }
\t\t\t{ x: -33, z: 0, time: 1L, force_loaded: 1L }
\t\t]
\t\t"kubejs:continent": [
\t\t\t{ x: 5, z: 5, time: 1L }
\t\t]
\t}
\tmember_data: { abc: { max_claimed_chunks: 4 } }
}`)
  write(w, 'ftbchunks/team-b.snbt', '{\n\tchunks: {\n\t\t"minecraft:the_end": [\n\t\t\t{ x: 0, z: 0, time: 1L }\n\t\t]\n\t}\n}')
  // 네더 /forceload (3, -4) — ChunkPos.toLong = x & 0xffffffff | z << 32
  const forced = (BigInt(-4) << 32n) | (BigInt(3) & 0xFFFFFFFFn)
  write(w, 'DIM-1/data/chunks.dat', nbt.writeFile(root({ data: C({ Forced: { type: T.LONG_ARRAY, value: [BigInt.asIntN(64, forced)] } }) })))

  const big = Buffer.alloc(5000, 7) // 2섹터짜리 청크
  write(w, 'region/r.0.0.mca', makeRegion([
    { cx: 1, cz: 2, data: big }, // 점유 — 남김
    { cx: 2, cz: 2, data: Buffer.from('gone') },
    { cx: 3, cz: 3, external: true } // 지움 + .mcc 지움
  ]))
  write(w, 'region/c.3.3.mcc', 'external-gone')
  write(w, 'region/r.-2.0.mca', makeRegion([{ cx: -33, cz: 0, external: true }, { cx: -34, cz: 0, data: Buffer.from('x') }]))
  write(w, 'region/c.-33.0.mcc', 'external-keep')
  write(w, 'region/r.5.5.mca', makeRegion([{ cx: 160, cz: 160, data: Buffer.from('all-gone') }]))
  write(w, 'region/r.9.9.mca', Buffer.alloc(0)) // 빈 파일
  write(w, 'entities/r.0.0.mca', makeRegion([{ cx: 1, cz: 2, data: Buffer.from('ent-keep') }, { cx: 0, cz: 0, data: Buffer.from('ent-gone') }]))
  write(w, 'poi/r.0.0.mca', makeRegion([{ cx: 2, cz: 2, data: Buffer.from('poi-gone') }]))
  write(w, 'DIM-1/region/r.0.-1.mca', makeRegion([{ cx: 3, cz: -4, data: Buffer.from('nether-keep') }, { cx: 4, cz: -4, data: Buffer.from('nether-gone') }]))
  write(w, 'DIM1/region/r.-1.-1.mca', makeRegion([{ cx: -1, cz: -1, data: Buffer.from('end-center-gone') }]))
  write(w, 'DIM1/region/r.0.0.mca', makeRegion([{ cx: 0, cz: 0, data: Buffer.from('end-claimed') }]))
  write(w, 'dimensions/kubejs/continent/region/r.0.0.mca', makeRegion([{ cx: 9, cz: 9, data: Buffer.from('continent') }]))

  write(w, 'kubejs_persistent_data.nbt', nbt.writeFile(root({
    rpgFarmGuardChunks: C({ 'minecraft:overworld;1;2': S('keep'), 'minecraft:overworld;2;2': S('gone'), 'kubejs:continent;2;2': S('other-dim') }),
    rpgClaimGuardPlaced: C({ 'minecraft:the_nether;4;-4': S('gone'), 'minecraft:the_nether;3;-4': S('keep') }),
    rpgLifeOre: C({ 'minecraft:overworld 20 5 40': { type: T.BYTE, value: 1 }, 'minecraft:overworld 40 5 40': { type: T.BYTE, value: 1 } }),
    rpgGoldPlaced: C({ 'minecraft:overworld|-528|60|5': { type: T.BYTE, value: 1 }, 'minecraft:overworld|-540|60|5': { type: T.BYTE, value: 1 } }),
    rpgStationMarks: S(JSON.stringify({ 'minecraft:overworld': { '20,64,40': 1, '40,64,40': 1 }, 'kubejs:continent': { '40,64,40': 1 } })),
    rpgDungeonReturns: S(JSON.stringify({ a: { dim: 'minecraft:overworld', x: 40.5, y: 64, z: 40.5 }, b: { dim: 'minecraft:overworld', x: 20.5, y: 64, z: 40.5 } })),
    rpgDungeonRuns: S(JSON.stringify({ r1: { fee: 5, rp: { a: { dim: 'minecraft:overworld', x: 40.5, y: 64, z: 40.5 } } } })),
    rpgTowerOrbs: S('minecraft:overworld|-100|64|300|north'),
    rpgOther: S('그대로')
  })))
  write(w, 'region/r.-1.0.mca', makeRegion([{ cx: -7, cz: 18, data: Buffer.from('orb-chunk') }, { cx: -8, cz: 18, data: Buffer.from('orb-neighbor') }]))

  const player = (dim, x, z, contRet) => nbt.writeFile(root({
    Dimension: S(dim),
    Pos: L(T.DOUBLE, [D(x), D(64), D(z)]),
    FallDistance: { type: T.FLOAT, value: 3 },
    KubeJSPersistentData: C(contRet ? { rpgContRet: S(JSON.stringify(contRet)), rpgMoney: S('77') } : { rpgMoney: S('77') }),
    Inventory: L(T.COMPOUND, [C({ id: S('minecraft:diamond'), count: I(5) })])
  }))
  write(w, 'playerdata/11111111-1111-1111-1111-111111111111.dat', player('minecraft:overworld', 40.5, 40.5, { dim: 'minecraft:overworld', x: 40, y: 64, z: 40 }))
  write(w, 'playerdata/22222222-2222-2222-2222-222222222222.dat', player('minecraft:overworld', 20.5, 40.5, { dim: 'minecraft:overworld', x: 20, y: 64, z: 40 }))
  write(w, 'playerdata/33333333-3333-3333-3333-333333333333.dat', player('kubejs:continent', 40.5, 40.5, null))
  return w
}

test('NBT: 읽은 그대로 쓰면 바이트가 같다 (변형 UTF-8 · 널 · 이모지 포함)', () => {
  const r = root({ a: S('한글\u0000😀'), b: { type: T.LONG, value: -5n }, c: { type: T.LONG_ARRAY, value: [1n, -2n] }, d: L(T.END, []), e: { type: T.BYTE_ARRAY, value: [-1, 2] } })
  const buf = nbt.serialize(r)
  assert.equal(Buffer.compare(nbt.serialize(nbt.parse(buf)), buf), 0)
  assert.equal(nbt.get(nbt.parse(buf), 'a').value, '한글\u0000😀')
})

test('FTB 점유 파일 읽기', () => {
  const claims = wr.parseFtbClaims('{\n chunks: {\n "minecraft:overworld": [\n { x: -1, z: 2, time: 1L }\n { z: 4, x: 3 }\n ]\n minecraft:the_nether: [ { x: 0, z: 0 } ]\n }\n member_data: { x: { y: 1 } }\n}')
  assert.deepEqual(claims, [
    { dim: 'minecraft:overworld', cx: -1, cz: 2 },
    { dim: 'minecraft:overworld', cx: 3, cz: 4 },
    { dim: 'minecraft:the_nether', cx: 0, cz: 0 }
  ])
  assert.deepEqual(wr.parseFtbClaims('{ member_data: {} }'), [])
})

test('맵 초기화: 점유 · forceload · 수정구 청크만 바이트 그대로 남기고 나머지와 좌표 기록을 지운다', () => {
  const w = makeWorld()
  try {
    const before = name => chunkMap(path.join(w, ...name.split('/')))
    const keepOver = before('region/r.0.0.mca').get(1 + 2 * 32)
    const keepExt = before('region/r.-2.0.mca').get(31)
    const keepNether = before('DIM-1/region/r.0.-1.mca').get(3 + 28 * 32)
    const continentBefore = fs.readFileSync(path.join(w, 'dimensions/kubejs/continent/region/r.0.0.mca'))

    const plan = wr.planReset(w)
    assert.equal(plan.claimCount, 3)                    // 대륙 점유는 셈에 안 넣음
    assert.deepEqual(plan.sources, { claims: 3, teams: 2, forced: 1, orbs: 1 })
    assert.equal(plan.dragonReset, true)
    assert.deepEqual(plan.records, { rpgFarmGuardChunks: 1, rpgClaimGuardPlaced: 1, rpgLifeOre: 1, rpgGoldPlaced: 1, rpgStationMarks: 1, rpgDungeonReturns: 1, rpgDungeonRuns: 1 })
    assert.deepEqual(plan.players.map(p => [p.uuid[0], p.moved, p.contRet]), [['1', true, true]])
    assert.ok(wr.describePlan(plan).length >= 5)
    // 미리보기는 아무것도 안 바꾼다
    assert.equal(before('region/r.0.0.mca').size, 3)

    const r = wr.applyReset(plan)
    assert.deepEqual(r.warnings, [])

    // 남긴 청크: 압축 데이터 · 시각 그대로
    const over = before('region/r.0.0.mca')
    assert.deepEqual([...over.keys()], [1 + 2 * 32])
    assert.deepEqual(over.get(1 + 2 * 32), keepOver)
    assert.deepEqual(before('region/r.-2.0.mca').get(31), keepExt)
    assert.equal(before('region/r.-2.0.mca').size, 1)
    assert.equal(fs.readFileSync(path.join(w, 'region/c.-33.0.mcc'), 'utf8'), 'external-keep')
    assert.ok(!fs.existsSync(path.join(w, 'region/c.3.3.mcc')))
    assert.ok(!fs.existsSync(path.join(w, 'region/r.5.5.mca')))            // 남길 것 없는 파일은 통째로
    assert.ok(fs.existsSync(path.join(w, 'region/r.9.9.mca')))             // 빈 파일은 손대지 않음
    assert.deepEqual([...before('region/r.-1.0.mca').keys()], [(-7 & 31) + (18 & 31) * 32]) // 수정구 청크만
    assert.deepEqual([...before('entities/r.0.0.mca').keys()], [1 + 2 * 32])
    assert.ok(!fs.existsSync(path.join(w, 'poi/r.0.0.mca')))
    assert.deepEqual(before('DIM-1/region/r.0.-1.mca').get(3 + 28 * 32), keepNether)
    assert.equal(before('DIM-1/region/r.0.-1.mca').size, 1)
    assert.ok(!fs.existsSync(path.join(w, 'DIM1/region/r.-1.-1.mca')))
    assert.equal(before('DIM1/region/r.0.0.mca').size, 1)
    assert.equal(Buffer.compare(fs.readFileSync(path.join(w, 'dimensions/kubejs/continent/region/r.0.0.mca')), continentBefore), 0)

    // 좌표 기록
    const p = nbt.readFile(fs.readFileSync(path.join(w, 'kubejs_persistent_data.nbt')))
    assert.deepEqual([...nbt.get(p, 'rpgFarmGuardChunks').value.keys()], ['minecraft:overworld;1;2', 'kubejs:continent;2;2'])
    assert.deepEqual([...nbt.get(p, 'rpgClaimGuardPlaced').value.keys()], ['minecraft:the_nether;3;-4'])
    assert.deepEqual([...nbt.get(p, 'rpgLifeOre').value.keys()], ['minecraft:overworld 20 5 40'])
    assert.deepEqual([...nbt.get(p, 'rpgGoldPlaced').value.keys()], ['minecraft:overworld|-528|60|5'])
    assert.deepEqual(JSON.parse(nbt.get(p, 'rpgStationMarks').value), { 'minecraft:overworld': { '20,64,40': 1 }, 'kubejs:continent': { '40,64,40': 1 } })
    assert.deepEqual(Object.keys(JSON.parse(nbt.get(p, 'rpgDungeonReturns').value)), ['b'])
    assert.deepEqual(JSON.parse(nbt.get(p, 'rpgDungeonRuns').value), { r1: { fee: 5, rp: {} } })
    assert.equal(nbt.get(p, 'rpgOther').value, '그대로')

    // 플레이어: 지운 땅에 있던 사람만 월드 스폰으로 · 인벤토리 · 돈 그대로
    const pl = id => nbt.readFile(fs.readFileSync(path.join(w, 'playerdata', `${id.repeat(8)}-${id.repeat(4)}-${id.repeat(4)}-${id.repeat(4)}-${id.repeat(12)}.dat`)))
    const p1 = pl('1')
    assert.equal(nbt.get(p1, 'Dimension').value, 'minecraft:overworld')
    assert.deepEqual(nbt.get(p1, 'Pos').value.items.map(i => i.value), [100.5, 70, -49.5])
    assert.equal(nbt.get(p1, 'FallDistance').value, 0)
    assert.equal(nbt.get(p1, 'KubeJSPersistentData', 'rpgContRet'), null)
    assert.equal(nbt.get(p1, 'KubeJSPersistentData', 'rpgMoney').value, '77')
    assert.equal(nbt.get(p1, 'Inventory').value.items.length, 1)
    assert.deepEqual(nbt.get(pl('2'), 'Pos').value.items.map(i => i.value), [20.5, 64, 40.5])
    assert.ok(nbt.get(pl('2'), 'KubeJSPersistentData', 'rpgContRet'))
    assert.equal(nbt.get(pl('3'), 'Dimension').value, 'kubejs:continent')

    // 드래곤 기록만 빠지고 나머지 level.dat 그대로
    const lv = nbt.readFile(fs.readFileSync(path.join(w, 'level.dat')))
    assert.equal(nbt.get(lv, 'Data', 'DragonFight'), null)
    assert.equal(nbt.get(lv, 'Data', 'SpawnX').value, 100)

    // 다시 돌리면 할 일 없음
    const again = wr.planReset(w)
    assert.equal(again.dims.flatMap(d => d.files).filter(f => f.action !== 'keep').length, 0)
    assert.deepEqual(again.records, {})
    assert.equal(again.players.length, 0)
    assert.equal(again.dragonReset, false)
  } finally {
    fs.rmSync(w, { recursive: true, force: true })
  }
})

test('맵 초기화: 엔드에 아무도 안 갔으면 드래곤 기록은 그대로', () => {
  const w = makeWorld()
  try {
    fs.rmSync(path.join(w, 'DIM1'), { recursive: true })
    const plan = wr.planReset(w)
    assert.equal(plan.dragonReset, false)
  } finally {
    fs.rmSync(w, { recursive: true, force: true })
  }
})
