'use strict'

// 마이크로소프트 계정 로그인. 리프레시 토큰만 OS 보안 저장소(safeStorage)로
// 암호화해서 저장하고, 실행할 때마다 새 마인크래프트 토큰을 받는다.

const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const { safeStorage } = require('electron')

const ERROR_MESSAGES = {
  'error.gui.closed': '로그인 창이 닫혔습니다.',
  'error.auth.minecraft.profile': '이 계정에는 마인크래프트 자바 에디션이 없습니다.',
  'error.auth.minecraft.entitlements': '이 계정에는 마인크래프트 자바 에디션이 없습니다.',
  'error.auth.xsts.userNotFound': '이 마이크로소프트 계정에 Xbox 프로필이 없습니다. minecraft.net 에서 먼저 로그인해 주세요.',
  'error.auth.xsts.child': '미성년자 계정은 가족 그룹에 추가되어야 합니다.'
}

function friendlyError (e) {
  const code = typeof e === 'string' ? e : e && (e.ts || e.message)
  return new Error(ERROR_MESSAGES[code] || `로그인 실패: ${code || e}`)
}

class AccountStore {
  constructor (file) {
    this.file = file
    this.cached = null // { name, uuid }
  }

  async readRefreshToken () {
    try {
      const data = JSON.parse(await fsp.readFile(this.file, 'utf8'))
      this.cached = { name: data.name, uuid: data.uuid }
      const buf = Buffer.from(data.token, 'base64')
      return data.encrypted ? safeStorage.decryptString(buf) : buf.toString('utf8')
    } catch {
      return null
    }
  }

  async write (refreshToken, profile) {
    const encrypted = safeStorage.isEncryptionAvailable()
    const token = encrypted
      ? safeStorage.encryptString(refreshToken).toString('base64')
      : Buffer.from(refreshToken, 'utf8').toString('base64')
    this.cached = { name: profile.name, uuid: profile.id }
    await fsp.mkdir(path.dirname(this.file), { recursive: true })
    await fsp.writeFile(this.file, JSON.stringify({ name: profile.name, uuid: profile.id, encrypted, token }))
  }

  async clear () {
    this.cached = null
    await fsp.rm(this.file, { force: true })
  }

  async profile () {
    if (!this.cached) await this.readRefreshToken()
    return this.cached
  }
}

async function loginInteractive (store) {
  const { Auth } = require('msmc')
  const auth = new Auth('select_account')
  try {
    const xbox = await auth.launch('electron', { width: 520, height: 680, resizable: false, title: '마이크로소프트 로그인' })
    const mc = await xbox.getMinecraft()
    await store.write(xbox.save(), mc.profile)
    return mc.profile
  } catch (e) {
    throw friendlyError(e)
  }
}

// 저장된 계정으로 게임 실행용 인증 정보를 만든다. 저장된 계정이 없으면 null.
async function getLaunchAuthorization (store) {
  const refreshToken = await store.readRefreshToken()
  if (!refreshToken) return null
  const { Auth } = require('msmc')
  try {
    const xbox = await new Auth('select_account').refresh(refreshToken)
    const mc = await xbox.getMinecraft()
    await store.write(xbox.save(), mc.profile)
    return { accessToken: mc.mcToken, profile: mc.profile, xuid: mc.xuid }
  } catch (e) {
    const err = friendlyError(e)
    err.needsLogin = true
    throw err
  }
}

module.exports = { AccountStore, loginInteractive, getLaunchAuthorization }
