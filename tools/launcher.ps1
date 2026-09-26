# KubejsRPG 런처 배포 (launcher.bat 에서 실행됨)
#  런처를 빌드해서 GitHub 릴리스(launcher)에 올린다. 친구들은 작은 KubejsRPG-Setup.exe 로 최신 런처를 설치한다.
#  GitHub 토큰은 patch.bat 이 저장해 둔 것(patch.local.json)을 같이 쓴다.

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$LocalFile = Join-Path $Root 'patch.local.json'
$LauncherDir = Join-Path $Root 'launcher'
$DistDir = Join-Path $LauncherDir 'dist\nsis-web'
$Tools = Join-Path $Root 'tools'

function Ask-YesNo($question) {
  $a = Read-Host "$question (y/n)"
  return $a -match '^(y|yes|ㅛ|예|네)$'
}

function Run([string]$exe, [string[]]$argList) {
  & $exe @argList
  if ($LASTEXITCODE -ne 0) { throw "명령이 실패했습니다 ($exe $($argList -join ' '))" }
}

function Plain($secure) {
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

# 이 칸에서는 Ctrl+V 가 안 먹고 글자 하나(^V)만 들어가므로 모양을 확인한다
function Read-Token {
  Write-Host 'GitHub 토큰을 붙여넣습니다: 창에 마우스 오른쪽 클릭 → Enter (Ctrl+V 는 안 됩니다. 화면엔 * 만 보임)' -ForegroundColor Cyan
  for ($i = 0; $i -lt 3; $i++) {
    $secure = Read-Host 'GitHub 토큰' -AsSecureString
    $plain = (Plain $secure).Trim()
    if ($plain -match '^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$') {
      $plain = $null
      return $secure
    }
    $len = $plain.Length
    $plain = $null
    Write-Host "토큰 모양이 아닙니다 (입력된 글자 수: $len). github_pat_ 로 시작하는 토큰 전체를 마우스 오른쪽 클릭으로 붙여넣으세요." -ForegroundColor Yellow
  }
  throw '토큰을 받지 못했습니다. launcher.bat 을 다시 실행하세요.'
}

Write-Host ''
Write-Host '=== KubejsRPG 런처 배포 ===' -ForegroundColor Cyan
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js 가 설치되어 있지 않습니다. https://nodejs.org 에서 LTS 버전을 설치하세요.'
}
$version = (Get-Content (Join-Path $LauncherDir 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
Write-Host "런처 버전: v$version  (바꾸려면 launcher\package.json 의 version)"
if (-not (Ask-YesNo "런처 v$version 을 빌드해서 올릴까요? 친구들이 설치 파일을 실행하면 이 버전이 깔립니다")) { Write-Host '취소했습니다.'; exit 0 }

# --- 1. 빌드 ---
Push-Location $LauncherDir
try {
  Write-Host ''
  Write-Host '[1/3] 준비 (npm install)' -ForegroundColor Cyan
  Run 'npm' @('install', '--no-audit', '--no-fund')
  Write-Host '[2/3] 테스트' -ForegroundColor Cyan
  Run 'npm' @('test')
  Write-Host '[3/3] 빌드 (몇 분 걸려요)' -ForegroundColor Cyan
  if (Test-Path $DistDir) { Remove-Item $DistDir -Recurse -Force }
  # Node 20 은 electron-builder 가 쓰는 모듈 방식을 켜 줘야 한다 (22 이상은 기본)
  # node --version = "v20.17.0" (PowerShell 5.1 은 node 에 넘기는 인자 속 큰따옴표를 지워 버려서 -p 식은 못 씀)
  $major = [int]((& node --version).Trim().TrimStart('v').Split('.')[0])
  if ($major -lt 22) { $env:NODE_OPTIONS = '--experimental-require-module' }
  try { Run 'npm' @('run', 'build:win') } finally { Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue }
} finally {
  Pop-Location
}

# --- 2. 토큰 (patch.bat 이 저장한 것) ---
$settings = [ordered]@{}
if (Test-Path $LocalFile) {
  $saved = Get-Content $LocalFile -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($p in $saved.PSObject.Properties) { $settings[$p.Name] = $p.Value }
}
$secure = $null
if ($settings.token) {
  try { $secure = ConvertTo-SecureString $settings.token } catch { $secure = $null }
}
$tokenIsNew = $false
if (-not $secure) {
  $secure = Read-Token
  $tokenIsNew = $true
}

# --- 3. 올리기 ---
Write-Host ''
Write-Host 'GitHub 에 올리는 중 (100MB 정도, 인터넷 속도에 따라 몇 분)' -ForegroundColor Cyan
try {
  $env:GITHUB_TOKEN = (Plain $secure).Trim()
  Run 'node' @("$Tools\publish-launcher.js", '--dist', $DistDir)
} finally {
  Remove-Item Env:GITHUB_TOKEN -ErrorAction SilentlyContinue
}

if ($tokenIsNew -and (Ask-YesNo '토큰을 이 컴퓨터(이 윈도우 계정)에만 풀 수 있게 암호화해서 저장할까요?')) {
  $settings['token'] = ConvertFrom-SecureString $secure
  ($settings | ConvertTo-Json) | Set-Content $LocalFile -Encoding UTF8
}

Write-Host ''
Write-Host "완료! 런처 v$version 을 올렸습니다." -ForegroundColor Green
Write-Host ' - 친구들에게는 방금 열린 폴더의 KubejsRPG-Setup.exe (1MB 남짓) 를 디스코드로 보내면 됩니다.'
Write-Host ' - 예전에 준 설치 파일도 그대로 최신 런처를 설치합니다.'
Start-Process explorer.exe -ArgumentList "`"$DistDir`""
