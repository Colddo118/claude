# KubejsRPG 패치 배포 (patch.bat 에서 실행됨)
#  1) 버전·패치노트 입력  2) 서버 폴더 동기화  3) GitHub 에 모드팩 업로드
# 처음 실행 때 인스턴스·서버 폴더 경로를 물어보고 patch.local.json 에 저장한다 (토큰은 저장하지 않음).

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$LocalFile = Join-Path $Root 'patch.local.json'
$OutDir = Join-Path $Root 'pack-dist-gh'
$Tools = Join-Path $Root 'tools'

function Ask($question, $default) {
  $suffix = if ($default) { " [$default]" } else { '' }
  $answer = Read-Host "$question$suffix"
  if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
  return $answer.Trim().Trim('"')
}

function Ask-YesNo($question) {
  $a = Read-Host "$question (y/n)"
  return $a -match '^(y|yes|ㅛ|예|네)$'
}

function Run-Node([string[]]$nodeArgs) {
  & node @nodeArgs
  if ($LASTEXITCODE -ne 0) { throw "명령이 실패했습니다 (node $($nodeArgs[0]))" }
}

Write-Host ''
Write-Host '=== KubejsRPG 패치 배포 ===' -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js 가 설치되어 있지 않습니다. https://nodejs.org 에서 LTS 버전을 설치하세요.'
}

# --- 경로 설정 (처음 한 번) ---
$settings = @{ instance = ''; serverDir = '' }
if (Test-Path $LocalFile) {
  $saved = Get-Content $LocalFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $settings.instance = $saved.instance
  $settings.serverDir = $saved.serverDir
}
if (-not $settings.instance -or -not (Test-Path $settings.instance)) {
  $settings.instance = Ask '커스포지 인스턴스 폴더 경로' 'C:\Users\COLDDO\curseforge\minecraft\Instances\1.21.1'
  $settings.serverDir = Ask '서버 폴더 경로 (없으면 그냥 Enter)' ''
  ($settings | ConvertTo-Json) | Set-Content $LocalFile -Encoding UTF8
  Write-Host "경로를 저장했습니다: $LocalFile (바꾸려면 이 파일을 지우고 다시 실행)" -ForegroundColor DarkGray
}
if (-not (Test-Path $settings.instance)) { throw "인스턴스 폴더가 없습니다: $($settings.instance)" }

# --- 1. 버전과 패치노트 ---
$lastVersion = $null
$manifestPath = Join-Path $OutDir 'manifest.json'
if (Test-Path $manifestPath) {
  $lastVersion = (Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json).version
}
$suggest = $null
if ($lastVersion -match '^(.*\.)(\d+)$') { $suggest = $Matches[1] + ([int]$Matches[2] + 1) }
Write-Host ''
if ($lastVersion) { Write-Host "지금 배포된 버전: $lastVersion" }
$version = Ask '새 버전' $suggest
if (-not $version) { throw '버전을 입력해 주세요.' }

$notesFile = Join-Path $OutDir "notes-$version.md"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
if (-not (Test-Path $notesFile)) {
  @"
## 변경 사항
- 

## 서버
- 
"@ | Set-Content $notesFile -Encoding UTF8
}
Write-Host '메모장이 열리면 패치노트를 쓰고 저장한 뒤 닫으세요. (# 제목, - 목록 사용 가능)'
Start-Process notepad.exe -ArgumentList "`"$notesFile`"" -Wait

# --- 2. 서버 폴더 동기화 ---
if ($settings.serverDir) {
  Write-Host ''
  Write-Host "=== 서버 폴더 동기화: $($settings.serverDir) ===" -ForegroundColor Cyan
  Run-Node @("$Tools\sync-server.js", '--source', $settings.instance, '--server', $settings.serverDir, '--dry-run')
  if (Ask-YesNo '위 내용대로 서버 폴더에 반영할까요? 서버는 꺼져 있어야 합니다') {
    Run-Node @("$Tools\sync-server.js", '--source', $settings.instance, '--server', $settings.serverDir)
  } else {
    Write-Host '서버 동기화를 건너뜁니다.' -ForegroundColor Yellow
  }
} else {
  Write-Host '(서버 폴더가 설정되지 않아 서버 동기화는 건너뜁니다)' -ForegroundColor DarkGray
}

# --- 3. GitHub 업로드 ---
Write-Host ''
Write-Host '=== GitHub 에 모드팩 업로드 ===' -ForegroundColor Cyan
if (-not (Ask-YesNo "v$version 을 친구들에게 배포할까요?")) { Write-Host '업로드를 취소했습니다.'; exit 0 }
$secure = Read-Host 'GitHub 토큰 붙여넣기 (화면에 안 보임)' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $env:GITHUB_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  Run-Node @("$Tools\build-manifest.js", '--source', $settings.instance, '--out', $OutDir, '--version', $version, '--notes-file', $notesFile, '--publish')
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Item Env:GITHUB_TOKEN -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host "완료! v$version 이 배포됐습니다. 친구들은 런처를 켜면 업데이트가 뜹니다." -ForegroundColor Green
if ($settings.serverDir) { Write-Host '서버를 다시 켜 주세요.' -ForegroundColor Green }
