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

function clientOnlyPatterns (userConfig) {
  return [...DEFAULT_CLIENT_ONLY, ...((userConfig && userConfig.clientOnly) || [])].map(p => p.toLowerCase())
}

module.exports = { SERVER_DIRS, DEFAULT_CLIENT_ONLY, clientOnlyPatterns }
