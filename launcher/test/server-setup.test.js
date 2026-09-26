'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const setup = require('../../tools/lib/server-setup')

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'server-setup-'))

test('필요한 자바 버전', () => {
  assert.equal(setup.requiredJava({ minecraft: '1.21.1' }), 21)
  assert.equal(setup.requiredJava({ minecraft: '1.20.1' }), 17)
  assert.equal(setup.requiredJava({ minecraft: '1.12.2' }), 8)
  assert.equal(setup.requiredJava({ minecraft: '1.21.1', java: 25 }), 25)
})

test('NeoForge 서버 설치: 공식 설치 파일 주소와 옵션, 첫 옵션이 안 되면 다음 옵션', async () => {
  const dir = tmpDir()
  try {
    const manifest = { minecraft: '1.21.1', loader: { type: 'neoforge', version: '21.1.248' } }
    const info = setup.installerInfo(manifest)
    assert.equal(info.url, 'https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.248/neoforge-21.1.248-installer.jar')
    assert.equal(setup.loaderInstalled(dir, manifest.loader), false)

    const calls = []
    await setup.installLoader({
      serverDir: dir,
      manifest,
      javaPath: 'java',
      log: () => {},
      download: async (url, dest) => { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, 'jar') },
      run: async (cmd, args) => {
        calls.push(args[2])
        if (args[2] === '--install-server') return 1 // 이 버전 설치 파일은 이 옵션을 모른다고 가정
        fs.mkdirSync(path.join(dir, 'libraries', 'net', 'neoforged', 'neoforge', '21.1.248'), { recursive: true })
        return 0
      }
    })
    assert.deepEqual(calls, ['--install-server', '--installServer'])
    assert.equal(setup.loaderInstalled(dir, manifest.loader), true)
    assert.equal(fs.existsSync(path.join(dir, '.installer')), false) // 설치 파일 정리

    await assert.rejects(setup.installLoader({
      serverDir: tmpDir(), manifest, javaPath: 'java', log: () => {},
      download: async (url, dest) => { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, 'jar') },
      run: async () => 1
    }), /설치에 실패/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('EULA 와 메모리 설정', async () => {
  const dir = tmpDir()
  try {
    assert.equal(setup.eulaAccepted(dir), false)
    fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=false\n')
    assert.equal(setup.eulaAccepted(dir), false)
    await setup.acceptEula(dir)
    assert.equal(setup.eulaAccepted(dir), true)

    // NeoForge 가 만든 user_jvm_args.txt (주석만 있음) 에 -Xmx 추가, 이미 있으면 그대로
    fs.writeFileSync(path.join(dir, 'user_jvm_args.txt'), '# Xmx and Xms set the maximum and minimum RAM usage\n# -Xmx4G\n')
    assert.equal(await setup.ensureMemory(dir, 32 * 1024), '12G')
    assert.match(fs.readFileSync(path.join(dir, 'user_jvm_args.txt'), 'utf8'), /^-Xmx12G$/m)
    assert.equal(await setup.ensureMemory(dir, 32 * 1024), null)
    const dir2 = tmpDir()
    assert.equal(await setup.ensureMemory(dir2, 8 * 1024), '4G')
    fs.rmSync(dir2, { recursive: true, force: true })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
