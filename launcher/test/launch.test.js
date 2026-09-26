'use strict'

// NeoForge 1.21.1 형태의 버전 JSON 으로 실제 java 명령줄을 만들어 보고,
// NeoForge 가 요구하는 모듈 경로/ignoreList/메인 클래스와 로그인·자동접속 인자가 제대로 들어가는지 확인한다.
// (실제 파일은 공식 JSON 의 구조를 따른 축약본)

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const os = require('node:os')
const { generateArguments } = require('@xmcl/core')
const { buildLaunchOptions, requiredJavaMajor } = require('../src/main/game')

let tmp

const lib = (name, p) => ({
  name,
  downloads: { artifact: { path: p, sha1: '0'.repeat(40), size: 1, url: `https://example.invalid/${p}` } }
})

const vanilla = {
  id: '1.21.1',
  type: 'release',
  mainClass: 'net.minecraft.client.main.Main',
  assets: '17',
  assetIndex: { id: '17', sha1: '0'.repeat(40), size: 1, totalSize: 1, url: 'https://example.invalid/17.json' },
  javaVersion: { component: 'java-runtime-delta', majorVersion: 21 },
  downloads: { client: { sha1: '0'.repeat(40), size: 1, url: 'https://example.invalid/client.jar' } },
  libraries: [lib('com.mojang:logging:1.2.7', 'com/mojang/logging/1.2.7/logging-1.2.7.jar')],
  arguments: {
    game: [
      '--username', '${auth_player_name}', '--version', '${version_name}', '--gameDir', '${game_directory}',
      '--assetsDir', '${assets_root}', '--assetIndex', '${assets_index_name}', '--uuid', '${auth_uuid}',
      '--accessToken', '${auth_access_token}', '--clientId', '${clientid}', '--xuid', '${auth_xuid}',
      '--userType', '${user_type}', '--versionType', '${version_type}',
      { rules: [{ action: 'allow', features: { is_demo_user: true } }], value: '--demo' },
      { rules: [{ action: 'allow', features: { has_custom_resolution: true } }], value: ['--width', '${resolution_width}', '--height', '${resolution_height}'] }
    ],
    jvm: [
      { rules: [{ action: 'allow', os: { name: 'osx' } }], value: ['-XstartOnFirstThread'] },
      { rules: [{ action: 'allow', os: { name: 'windows' } }], value: '-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump' },
      '-Djava.library.path=${natives_directory}',
      '-Djna.tmpdir=${natives_directory}',
      '-Dminecraft.launcher.brand=${launcher_name}',
      '-Dminecraft.launcher.version=${launcher_version}',
      '-cp', '${classpath}'
    ]
  }
}

const neoforge = {
  id: 'neoforge-21.1.77',
  inheritsFrom: '1.21.1',
  type: 'release',
  mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
  libraries: [
    lib('cpw.mods:bootstraplauncher:2.0.2', 'cpw/mods/bootstraplauncher/2.0.2/bootstraplauncher-2.0.2.jar'),
    lib('cpw.mods:securejarhandler:3.0.8', 'cpw/mods/securejarhandler/3.0.8/securejarhandler-3.0.8.jar')
  ],
  arguments: {
    game: [
      '--fml.neoForgeVersion', '21.1.77', '--fml.fmlVersion', '4.0.24', '--fml.mcVersion', '1.21.1',
      '--fml.neoFormVersion', '20240808.144430', '--launchTarget', 'forgeclient'
    ],
    jvm: [
      '-Djava.net.preferIPv6Addresses=system',
      '-DignoreList=client-extra,${version_name}.jar',
      '-DlibraryDirectory=${library_directory}',
      '-p',
      '${library_directory}/cpw/mods/bootstraplauncher/2.0.2/bootstraplauncher-2.0.2.jar${classpath_separator}${library_directory}/cpw/mods/securejarhandler/3.0.8/securejarhandler-3.0.8.jar',
      '--add-modules', 'ALL-MODULE-PATH',
      '--add-opens', 'java.base/java.util.jar=cpw.mods.securejarhandler'
    ]
  }
}

