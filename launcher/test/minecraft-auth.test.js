'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { resolveMinecraftAccount } = require('../src/main/minecraft-auth')

// 가짜 Xbox 객체와 가짜 마인크래프트 API
const token = ['x', Buffer.from(JSON.stringify({ xuid: '2535' })).toString('base64url'), 'sig'].join('.')
const xbox = {
  xAuth: async () => 'XBL3.0 x=uhs;tok',
  getSocial: async () => ({ getProfile: async () => ({ gamerTag: 'TestTag' }) })
}

function fakeApi ({ login = 200, profile = 404, license = [], mcstore = [] }) {
  const calls = []
  const json = (status, body) => new Response(JSON.stringify(body), { status })
  const fetchImpl = async url => {
    calls.push(new URL(url).pathname)
    if (url.includes('login_with_xbox')) return login === 200 ? json(200, { access_token: token }) : json(login, { error: 'nope' })
    if (url.endsWith('/minecraft/profile')) return profile === 200 ? json(200, { id: 'uuid1', name: 'Steve' }) : json(profile, { error: 'NOT_FOUND' })
    if (url.includes('/entitlements/license')) return json(200, { items: license.map(name => ({ name })) })
    if (url.includes('/entitlements/mcstore')) return json(200, { items: mcstore.map(name => ({ name })) })
    throw new Error(url)
  }
  return { fetchImpl, calls }
}

test('정상 계정', async () => {
  const { fetchImpl } = fakeApi({ profile: 200 })
  const r = await resolveMinecraftAccount(xbox, { fetchImpl })
  assert.deepEqual(r.profile, { id: 'uuid1', name: 'Steve' })
  assert.equal(r.accessToken, token)
  assert.equal(r.xuid, '2535')
  assert.equal(r.diagnostic.gamertag, 'TestTag')
  assert.ok(!JSON.stringify(r.diagnostic).includes(token)) // 조사 정보에 토큰 없음
})

test('자바는 샀지만 닉네임(프로필)이 없는 계정 (게임패스 등)', async () => {
  const { fetchImpl } = fakeApi({ license: ['product_minecraft', 'game_minecraft'] })
  await assert.rejects(resolveMinecraftAccount(xbox, { fetchImpl }), e => {
    assert.match(e.message, /TestTag/)
    assert.match(e.message, /닉네임/)
    assert.deepEqual(e.diagnostic.entitlements, ['product_minecraft', 'game_minecraft'])
    return true
  })
})

test('자바가 없는 계정 → 게이머태그와 함께 다른 계정 안내', async () => {
  const { fetchImpl } = fakeApi({ mcstore: ['product_minecraft_bedrock'] })
  await assert.rejects(resolveMinecraftAccount(xbox, { fetchImpl }), e => {
    assert.match(e.message, /"TestTag"/)
    assert.match(e.message, /자바 에디션이 없습니다/)
    assert.equal(e.diagnostic.profileStatus, 404)
    return true
  })
})

test('서버 오류는 "자바 없음" 으로 오해하지 않는다', async () => {
  const { fetchImpl } = fakeApi({ profile: 429 })
  await assert.rejects(resolveMinecraftAccount(xbox, { fetchImpl }), /HTTP 429/)
  const f2 = fakeApi({ login: 403 })
  await assert.rejects(resolveMinecraftAccount(xbox, { fetchImpl: f2.fetchImpl }), /로그인을 거부.*HTTP 403/)
})
