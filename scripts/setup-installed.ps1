<#
  설치본 초기 설정 — **설치 직후 한 번만** 돌리면 된다.

  하는 일
    1. 개발 중 만든 설정(배치·폴더·단축키·플로팅 위치)을 설치본으로 옮긴다
    2. 탐색기 셸 확장을 **설치 폴더 기준**으로 다시 등록한다

  왜 필요한가
    - 설정은 포터블 방식이라 파일 하나로 옮겨진다. 다만 처음 한 번은 복사해 줘야 한다
    - 셸 확장(MSIX)은 개발 폴더를 가리키도록 등록돼 있다. 개발 폴더를 지우면 탐색기
      메뉴가 깨지므로 설치 폴더 쪽으로 옮긴다

  ⚠️ 설정 파일은 `app-<버전>` 안이 아니라 **설치 루트**에 둔다.
     Squirrel 은 버전마다 `app-x.y.z` 폴더를 새로 만들기 때문에, exe 옆에 두면
     업데이트할 때마다 배치가 통째로 초기화된다. (`src/store.ts` 의 `configDir()` 참조)

  ⚠️ 이미 설치본에 설정이 있으면 **덮어쓰지 않는다.** 덮어쓰려면 -Force 를 준다.
#>

param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

# ── 1. 설치 위치 찾기 ────────────────────────────────────────────
<#
  ⚠️ 경로를 넘겨짚지 않는다. NSIS 는 사용자가 설치 위치를 바꿀 수 있고(allowToChangeInstallationDirectory),
     per-user / per-machine 에 따라 기본값도 다르다. 예전엔 Squirrel 경로 두 개만 봐서
     NSIS 설치를 못 찾고 즉시 예외로 끝났다. (Codex 리뷰 2026-08-18 지적)

     그래서 **레지스트리의 제거 정보에서 실제 설치 경로를 읽는 것**을 1순위로 한다.
     그게 없을 때만 알려진 기본 위치들을 훑는다.
#>
function Find-InstallRoot {
    foreach ($hive in @(
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )) {
        $hit = Get-ItemProperty $hive -ErrorAction SilentlyContinue |
               Where-Object { $_.DisplayName -like 'Blueming Menu*' -and $_.InstallLocation } |
               Select-Object -First 1
        if ($hit -and (Test-Path $hit.InstallLocation)) { return $hit.InstallLocation }
    }

    foreach ($p in @(
        (Join-Path $env:LOCALAPPDATA 'Programs\BluemingMenu'),   # NSIS per-user (현재 기본)
        (Join-Path $env:ProgramFiles 'BluemingMenu'),            # NSIS per-machine
        (Join-Path $env:LOCALAPPDATA 'BluemingMenu'),            # Squirrel
        (Join-Path $env:LOCALAPPDATA 'blueming_menu')            # Squirrel (이름 변형)
    )) {
        if (Test-Path (Join-Path $p 'BluemingMenu.exe')) { return $p }
    }

    return $null
}

$installRoot = Find-InstallRoot
if (-not $installRoot) {
    throw "설치 폴더를 찾지 못했다. 먼저 dist\Blueming Menu Setup*.exe 로 설치할 것."
}
Write-Host "설치 폴더: $installRoot" -ForegroundColor Cyan

# ⚠️ Program Files 아래면 설정을 그리로 옮기지 않는다 — 앱이 %APPDATA% 를 쓰기 때문이다
#    (src/store.ts 의 configDir() 참조). 옮겨 봐야 앱이 읽지 않는다.
$isSystemLoc = $installRoot.ToLower().StartsWith($env:ProgramFiles.ToLower())
if ($isSystemLoc) {
    Write-Host '  (Program Files 설치 — 설정은 %APPDATA% 에 저장된다)' -ForegroundColor Yellow
}

# ── 2. 설정 이전 ─────────────────────────────────────────────────
$srcConfig = Join-Path $repo 'blueming-menu.config.json'
# Program Files 설치면 앱이 %APPDATA% 를 쓰므로 그쪽으로 옮긴다.
$dstConfig = if ($isSystemLoc) {
    $appData = Join-Path $env:APPDATA 'Blueming Menu'
    New-Item -ItemType Directory -Path $appData -Force | Out-Null
    Join-Path $appData 'blueming-menu.config.json'
} else {
    Join-Path $installRoot 'blueming-menu.config.json'
}

if (-not (Test-Path $srcConfig)) {
    Write-Warning "개발 쪽 설정이 없다 — 이전 건너뜀: $srcConfig"
} elseif ((Test-Path $dstConfig) -and -not $Force) {
    Write-Host "설정이 이미 있다. 건너뜀 (덮어쓰려면 -Force)" -ForegroundColor Yellow
    Write-Host "  $dstConfig"
} else {
    Copy-Item $srcConfig $dstConfig -Force
    $items = (Get-Content $dstConfig -Raw | ConvertFrom-Json).items.Count
    Write-Host "설정 이전 완료 — 항목 $items 개" -ForegroundColor Green
    Write-Host "  → $dstConfig"
}

# ── 3. 셸 확장을 설치 폴더 기준으로 재등록 ───────────────────────
$extSrc = Join-Path $repo 'native\shell-ext\dist'
if (-not (Test-Path $extSrc)) {
    Write-Warning "셸 확장 빌드본이 없다 — 등록 건너뜀. 먼저 native\shell-ext\build-and-register.ps1 을 돌릴 것"
} else {
    # 설치 루트 아래에 둔다. app-<버전> 안에 두면 업데이트 때 사라진다.
    $extDst = Join-Path $installRoot 'shell-ext'
    if (Test-Path $extDst) { Remove-Item $extDst -Recurse -Force }
    Copy-Item $extSrc $extDst -Recurse
    Write-Host "셸 확장 복사 완료 → $extDst" -ForegroundColor Green

    Get-AppxPackage -Name 'BluemingMenu.ShellExt' -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host ("  기존 등록 제거: " + $_.PackageFullName)
        Remove-AppxPackage -Package $_.PackageFullName
    }

    Add-AppxPackage -Register (Join-Path $extDst 'AppxManifest.xml') -ExternalLocation $extDst
    Write-Host "셸 확장 재등록 완료" -ForegroundColor Green
    Get-AppxPackage -Name 'BluemingMenu.ShellExt' | Format-List Name, InstallLocation
}

Write-Host ''
Write-Host '끝났다. 설치본을 실행하면 개발 중 만든 배치가 그대로 뜬다.' -ForegroundColor Green
Write-Host '⚠️ 개발 버전 앱이 켜져 있으면 먼저 종료할 것 (트레이 아이콘이 둘이 된다).' -ForegroundColor Yellow