before(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'launcher-launch-'))
  for (const v of [vanilla, neoforge]) {
    const dir = path.join(tmp, 'minecraft', 'versions', v.id)
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, `${v.id}.json`), JSON.stringify(v))
  }
})

after(() => fsp.rm(tmp, { recursive: true, force: true }))

async function argsFor (overrides = {}) {
  const opts = buildLaunchOptions({
    manifest: { minecraft: '1.21.1', loader: { type: 'neoforge', version: '21.1.77' }, server: { address: 'play.example.com' } },
    dirs: { instance: path.join(tmp, 'instance'), minecraft: path.join(tmp, 'minecraft') },
    authorization: { accessToken: 'TOKEN', profile: { id: 'abcdef0123456789abcdef0123456789', name: 'Steve2' }, xuid: '2535400000000000' },
    settings: { memoryMB: 6144, autoConnect: true, jvmArgs: '', ...overrides },
    launcher: { name: 'test-launcher', version: '0.1.0' },
    javaPath: '/java/bin/java',
    versionId: 'neoforge-21.1.77'
  })
  return generateArguments(opts)
}

const after1 = (args, flag) => args[args.indexOf(flag) + 1]

test('NeoForge 1.21.1 실행 인자', async () => {
  const args = await argsFor()
  const libs = path.join(tmp, 'minecraft', 'libraries')

  assert.equal(args[0], '/java/bin/java')
  assert.ok(args.includes('-Xmx6144M'))
  assert.ok(args.includes('-Xms1024M'))
  // NeoForge 모듈 경로: 라이브러리 폴더와 구분자가 치환되어야 한다
  assert.equal(after1(args, '-p'), [
    // ${library_directory} 만 OS 경로로 바뀌고 뒤쪽은 버전 JSON 의 '/' 그대로 (윈도우에서도 자바가 둘 다 받아들임)
    libs + '/cpw/mods/bootstraplauncher/2.0.2/bootstraplauncher-2.0.2.jar',
    libs + '/cpw/mods/securejarhandler/3.0.8/securejarhandler-3.0.8.jar'
  ].join(path.delimiter))
  assert.ok(args.includes(`-DlibraryDirectory=${libs}`))
  // 클래스패스에 올라가는 바닐라 jar(1.21.1.jar)가 ignoreList 에 있어야 모듈 충돌이 안 난다
  assert.ok(args.includes('-DignoreList=client-extra,1.21.1.jar'))
  assert.ok(after1(args, '-cp').endsWith(path.join('versions', '1.21.1', '1.21.1.jar')))
  assert.ok(args.includes('cpw.mods.bootstraplauncher.BootstrapLauncher'))
  // 로그인 / 로더 / 자동접속
  assert.equal(after1(args, '--username'), 'Steve2')
  assert.equal(after1(args, '--accessToken'), 'TOKEN')
  assert.equal(after1(args, '--xuid'), '2535400000000000')
  assert.equal(after1(args, '--userType'), 'msa')
  assert.equal(after1(args, '--gameDir'), path.join(tmp, 'instance'))
  assert.equal(after1(args, '--fml.neoForgeVersion'), '21.1.77')
  assert.equal(after1(args, '--quickPlayMultiplayer'), 'play.example.com')
  assert.ok(!args.includes('--demo'))
  // 치환 안 된 ${...} 가 남으면 안 된다
  assert.deepEqual(args.filter(a => a.includes('${')), [])
})

test('사용자 JVM 인자와 자동접속 끄기', async () => {
  const args = await argsFor({ jvmArgs: '-XX:+UseZGC -Dfoo=bar', autoConnect: false })
  assert.ok(args.includes('-XX:+UseZGC'))
  assert.ok(args.includes('-Dfoo=bar'))
  assert.ok(!args.includes('-Xmx2G'))
  assert.ok(!args.includes('--quickPlayMultiplayer'))
})

test('필요한 자바 버전', () => {
  assert.equal(requiredJavaMajor({}, vanilla), 21)
  assert.equal(requiredJavaMajor({ java: 17 }, vanilla), 17)
  assert.equal(requiredJavaMajor({}, { javaVersion: { majorVersion: 16 } }), 17)
  assert.equal(requiredJavaMajor({}, {}), 8)
})
