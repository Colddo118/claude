# KubejsRPG 배포 점검 (check.bat 에서 실행됨)
#  GitHub 최신 배포가 가리키는 파일(친구용 + 암호화된 서버용)이 전부 받아지는지 확인하고,
#  빠진 파일은 내 컴의 배포 폴더(pack-dist-gh)에서 찾아 다시 올린다.

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$LocalFile = Join-Path $Root 'patch.local.json'
$OutDir = Join-Path $Root 'pack-dist-gh'
$Tools = Join-Path $Root 'tools'

function Plain($secure) {
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

Write-Host ''
Write-Host '=== KubejsRPG 배포 점검 ===' -ForegroundColor Cyan
if (-not (Test-Path $LocalFile)) { throw 'patch.local.json 이 없습니다. patch.bat 을 먼저 한 번 실행하세요.' }
$settings = Get-Content $LocalFile -Raw -Encoding UTF8 | ConvertFrom-Json
$repo = (Get-Content (Join-Path $settings.instance 'pack.config.json') -Raw -Encoding UTF8 | ConvertFrom-Json).github
if (-not $repo) { throw 'pack.config.json 에 "github" 가 없습니다.' }

$nodeArgs = @("$Tools\check-release.js", '--repo', $repo, '--out', $OutDir)
try {
  $env:SERVER_PACK_KEY = $settings.serverKey
  if ($settings.token) {
    try {
      $env:GITHUB_TOKEN = (Plain (ConvertTo-SecureString $settings.token)).Trim()
      $nodeArgs += '--repair'
    } catch {
      Write-Host '저장된 토큰을 열 수 없어 점검만 합니다 (다시 올리기는 안 함).' -ForegroundColor Yellow
    }
  } else {
    Write-Host '저장된 토큰이 없어 점검만 합니다 (다시 올리기는 안 함).' -ForegroundColor Yellow
  }
  & node @nodeArgs
} finally {
  Remove-Item Env:GITHUB_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:SERVER_PACK_KEY -ErrorAction SilentlyContinue
}
