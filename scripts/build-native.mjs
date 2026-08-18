// 네이티브 산출물 빌드 — `npm run dist` / `npm run pack` 이 먼저 부른다.
//
// ## 왜 필요한가
// `package.json` 의 `extraResources` 가 아래 셋을 참조하는데, 전부 **Rust 빌드 산출물**이고
// `.gitignore` 대상이다. 깨끗한 checkout 에서 `npm run dist` 만 돌리면 이것들이 없어서
// **단축키와 탐색기 메뉴가 빠진 설치본**이 조용히 만들어진다. (Codex 리뷰 2026-08-18 지적)
//
//   native/hotkey/target/release/blueming-hotkey.exe   전역 단축키 훅
//   native/shell-ext/target/release/*.dll              탐색기 컨텍스트 메뉴 COM 핸들러
//   native/shell-ext/dist/                             위 DLL + 매니페스트 + 로고 (MSIX 조립본)
//
// ## 툴체인
// MSVC 가 아니라 **GNU** 툴체인을 쓴다. MSVC 는 Visual Studio Build Tools(3~5GB, 관리자 권한)를
// 요구하는데 이 PC 에 없었고 무인 설치도 UAC 때문에 실패했다. GNU(약 700MB, 관리자 불필요)로
// 빌드해 보니 COM DLL 이 정상적으로 나왔고 export 도 확인됐다.
//
//   rustup toolchain install stable-x86_64-pc-windows-gnu

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TOOLCHAIN = '+stable-x86_64-pc-windows-gnu';

/** cargo 가 있는가. rustup 이 PATH 에 없는 셸도 있어 홈 디렉토리까지 본다 */
function cargoCommand() {
  const probe = spawnSync('cargo', ['--version'], { shell: true, stdio: 'ignore' });
  if (probe.status === 0) return 'cargo';

  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const local = path.join(home, '.cargo', 'bin', 'cargo.exe');
  if (fs.existsSync(local)) return local;

  return null;
}

function build(cargo, crateDir, label) {
  console.log(`[native] ${label} 빌드`);
  const r = spawnSync(cargo, [TOOLCHAIN, 'build', '--release'], {
    cwd: path.join(repo, crateDir),
    stdio: 'inherit',
    shell: true,
  });
  if (r.status !== 0) {
    throw new Error(`${label} 빌드 실패 (exit ${r.status})`);
  }
}

/** 셸 확장 MSIX 조립 — DLL·매니페스트·로고를 dist/ 에 모은다 */
function assembleShellExt() {
  const base = path.join(repo, 'native', 'shell-ext');
  const dist = path.join(base, 'dist');

  /*
   * ⚠️ 셸 확장이 **등록돼 있으면 explorer.exe 가 DLL 을 물고 있어** 이 삭제가 EPERM 으로 막힌다.
   *    그때는 등록을 잠시 풀고 다시 돌린다:
   *
   *      Get-AppxPackage *BluemingMenu.ShellExt* | Remove-AppxPackage
   *
   *    (탐색기를 재시작해도 되지만 열린 창이 전부 닫히므로 등록 해제가 덜 거슬린다)
   */
  try {
    fs.rmSync(dist, { recursive: true, force: true });
  } catch (err) {
    if (err.code === 'EPERM') {
      throw new Error(
        '셸 확장 DLL 이 잠겨 있다 (탐색기가 로드 중).\n' +
          '  등록을 풀고 다시 돌려라:\n' +
          '    Get-AppxPackage *BluemingMenu.ShellExt* | Remove-AppxPackage',
      );
    }
    throw err;
  }
  fs.mkdirSync(path.join(dist, 'Assets'), { recursive: true });

  fs.copyFileSync(
    path.join(base, 'target', 'release', 'blueming_shell_ext.dll'),
    path.join(dist, 'blueming_shell_ext.dll'),
  );
  fs.copyFileSync(path.join(base, 'AppxManifest.xml'), path.join(dist, 'AppxManifest.xml'));

  // 로고 3종. MSIX 는 정확한 픽셀 크기를 요구하지만 개발 등록(`-Register`)에서는 검증이 느슨하다.
  const logo = path.join(repo, 'assets', 'icons', 'build', 'icon-256.png');
  for (const name of ['StoreLogo.png', 'Square150x150Logo.png', 'Square44x44Logo.png']) {
    fs.copyFileSync(logo, path.join(dist, 'Assets', name));
  }

  // 메뉴 항목에 붙는 아이콘. DLL 이 자기 폴더에서 `icon.ico` 를 찾는다 (lib.rs 의 GetIcon).
  fs.copyFileSync(path.join(repo, 'assets', 'icons', 'icon.ico'), path.join(dist, 'icon.ico'));

  /*
   * 매니페스트가 Application/Executable 을 요구한다. 셸 확장만 제공하므로 실제로 실행될 일은
   * 없지만(AppListEntry="none") 등록 시 파일 존재 검증에 걸린다. 자리만 채운다.
   */
  fs.writeFileSync(path.join(dist, 'BluemingMenu.exe'), '');

  console.log(`[native] 셸 확장 조립 완료 — ${dist}`);
}

const cargo = cargoCommand();
if (!cargo) {
  console.error(
    '[native] cargo 를 찾지 못했다.\n' +
      '  rustup 설치 후 GNU 툴체인을 받아라:\n' +
      '    winget install Rustlang.Rustup\n' +
      '    rustup toolchain install stable-x86_64-pc-windows-gnu',
  );
  process.exit(1);
}

build(cargo, 'native/hotkey', '단축키 훅');
build(cargo, 'native/shell-ext', '셸 확장');
assembleShellExt();

console.log('[native] 완료');
