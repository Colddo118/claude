'use strict'

// 서버에 필요한 폴더와, 서버에 넣으면 안 되는 클라이언트 전용 모드 목록 (sync-server / 서버 패키지 공용)

const SERVER_DIRS = ['mods', 'config', 'defaultconfigs', 'kubejs', 'scripts']

// 서버에 넣으면 크래시가 나는 대표적인 클라이언트 전용 모드 (파일 이름 기준, 대소문자 무시)
const DEFAULT_CLIENT_ONLY = [
  'mods/iris*', 'mods/oculus*', 'mods/sodium*', 'mods/embeddium*', 'mods/rubidium*',
  'mods/immediatelyfast*', 'mods/dynamic*fps*', 'mods/entityculling*', 'mods/fancymenu*',
  'mods/drippyloadingscreen*', 'mods/controlling*', 'mods/mousetweaks*', 'mods/betterf3*',
  'mods/legendarytooltips*', 'mods/ambientsounds*', 'mods/notenoughanimations*',
  'mods/skinlayers3d*', 'mods/3dskinlayers*', 'mods/chat_heads*', 'mods/chat-heads*',
  'mods/catalogue*', 'mods/fpsreducer*', 'mods/distanthorizons*'
]

// 관리자가 관리하는 영역: 관리자가 바꾸면 서버에서도 바꾼다 (서버 쪽 수정이 있어도, 백업 후).
// 여기에 없는 파일 · SERVER_OWNED 에 걸린 파일은 "서버 데이터일 수 있음" 으로 보고,
// 서버가 한 번이라도 바꿨으면 절대 덮어쓰거나 지우지 않는다.
// world/dimensions: 관리자가 올린 대륙 맵. 관리자가 바꾼 region · poi 만 덮인다 (lib/map-sync.js)
// 2026-10-09: kubejs/config · kubejs/data 도 관리자 영역 — 맵 설정(town_central.json 등) · 퀘스트 · 몹 표는 관리자가 짓는 원본인데,
//   서버 기록이 없거나 어긋난 서버에서 45개가 "서버 데이터" 로 묶여 패치가 안 들어갔다(포탈이 옛 사냥터로 감).
//   서버가 실행 중에 스스로 쓰는 파일만 SERVER_OWNED 로 남긴다.
const ADMIN_MANAGED = [
  'mods', 'config', 'defaultconfigs', 'scripts',
  'kubejs/startup_scripts', 'kubejs/server_scripts', 'kubejs/client_scripts', 'kubejs/assets',
  'kubejs/config', 'kubejs/data',
  'world/dimensions'
]
// 관리자 영역 안이지만 서버가 실행 중에 쓰는 파일 — 서버 것 유지(위 보호 규칙 그대로)
//   kubejs/data/rpg 의 원장 · 시세(캔들) · 기록 = 서버가 쓰는 데이터(같은 폴더 npc_buy.json 은 관리자 설정이라 뺌) ·
//   *.generated.json = 서버가 모드 목록으로 다시 만드는 표
const SERVER_OWNED = [
  'kubejs/data/rpg/ledger*', 'kubejs/data/rpg/candles*', 'kubejs/data/rpg/telemetry*', 'kubejs/data/rpg/telemetry', 'kubejs/data/rpg/boss_kill_log.json',
  'kubejs/data/rpg/selftest_ledger.json', 'kubejs/config/*.generated.json',
  'kubejs/data/rpg/fills'   // 2026-10-12 체결 기록(rpg_exchange fillLog) — 개발 로컬 기록이 서버 폴더에 섞였다
]

function isAdminManaged (relPath) {
  const { matchesAny } = require('../../launcher/src/common/manifest')
  return matchesAny(relPath, ADMIN_MANAGED) && !matchesAny(relPath, SERVER_OWNED)
}

function clientOnlyPatterns (userConfig) {
  return [...DEFAULT_CLIENT_ONLY, ...((userConfig && userConfig.clientOnly) || [])].map(p => p.toLowerCase())
}

module.exports = { SERVER_DIRS, ADMIN_MANAGED, SERVER_OWNED, isAdminManaged, DEFAULT_CLIENT_ONLY, clientOnlyPatterns }
