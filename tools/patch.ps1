# KubejsRPG 패치 배포 (patch.bat 에서 실행됨)
#  친구용 모드팩 + 서버용 패치(서버 스크립트는 암호화)를 GitHub 릴리스 하나로 올린다.
#  처음 실행 때 경로를 묻고, 서버 키를 만들고, (원하면) 토큰을 이 컴퓨터 계정으로 암호화해서
#  patch.local.json 에 저장한다. 이 파일은 깃에 올라가지 않는다.

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$LocalFile = Join-Path $Root 'patch.local.json'
$OutDir = Join-Path $Root 'pack-dist-gh'
$KitDir = Join-Path $OutDir 'server-kit'
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

function Save-Settings($s) {
  ($s | ConvertTo-Json) | Set-Content $LocalFile -Encoding UTF8
}

function File-Hash($p) {
  if (Test-Path $p) { return (Get-FileHash $p -Algorithm SHA1).Hash }
  return ''
}

Write-Host ''
Write-Host '=== KubejsRPG 패치 배포 ===' -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js 가 설치되어 있지 않습니다. https://nodejs.org 에서 LTS 버전을 설치하세요.'
}

# --- 설정 불러오기 / 처음 한 번 설정 ---
$settings = [ordered]@{ instance = ''; serverDir = ''; serverKey = ''; token = '' }
if (Test-Path $LocalFile) {
  $saved = Get-Content $LocalFile -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($k in @('instance', 'serverDir', 'serverKey', 'token')) { if ($saved.$k) { $settings[$k] = $saved.$k } }
}
if (-not $settings.instance -or -not (Test-Path $settings.instance)) {
  $settings.instance = Ask '커스포지 인스턴스 폴더 경로' 'C:\Users\COLDDO\curseforge\minecraft\Instances\1.21.1'
  if (-not (Test-Path $settings.instance)) { throw "인스턴스 폴더가 없습니다: $($settings.instance)" }
}
if (-not $settings.serverKey) {
  $settings.serverKey = (& node -e "console.log(require(process.argv[1]).newKey())" (Join-Path $Root 'launcher\src\common\secret.js')).Trim()
  Write-Host '서버 키를 새로 만들었습니다 (서버 스크립트 암호화용).' -ForegroundColor DarkGray
}
Save-Settings $settings

$packConfigPath = Join-Path $settings.instance 'pack.config.json'
if (-not (Test-Path $packConfigPath)) { throw "pack.config.json 이 없습니다: $packConfigPath" }
$repo = (Get-Content $packConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json).github
if (-not $repo) { throw 'pack.config.json 에 "github": "아이디/modpack" 이 없습니다.' }

# --- 1. 버전과 패치노트 ---
$lastVersion = $null
$manifestPath = Join-Path $OutDir 'manifest.json'
if (Test-Path $manifestPath) { $lastVersion = (Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json).version }
$suggest = $null
if ($lastVersion -match '^(.*\.)(\d+)$') { $suggest = $Matches[1] + ([int]$Matches[2] + 1) }
Write-Host ''
if ($lastVersion) { Write-Host "지금 배포된 버전: $lastVersion" }
$version = Ask '새 버전 (그냥 Enter = 추천 버전)' $suggest
if (-not $version) { throw '버전을 입력해 주세요.' }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$notesFile = Join-Path $OutDir "notes-$version.md"
if (-not (Test-Path $notesFile)) {
  @"
## 변경 사항
- 
"@ | Set-Content $notesFile -Encoding UTF8
}
Write-Host '메모장이 열리면 패치노트를 쓰고 저장한 뒤 닫으세요.'
Start-Process notepad.exe -ArgumentList "`"$notesFile`"" -Wait

# --- (선택) 같은 네트워크의 서버 폴더에 직접 반영 ---
if ($settings.serverDir) {
  Write-Host ''
  Write-Host "=== 서버 폴더 직접 반영: $($settings.serverDir) ===" -ForegroundColor Cyan
  Run-Node @("$Tools\sync-server.js", '--source', $settings.instance, '--server', $settings.serverDir, '--dry-run')
  if (Ask-YesNo '위 내용대로 서버 폴더에 반영할까요? 서버는 꺼져 있어야 합니다') {
    Run-Node @("$Tools\sync-server.js", '--source', $settings.instance, '--server', $settings.serverDir)
  }
}

# --- 2. GitHub 토큰 ---
Write-Host ''
if (-not (Ask-YesNo "v$version 을 배포할까요?")) { Write-Host '취소했습니다.'; exit 0 }
$secure = $null
if ($settings.token) {
  try { $secure = ConvertTo-SecureString $settings.token } catch { $secure = $null }
}
$tokenIsNew = $false
if (-not $secure) {
  $secure = Read-Host 'GitHub 토큰 붙여넣기 (화면에 안 보임)' -AsSecureString
  $tokenIsNew = $true
}

# --- 3. 빌드 + 업로드 ---
$kitHashBefore = File-Hash (Join-Path $KitDir 'server-update.js')
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $env:GITHUB_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  $env:SERVER_PACK_KEY = $settings.serverKey
  try {
    Run-Node @("$Tools\build-manifest.js", '--source', $settings.instance, '--out', $OutDir, '--version', $version, '--notes-file', $notesFile, '--publish')
  } catch {
    if (-not $tokenIsNew) {
      Write-Host '저장된 토큰이 만료되었거나 삭제되었을 수 있습니다. 다음 실행 때 새 토큰을 물어보도록 지웁니다.' -ForegroundColor Yellow
      $settings.token = ''
      Save-Settings $settings
    }
    throw
  }
  Run-Node @("$Tools\make-server-kit.js", '--out', $KitDir, '--repo', $repo)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Item Env:GITHUB_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:SERVER_PACK_KEY -ErrorAction SilentlyContinue
}

if ($tokenIsNew -and (Ask-YesNo '토큰을 이 컴퓨터(이 윈도우 계정)에만 풀 수 있게 암호화해서 저장할까요? 다음부터 입력 안 해도 됩니다')) {
  $settings.token = ConvertFrom-SecureString $secure
  Save-Settings $settings
}

Write-Host ''
Write-Host "완료! v$version 배포됨." -ForegroundColor Green
Write-Host ' - 친구들: 런처를 켜면 업데이트가 뜹니다.'
Write-Host ' - 서버 컴: 서버를 끄고(stop) 서버시작.bat 더블클릭.'
if ((File-Hash (Join-Path $KitDir 'server-update.js')) -ne $kitHashBefore) {
  Write-Host ''
  Write-Host "서버 키트가 새로 만들어졌거나 바뀌었습니다: $KitDir" -ForegroundColor Yellow
  Write-Host ' 이 폴더의 파일들을 서버 컴의 서버 폴더(run.bat 있는 곳)에 복사해 주세요. (읽어주세요.txt 참고)' -ForegroundColor Yellow
  Write-Host ' server-update.json 에는 서버 키가 들어 있으니 다른 사람에게 주지 마세요.' -ForegroundColor Yellow
  Start-Process explorer.exe -ArgumentList "`"$KitDir`""
}
