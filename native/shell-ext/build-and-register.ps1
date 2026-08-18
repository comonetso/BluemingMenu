<#
  Blueming Menu 셸 확장 — 빌드 + 등록 스크립트.

  하는 일
    1. Rust DLL 을 release 로 빌드
    2. dist/ 에 패키지 구성물을 모은다 (DLL + 매니페스트 + 로고)
    3. Add-AppxPackage -Register 로 등록 (개발자 모드라 서명 불필요)

  전제
    - 개발자 모드 ON  (이 PC 는 AllowDevelopmentWithoutDevLicense = 1 로 실측 확인됨)
    - Rust **GNU** 툴체인:  rustup toolchain install stable-x86_64-pc-windows-gnu

  왜 MSVC 가 아니라 GNU 인가
    MSVC 툴체인은 Visual Studio Build Tools(3~5GB, 관리자 권한)를 요구한다.
    이 PC 에는 없었고 winget 무인 설치도 UAC 때문에 실패했다.
    GNU 툴체인(약 700MB, 관리자 불필요)으로 빌드해 보니 COM DLL 이 정상적으로 나왔고
    `DllGetClassObject` / `DllCanUnloadNow` export 도 확인됐다.

  ⚠️ 등록을 지우려면:  Get-AppxPackage *BluemingMenu.ShellExt* | Remove-AppxPackage
  ⚠️ 탐색기가 DLL 을 붙들고 있으면 재빌드가 실패한다. 그때는 탐색기를 재시작한다:
       Stop-Process -Name explorer -Force
#>

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$dist = Join-Path $here 'dist'

Write-Host '=== 1. Rust DLL 빌드 ===' -ForegroundColor Cyan
Push-Location $here
try {
    & cargo '+stable-x86_64-pc-windows-gnu' build --release
    if ($LASTEXITCODE -ne 0) { throw "cargo build 실패 (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}

$dll = Join-Path $here 'target\release\blueming_shell_ext.dll'
if (-not (Test-Path $dll)) { throw "DLL 이 생성되지 않았다: $dll" }

Write-Host '=== 2. dist 구성 ===' -ForegroundColor Cyan
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory -Path $dist | Out-Null
New-Item -ItemType Directory -Path (Join-Path $dist 'Assets') | Out-Null

Copy-Item $dll $dist
Copy-Item (Join-Path $here 'AppxManifest.xml') $dist

# 로고 — 앱 아이콘을 재활용한다. MSIX 는 정확한 픽셀 크기를 요구하지만
# `-Register` 개발 등록에서는 검증이 느슨하다. 배포본을 만들 때 정확한 크기로 다시 뽑을 것.
$iconSrc = Join-Path $here '..\..\assets\icons\build\icon-256.png'
if (Test-Path $iconSrc) {
    Copy-Item $iconSrc (Join-Path $dist 'Assets\StoreLogo.png')
    Copy-Item $iconSrc (Join-Path $dist 'Assets\Square150x150Logo.png')
    Copy-Item $iconSrc (Join-Path $dist 'Assets\Square44x44Logo.png')
} else {
    throw "아이콘을 찾지 못했다: $iconSrc"
}

# 컨텍스트 메뉴 항목에 붙는 아이콘. DLL 이 `module_dir()/icon.ico` 로 찾는다 (lib.rs 의 GetIcon).
# .ico 를 쓰는 이유는 DPI 별 해상도를 한 파일에 담고 있어서다 — 단일 PNG 는 뭉갠다.
$icoSrc = Join-Path $here '..\..\assets\icons\icon.ico'
if (Test-Path $icoSrc) {
    Copy-Item $icoSrc (Join-Path $dist 'icon.ico')
} else {
    Write-Warning "icon.ico 를 찾지 못했다 — 메뉴가 아이콘 없이 그려진다: $icoSrc"
}

<#
  매니페스트가 Application/Executable 을 요구한다. 셸 확장만 제공하므로 실제로 실행될 일은
  없지만(AppListEntry="none"), 등록 시 파일 존재 검증에 걸린다.
  개발 등록에서는 자리만 채우면 되므로 빈 파일을 둔다.
  ⚠️ 배포본에서는 실제 BluemingMenu.exe 를 가리키도록 ExternalLocation 을 써야 한다.
#>
New-Item -ItemType File -Path (Join-Path $dist 'BluemingMenu.exe') -Force | Out-Null

Write-Host '=== 3. 기존 등록 제거 ===' -ForegroundColor Cyan
Get-AppxPackage -Name 'BluemingMenu.ShellExt' -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host ("  제거: " + $_.PackageFullName)
    Remove-AppxPackage -Package $_.PackageFullName
}

Write-Host '=== 4. 등록 ===' -ForegroundColor Cyan
<#
  매니페스트가 `AllowExternalContent` 를 선언했으므로 `-ExternalLocation` 이 **필수**다.
  빼면 0x80073CF9 ("외부 위치에 설치해야 하므로 설치할 수 없습니다") 로 거부된다 (실측).

  지금은 dist 자체를 외부 위치로 준다. 배포본에서는 BluemingMenu.exe 가 설치된 폴더를 준다.
#>
Add-AppxPackage -Register (Join-Path $dist 'AppxManifest.xml') -ExternalLocation $dist

Write-Host ''
Write-Host '완료. 확인:' -ForegroundColor Green
Get-AppxPackage -Name 'BluemingMenu.ShellExt' | Format-List Name, PackageFullName, InstallLocation, SignatureKind

Write-Host ''
Write-Host '탐색기를 재시작해야 메뉴가 반영된다:' -ForegroundColor Yellow
Write-Host '  Stop-Process -Name explorer -Force'
