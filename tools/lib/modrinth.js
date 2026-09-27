'use strict'

// 커스포지 CDN 에 없는 모드를 모드린스(Modrinth)에서 찾는다.
// 파일 내용 해시(sha1)가 정확히 같은 파일만 쓰므로 버전이 달라질 일이 없다.
// 모드린스는 런처가 자기 CDN(cdn.modrinth.com)에서 직접 받아 가는 것을 허용한다 → 남의 모드를 GitHub 에 다시 올리지 않아도 됨.

const API = () => process.env.MODRINTH_API_URL || 'https://api.modrinth.com'
const HEADERS = { 'Content-Type': 'application/json', 'User-Agent': 'colddo118/kubejsrpg-launcher (modpack builder)' }

/**
 * @param {string[]} hashes sha1 목록
 * @returns {Promise<Map<string, string>>} sha1 → 다운로드 주소
 */
async function lookupByHash (hashes, { fetchImpl = fetch, log = () => {} } = {}) {
  const out = new Map()
  const unique = [...new Set(hashes)]
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500)
    let json
    try {
      const res = await fetchImpl(`${API()}/v2/version_files`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ hashes: chunk, algorithm: 'sha1' }),
        signal: AbortSignal.timeout(20000)
      })
      if (!res.ok) { log(`  ! 모드린스 조회 실패 (HTTP ${res.status}) — 이번엔 GitHub 에 직접 올립니다`); continue }
      json = await res.json()
    } catch (e) {
      log(`  ! 모드린스 조회 실패 (${e.message}) — 이번엔 GitHub 에 직접 올립니다`)
      continue
    }
    for (const [hash, version] of Object.entries(json || {})) {
      const file = (version && version.files || []).find(f => f.hashes && f.hashes.sha1 === hash)
      if (file && /^https?:\/\//.test(file.url)) out.set(hash, file.url)
    }
  }
  return out
}

module.exports = { lookupByHash }
