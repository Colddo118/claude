'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { ensureServer, listServers, readNbt, writeNbt, T } = require('../src/main/servers-dat')

const entry = (name, ip, extra = []) => new Map([['name', { t: T.STRING, v: name }], ['ip', { t: T.STRING, v: ip }], ...extra])
const serversFile = items => writeNbt({ name: '', root: new Map([['servers', { t: T.LIST, v: { et: T.COMPOUND, items } }]]) })

test('서버 목록: 없으면 새로 만들고, 있으면 맨 위에 추가, 이미 있으면 그대로', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servers-dat-'))
  const file = path.join(dir, 'servers.dat')
  try {
    // 파일이 없으면 우리 서버만 있는 목록을 만든다
    assert.equal(await ensureServer(dir, { name: 'KubejsRPG', address: 'kubejsrpg.p-e.kr' }), 'created')
    assert.deepEqual(listServers(readNbt(fs.readFileSync(file))), [{ name: 'KubejsRPG', ip: 'kubejsrpg.p-e.kr' }])

    // 사용자가 추가한 서버(아이콘·한글 이름 등)는 순서·내용 그대로, 우리 서버는 맨 위에
    const icon = { t: T.STRING, v: 'iVBORw0KGgo=' }
    fs.writeFileSync(file, serversFile([entry('친구 서버 😀', 'mc.example.com', [['icon', icon], ['acceptTextures', { t: T.BYTE, v: 1 }]]), entry('야생', '1.2.3.4:25570')]))
    assert.equal(await ensureServer(dir, { name: 'KubejsRPG', address: 'kubejsrpg.p-e.kr' }), 'added')
    const nbt = readNbt(fs.readFileSync(file))
    assert.deepEqual(listServers(nbt), [
      { name: 'KubejsRPG', ip: 'kubejsrpg.p-e.kr' },
      { name: '친구 서버 😀', ip: 'mc.example.com' },
      { name: '야생', ip: '1.2.3.4:25570' }
    ])
    const friend = nbt.root.get('servers').v.items[1]
    assert.equal(friend.get('icon').v, 'iVBORw0KGgo=')
    assert.equal(friend.get('acceptTextures').v, 1)

    // 이미 있으면(대소문자·기본 포트 차이 무시) 파일을 건드리지 않는다
    const before = fs.readFileSync(file)
    assert.equal(await ensureServer(dir, { name: 'KubejsRPG', address: 'KubejsRPG.p-e.kr:25565' }), 'exists')
    assert.deepEqual(fs.readFileSync(file), before)

    // 이름을 바꿔 둔 경우도 주소가 같으면 그대로
    fs.writeFileSync(file, serversFile([entry('우리 서버', 'kubejsrpg.p-e.kr')]))
    assert.equal(await ensureServer(dir, { name: 'KubejsRPG', address: 'kubejsrpg.p-e.kr' }), 'exists')

    // 깨진 파일은 백업해 두고 새로 만든다
    fs.writeFileSync(file, Buffer.from('broken'))
    assert.equal(await ensureServer(dir, { name: 'KubejsRPG', address: 'kubejsrpg.p-e.kr' }), 'created')
    assert.equal(fs.readFileSync(file + '.launcher-bak', 'utf8'), 'broken')
    assert.equal(listServers(readNbt(fs.readFileSync(file))).length, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('NBT 읽고 쓰기: 모든 태그 종류가 그대로 돌아온다', () => {
  const root = new Map([
    ['b', { t: T.BYTE, v: -3 }], ['s', { t: T.SHORT, v: 1234 }], ['i', { t: T.INT, v: -99999 }],
    ['l', { t: T.LONG, v: 1234567890123n }], ['f', { t: T.FLOAT, v: 1.5 }], ['d', { t: T.DOUBLE, v: 2.25 }],
    ['ba', { t: T.BYTE_ARRAY, v: Buffer.from([1, 2, 3]) }], ['str', { t: T.STRING, v: 'a\u0000한글😀' }],
    ['ia', { t: T.INT_ARRAY, v: [1, -2] }], ['la', { t: T.LONG_ARRAY, v: [5n] }],
    ['empty', { t: T.LIST, v: { et: T.END, items: [] } }],
    ['nested', { t: T.COMPOUND, v: new Map([['x', { t: T.INT, v: 7 }]]) }]
  ])
  const back = readNbt(writeNbt({ name: 'root', root }))
  assert.equal(back.name, 'root')
  assert.deepEqual(back.root, root)
})
