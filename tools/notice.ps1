# KubejsRPG 런처 공지 (notice.bat 에서 실행됨)
#  메모장에 쓴 공지를 친구들 런처에 바로 띄운다 (모드팩 패치 필요 없음). 비우고 저장하면 공지를 내린다.
#  GitHub 토큰은 patch.bat 이 저장한 것(patch.local.json)을 같이 쓴다.

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$LocalFile = Join-Path $Root 'patch.local.json'
$OutDir = Join-Path $Root 'pack-dist-gh'
$NoticeFile = Join-Path $OutDir 'notice.txt'
$Tools = Join-Path $Root 'tools'

function Ask-YesNo($question) {
  $a = Read-Host "$question (y/n)"
  return $a -match '^(y|yes|ㅛ|예|네)$'
}

function Plain($secure) {
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

Write-Host ''
Write-Host '=== KubejsRPG 런처 공지 ===' -ForegroundColor Cyan
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 가 설치되어 있지 않습니다.' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
if (-not (Test-Path $NoticeFile)) {
  @"
오늘 밤 9시 보스 레이드! 서버 접속해 주세요.
"@ | Set-Content $NoticeFile -Encoding UTF8
}
Write-Host '메모장에 공지를 쓰고 저장한 뒤 닫으세요.'
Write-Host ' - 첫 줄 맨 앞에 ! 를 붙이면 빨간 강조 공지 (예: !서버 점검 중)'
Write-Host ' - 전부 지우고 저장하면 공지를 내립니다'
Start-Process notepad.exe -ArgumentList "`"$NoticeFile`"" -Wait
Write-Host ''
Get-Content $NoticeFile -Encoding UTF8 | ForEach-Object { Write-Host "  | $_" }
if (-not (Ask-YesNo '이 공지를 올릴까요?')) { Write-Host '취소했습니다.'; exit 0 }

$secure = $null
if (Test-Path $LocalFile) {
  $saved = Get-Content $LocalFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($saved.token) { try { $secure = ConvertTo-SecureString $saved.token } catch { $secure = $null } }
}
if (-not $secure) { throw '저장된 GitHub 토큰이 없습니다. patch.bat 을 한 번 실행해서 토큰을 저장한 뒤 다시 하세요.' }

try {
  $env:GITHUB_TOKEN = (Plain $secure).Trim()
  & node "$Tools\publish-notice.js" --file $NoticeFile
  if ($LASTEXITCODE -ne 0) { throw '공지를 올리지 못했습니다.' }
} finally {
  Remove-Item Env:GITHUB_TOKEN -ErrorAction SilentlyContinue
}
