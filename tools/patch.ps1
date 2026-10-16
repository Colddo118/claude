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

function Plain($secure) {
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

# 토큰은 화면에 안 보이게 받는다. 이 칸에서는 Ctrl+V 가 안 먹고 글자 하나(^V)만 들어가므로 모양을 확인한다.
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
  throw '토큰을 받지 못했습니다. patch.bat 을 다시 실행하세요.'
}

function Save-Settings($s) {
  ($s | ConvertTo-Json) | Set-Content $LocalFile -Encoding UTF8
}

function File-Hash($p) {
  if (Test-Path $p) { return (Get-FileHash $p -Algorithm SHA1).Hash }
  return ''
}

# 대륙 맵 (tools/map.js). 서버 키는 이 호출 동안만 환경변수로 넘긴다
function Map-Run([string[]]$mapArgs) {
  $env:SERVER_PACK_KEY = $settings.serverKey
  try { $out = & node "$Tools\map.js" @mapArgs '--source' $settings.instance '--out' $OutDir }
  finally { Remove-Item Env:SERVER_PACK_KEY -ErrorAction SilentlyContinue }
  if ($LASTEXITCODE -ne 0) { throw "대륙 맵 작업이 실패했습니다 ($($mapArgs[0]))" }
  return $out
}

function Map-Status {
  return (Map-Run @('status') | Select-Object -Last 1) | ConvertFrom-Json
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
  # 패치기 폴더를 잃어버렸으면, 서버 컴의 server-update.json 에 있는 "key" 를 그대로 쓰면 서버 키트를 다시 안 깔아도 된다.
  Write-Host ''
  Write-Host '서버 키(서버 스크립트 암호화용)가 없습니다.' -ForegroundColor Yellow
  Write-Host ' - 이미 서버를 운영 중이면: 서버 폴더 server-update.json 의 "key" 값을 붙여넣으세요 (마우스 오른쪽 클릭 → Enter)'
  Write-Host ' - 처음이면 그냥 Enter → 새로 만듭니다 (이 경우 서버 키트를 서버 폴더에 다시 복사해야 함)'
  for ($i = 0; $i -lt 3 -and -not $settings.serverKey; $i++) {
    $entered = (Plain (Read-Host '서버 키 (화면엔 * 만 보임)' -AsSecureString)).Trim().Trim('"')
    if (-not $entered) {
      $settings.serverKey = (& node -e "console.log(require(process.argv[1]).newKey())" (Join-Path $Root 'launcher\src\common\secret.js')).Trim()
      Write-Host '서버 키를 새로 만들었습니다. 이번 배포 후 서버 키트를 서버 폴더에 다시 복사하세요.' -ForegroundColor Yellow
      break
    }
    $ok = $false
    try { $ok = ([Convert]::FromBase64String($entered)).Length -eq 32 } catch { $ok = $false }
    if ($ok) {
      $settings.serverKey = $entered
      Write-Host '기존 서버 키를 저장했습니다.' -ForegroundColor DarkGray
    } else {
      Write-Host "서버 키 모양이 아닙니다 (입력된 글자 수: $($entered.Length)). = 로 끝나는 44글자입니다." -ForegroundColor Yellow
    }
    $entered = $null
  }
  if (-not $settings.serverKey) { throw '서버 키를 받지 못했습니다. patch.bat 을 다시 실행하세요.' }
}
Save-Settings $settings

$packConfigPath = Join-Path $settings.instance 'pack.config.json'
if (-not (Test-Path $packConfigPath)) { throw "pack.config.json 이 없습니다: $packConfigPath" }
$packConfig = Get-Content $packConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$repo = $packConfig.github
if (-not $repo) { throw 'pack.config.json 에 "github": "아이디/modpack" 이 없습니다.' }

