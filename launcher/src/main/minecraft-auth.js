'use strict'

// Xbox 토큰 → 마인크래프트 토큰/프로필. msmc 의 getMinecraft 는 실패 원인(HTTP 응답)을 버리고
// "자바 에디션 없음" 하나로 뭉뚱그리기 때문에, 이 단계는 직접 호출하고 원인을 구분해서 알려준다.

const crypto = require('node:crypto')

const MC = 'https://api.minecraftservices.com'
const OWNERSHIP = ['product_minecraft', 'game_minecraft']

async function readBody (res) {
  const text = await res.text().catch(() => '')
  try {
    return JSON.parse(text)
  } catch {
    return text.slice(0, 300)
  }
}

function jwtClaim (token, key) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))[key]
  } catch {
    return undefined
  }
}

function authError (message, diagnostic) {
  const e = new Error(message)
  e.diagnostic = diagnostic
  return e
}

/**
 * xbox: msmc 의 Xbox 객체 (xAuth, getSocial 사용)
 * 성공: { accessToken, profile: { id, name }, xuid, diagnostic }
 * 실패: Error (message 는 사용자용 한국어, diagnostic 에 토큰을 뺀 조사 정보)
 */
async function resolveMinecraftAccount (xbox, { fetchImpl = fetch } = {}) {
  const diagnostic = { at: new Date().toISOString() }

  // 어떤 계정으로 로그인됐는지 알려주기 위한 게이머태그 (실패해도 진행)
  try {
    const social = await xbox.getSocial()
    diagnostic.gamertag = (await social.getProfile()).gamerTag
  } catch (e) {
    diagnostic.gamertagError = String(e && (e.ts || e.message || e))
  }
  const who = diagnostic.gamertag ? `로그인된 계정(게이머태그 "${diagnostic.gamertag}")` : '로그인된 계정'

  const identityToken = await xbox.xAuth('rp://api.minecraftservices.com/')
  const login = await fetchImpl(`${MC}/authentication/login_with_xbox`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ identityToken })
  })
  diagnostic.loginStatus = login.status
  if (!login.ok) {
    diagnostic.loginBody = await readBody(login)
    throw authError(`마인크래프트 인증 서버가 로그인을 거부했습니다 (HTTP ${login.status}). 잠시 후 다시 시도해 주세요.`, diagnostic)
  }
  const { access_token: accessToken } = await login.json()
  const headers = { Accept: 'application/json', Authorization: `Bearer ${accessToken}` }

  const profileRes = await fetchImpl(`${MC}/minecraft/profile`, { headers })
  diagnostic.profileStatus = profileRes.status
  if (profileRes.ok) {
    const profile = await profileRes.json()
    diagnostic.profileName = profile.name
    return { accessToken, profile: { id: profile.id, name: profile.name }, xuid: jwtClaim(accessToken, 'xuid'), diagnostic }
  }
  diagnostic.profileBody = await readBody(profileRes)

  // 프로필이 없으면 구매 여부(엔타이틀먼트)를 확인해서 원인을 가린다. 신/구 엔드포인트 둘 다 본다.
  const items = new Set()
  for (const url of [`${MC}/entitlements/license?requestId=${crypto.randomUUID()}`, `${MC}/entitlements/mcstore`]) {
    const res = await fetchImpl(url, { headers })
    const key = url.includes('license') ? 'licenseStatus' : 'mcstoreStatus'
    diagnostic[key] = res.status
    if (res.ok) {
      const body = await res.json()
      for (const item of body.items || []) items.add(item.name)
    }
  }
  diagnostic.entitlements = [...items]
  const owns = OWNERSHIP.some(n => items.has(n))

  if (profileRes.status === 404 && owns) {
    throw authError(`${who}은 자바 에디션을 가지고 있지만 아직 자바 닉네임(프로필)이 없습니다. ` +
      '공식 마인크래프트 런처로 자바 에디션을 한 번 실행해서 닉네임을 만든 뒤 다시 로그인해 주세요. (게임패스 계정에서 흔함)', diagnostic)
  }
  if (profileRes.status === 404) {
    throw authError(`${who}에는 마인크래프트 자바 에디션이 없습니다. ` +
      '평소 마인크래프트를 하던 계정이 맞는지 확인하고, 다르면 로그아웃 후 다른 계정으로 로그인해 주세요.', diagnostic)
  }
  throw authError(`마인크래프트 프로필을 가져오지 못했습니다 (HTTP ${profileRes.status}). 잠시 후 다시 시도해 주세요.`, diagnostic)
}

module.exports = { resolveMinecraftAccount }
