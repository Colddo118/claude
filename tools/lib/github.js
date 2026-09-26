'use strict'

// GitHub Releases 에 모드팩 버전을 올린다. 런처는
// https://github.com/<repo>/releases/latest/download/manifest.json 으로 최신 버전을 찾는다.

const fsp = require('node:fs').promises
const path = require('node:path')

const API = () => process.env.GITHUB_API_URL || 'https://api.github.com'

function releaseTag (version) {
  return `pack-${version}`
}

// 테스트에서 가짜 서버로 바꿀 수 있게 환경변수로 뺐다
const WEB = () => process.env.GITHUB_WEB_URL || 'https://github.com'

function releaseDownloadPrefix (repo) {
  return `${WEB()}/${repo}/releases/download/`
}

function assetUrl (repo, version, name) {
  return `${releaseDownloadPrefix(repo)}${releaseTag(version)}/${name}`
}

function manifestUrl (repo) {
  return `${WEB()}/${repo}/releases/latest/download/manifest.json`
}

async function api (token, method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    body: body && !Buffer.isBuffer(body) ? JSON.stringify(body) : body
  })
  const text = await res.text()
  if (!res.ok) {
    let msg = text
    try { msg = JSON.parse(text).message } catch {}
    throw new Error(`GitHub API ${method} ${new URL(url).pathname} 실패 (${res.status}): ${msg}`)
  }
  return text ? JSON.parse(text) : null
}

/**
 * pack-<version> 릴리스를 만들고 zip 과 manifest.json 을 첨부한다.
 * 마지막에 latest 로 지정되므로 런처는 그 순간부터 새 버전을 본다.
 */
async function publishRelease ({ repo, token, version, notes, files }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`저장소 이름 형식이 잘못되었습니다: ${repo} (예: myname/modpack)`)
  if (!token) throw new Error('GITHUB_TOKEN 환경변수가 필요합니다 (README 의 토큰 만들기 참고)')

  const release = await api(token, 'POST', `${API()}/repos/${repo}/releases`, {
    tag_name: releaseTag(version),
    name: `모드팩 v${version}`,
    body: notes || '',
    draft: true
  })
  try {
    const uploadBase = release.upload_url.replace(/\{.*\}$/, '')
    for (const file of files) {
      const data = await fsp.readFile(file)
      await api(token, 'POST', `${uploadBase}?name=${encodeURIComponent(path.basename(file))}`, data, {
        'Content-Type': file.endsWith('.json') ? 'application/json' : file.endsWith('.zip') ? 'application/zip' : 'application/octet-stream'
      })
    }
    // 파일이 다 올라간 다음에 공개해야 업로드 도중 접속한 유저가 깨지지 않는다.
    return await api(token, 'PATCH', `${API()}/repos/${repo}/releases/${release.id}`, { draft: false, make_latest: 'true' })
  } catch (e) {
    await api(token, 'DELETE', `${API()}/repos/${repo}/releases/${release.id}`).catch(() => {})
    throw e
  }
}

module.exports = { publishRelease, assetUrl, releaseDownloadPrefix, manifestUrl, releaseTag }