# --- 0. 대륙 맵: 서버가 보낸 맵 받기 / 싱글 월드에서 고친 맵 올리기 (pack.config.json 의 "map") ---
$pushMap = $false
if ($packConfig.map) {
  Write-Host ''
  Write-Host '=== 대륙 맵 ===' -ForegroundColor Cyan
  $map = Map-Status
  if ($map.server -and $map.server.newer) {
    $when = $map.server.sentAt
    try { $when = ([datetime]::Parse([string]$map.server.sentAt)).ToString('MM-dd HH:mm') } catch {}
    Write-Host "서버가 보낸 대륙 맵이 있습니다 ($when): 받을 파일 $($map.server.take)개, 양쪽에서 고친 파일 $($map.server.conflicts)개"
    if ($map.worldInUse) {
      Write-Host '싱글 월드가 게임에서 열려 있어 지금은 받을 수 없습니다. 월드에서 나간 뒤 patch.bat 을 다시 실행하세요.' -ForegroundColor Yellow
    } elseif (($map.server.take + $map.server.conflicts) -eq 0) {
      Map-Run @('pull') | Out-Null  # 덮을 것 없음 → 받은 시각만 기록
    } elseif (Ask-YesNo '싱글 월드에 받을까요? (덮기 전 파일은 pack-dist-gh\map-backup 에 남깁니다)') {
      $conflict = 'keep'
      if ($map.server.conflicts -gt 0 -and (Ask-YesNo "양쪽에서 고친 $($map.server.conflicts)개도 서버 것으로 덮을까요? (n = 내 것 유지, 다음 올리기에 실림)")) { $conflict = 'take' }
      Map-Run @('pull', '--conflict', $conflict) | ForEach-Object { Write-Host $_ }
      $map = Map-Status
    }
  }
  if ($map.devChanged -gt 0) {
    if ($map.worldInUse) {
      Write-Host "싱글 월드가 게임에서 열려 있어 이번 패치에는 맵을 싣지 않습니다 (고친 파일 $($map.devChanged)개)." -ForegroundColor Yellow
    } else {
      if ($map.server -and $map.server.newer) { Write-Host '서버가 보낸 맵을 아직 받지 않았습니다. 지금 올리면 고친 region 은 서버 것 대신 내 것으로 덮입니다.' -ForegroundColor Yellow }
      $pushMap = Ask-YesNo "싱글 월드에서 고친 대륙 맵 파일 $($map.devChanged)개를 이번 패치로 서버에 올릴까요?"
    }
  } else {
    Write-Host '싱글 월드에서 고친 대륙 맵이 없습니다 (서버 맵은 그대로).'
  }
}

# --- 1. 버전과 패치노트 ---
$lastVersion = $null
$manifestPath = Join-Path $OutDir 'manifest.json'
# 실제로 GitHub 에 배포된 버전 기준 (업로드가 실패했던 빌드는 치지 않음). 인터넷이 안 되면 로컬 기록.
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $published = Invoke-RestMethod "https://github.com/$repo/releases/latest/download/manifest.json" -TimeoutSec 15
  if ($published -is [string]) { $published = $published | ConvertFrom-Json }
  $lastVersion = $published.version
  if (-not $lastVersion) { throw 'no version' }
} catch {
  if (Test-Path $manifestPath) { $lastVersion = (Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json).version }
}
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
  $secure = Read-Token
  $tokenIsNew = $true
  # 업로드가 오래 걸려 창을 닫아도 남도록, 넣자마자 저장할지 묻는다 (업로드가 실패하면 아래에서 지움)
  if (Ask-YesNo '토큰을 이 컴퓨터(이 윈도우 계정)에만 풀 수 있게 암호화해서 저장할까요? 다음부터 입력 안 해도 됩니다') {
    $settings.token = ConvertFrom-SecureString $secure
    Save-Settings $settings
  }
}

# --- 3. 빌드 + 업로드 ---
$kitHashBefore = File-Hash (Join-Path $KitDir 'server-update.js')
try {
  $env:GITHUB_TOKEN = (Plain $secure).Trim()
  $env:SERVER_PACK_KEY = $settings.serverKey
  try {
    $buildArgs = @("$Tools\build-manifest.js", '--source', $settings.instance, '--out', $OutDir, '--version', $version, '--notes-file', $notesFile, '--publish')
    if ($pushMap) { $buildArgs += '--map' }
    Run-Node $buildArgs
  } catch {
    if ($settings.token) {
      Write-Host '토큰이 만료되었거나 잘못되었을 수 있습니다. 다음 실행 때 새 토큰을 물어보도록 저장된 토큰을 지웁니다.' -ForegroundColor Yellow
      $settings.token = ''
      Save-Settings $settings
    }
    throw
  }
  Run-Node @("$Tools\make-server-kit.js", '--out', $KitDir, '--repo', $repo)
} finally {
  Remove-Item Env:GITHUB_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:SERVER_PACK_KEY -ErrorAction SilentlyContinue
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
