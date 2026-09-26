'use strict'

// 서버 전용 파일(서버 스크립트·데이터) 암호화. 키는 관리자 컴과 서버 컴에만 있다.
// AES-256-GCM. IV 는 "키 + 내용 해시" 로 정해서 같은 내용이면 같은 암호문이 나온다
// → 바뀌지 않은 묶음은 이전 릴리스 것을 그대로 재사용할 수 있다.

const crypto = require('node:crypto')

const MAGIC = Buffer.from('KRP1')

function parseKey (keyB64) {
  const key = Buffer.from(String(keyB64 || '').trim(), 'base64')
  if (key.length !== 32) throw new Error('서버 키 형식이 잘못되었습니다 (base64 32바이트)')
  return key
}

function newKey () {
  return crypto.randomBytes(32).toString('base64')
}

function encrypt (plain, keyB64) {
  const key = parseKey(keyB64)
  const iv = crypto.createHmac('sha256', key).update(crypto.createHash('sha256').update(plain).digest()).digest().subarray(0, 12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body])
}

function decrypt (data, keyB64) {
  const key = parseKey(keyB64)
  if (data.length < 32 || !data.subarray(0, 4).equals(MAGIC)) throw new Error('암호화된 서버 파일 형식이 아닙니다')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(4, 16))
  decipher.setAuthTag(data.subarray(16, 32))
  try {
    return Buffer.concat([decipher.update(data.subarray(32)), decipher.final()])
  } catch {
    throw new Error('서버 키가 맞지 않습니다 (관리자 컴의 키와 같은지 확인하세요)')
  }
}

module.exports = { newKey, encrypt, decrypt }
