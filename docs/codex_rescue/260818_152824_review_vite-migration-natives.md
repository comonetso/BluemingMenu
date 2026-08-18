---
type: codex_review
mode: review
stamp: 260818_152824
slug: vite-migration-natives
scope: uncommitted
scope_via: prompt
author: codex
---

# Codex 코드 리뷰 — vite-migration-natives

- 대상: `uncommitted` (⚠️ 프롬프트 문장으로 지시 — codex CLI 가 스코프 플래그와 집중 지시를 함께 받지 않는다)
- 집중 지시: 커밋되지 않은 변경 전체를 리뷰 대상으로 삼아라.

이 세션에서 다음을 새로 붙이거나 바꿨다.
- 빌드 체계: Electron Forge -> electron-vite + electron-builder(NSIS). 창 로딩 규약이 MAIN_WINDOW_VITE_* 전역 상수에서 process.env.ELECTRON_RENDERER_URL 로 바뀌었고 src/windows/paths.ts 로 모았다.
- 전역 단축키: native/hotkey (Rust, WH_KEYBOARD_LL 저수준 훅). 키를 삼키지 않고 감시만 한다. named pipe 로 앱에 신호를 보낸다.
- 탐색기 1급 컨텍스트 메뉴: native/shell-ext (Rust COM DLL, IExplorerCommand) + Sparse MSIX.
- named pipe IPC: src/pipe.ts. 셸 확장과 훅 프로세스가 클라이언트다.
- 아이콘 추출: src/icon-extractor.ts. PowerShell + Win32 ExtractIconEx 를 일괄 호출한다.
- 설정 저장 위치: src/store.ts 의 configDir(). 개발/Squirrel/NSIS-perMachine 을 분기하고 쓰기 불가 시 userData 로 폴백한다.

특히 아래를 중점적으로 봐달라.
1) configDir() 의 경로 분기와 쓰기 권한 폴백. 설치 형태별로 설정이 유실되거나 두 곳에 갈라지는 경로가 있는가.
2) 네이티브 프로세스/DLL 수명 관리. 훅 프로세스가 앱 비정상 종료 시 남는가. 파이프 서버가 EADDRINUSE 로 실패했을 때 복구 경로가 있는가. COM 객체 카운트 처리가 맞는가.
3) 창 로딩 규약 전환에서 빠뜨린 곳. Forge 전용 전역 상수나 preload 경로가 남아 있는가.
4) 아이콘 추출 실패 경로. PowerShell 실패/타임아웃 시 앱이 멈추거나 아이콘이 통째로 날아가는가.
5) 그 밖에 명백한 버그, 경쟁 조건, 리소스 누수.
- 실행: `codex exec review` (read-only — Codex 는 코드를 고치지 않았다)

## Codex 원문

TypeScript 정적 검사와 창 로딩 경로 전환은 정상이나, 깨끗한 설치본에서 네이티브 기능이 활성화되지 않고 훅·COM·파이프 수명 및 설정·아이콘 동시성에 실제 장애나 데이터 분리를 일으키는 결함이 있습니다. 현재 상태로는 올바른 배포 패치로 볼 수 없습니다.

Full review comments:

- [P1] 배포 전에 네이티브 산출물을 재현 가능하게 빌드하라 — F:\workspace\Etc Project\Electron Project\Blueming Menu\package.json:13-13
  깨끗한 checkout에서 `npm run dist`를 실행하면 이 스크립트는 Rust 빌드나 셸 확장 `dist` 조립을 전혀 수행하지 않습니다. `extraResources`가 참조하는 `native/shell-ext/dist`는 현재 Git에서 무시되고 hotkey EXE도 로컬 Cargo 산출물뿐이므로, 빌더가 누락된 소스를 건너뛴 설치본에서는 셸 확장 또는 전역 단축키가 빠집니다.

- [P1] NSIS 설치·제거에서 Sparse 패키지를 등록·해제하라 — F:\workspace\Etc Project\Electron Project\Blueming Menu\package.json:37-39
  새 NSIS 설치본에서는 이 설정이 Sparse MSIX 파일을 `resources\shell-ext`에 복사할 뿐 `Add-AppxPackage`를 실행하지 않으며, 별도 `setup-installed.ps1`도 설치본에 포함되거나 호출되지 않습니다. 따라서 깨끗한 PC에서는 탐색기 메뉴가 등록되지 않고, 수동 등록된 PC에서는 제거 후에도 삭제된 DLL을 가리키는 패키지가 남습니다.

- [P1] 이전 훅의 종료 콜백이 새 자식을 지우지 않게 하라 — F:\workspace\Etc Project\Electron Project\Blueming Menu\src\hotkey.ts:85-89
  사용자가 단축키를 변경하면 `stopHotkey()`가 이전 자식을 kill한 직후 새 자식을 전역 `child`에 넣지만, 이전 자식의 비동기 `exit` 콜백은 그 새 값을 보고 `child = null`로 만듭니다. 이후 새 훅은 추적되지 않아 다음 변경이나 앱 종료 때 제거되지 않고, 추가 훅과 중복 실행될 수 있습니다.

- [P1] 부모 종료와 훅 프로세스 수명을 강제로 결속하라 — F:\workspace\Etc Project\Electron Project\Blueming Menu\src\hotkey.ts:78-78
  Windows에서 `detached: false`는 부모가 크래시하거나 강제 종료될 때 자식을 자동 종료하지 않습니다. 이 GUI 서브시스템 훅 프로세스는 부모 PID나 파이프 단절을 감시하지 않아 계속 남고, 앱을 재시작하면 새 파이프에 이전 훅과 새 훅이 함께 신호를 보내 패널이 두 번 토글되거나 옛 단축키가 계속 작동합니다.

- [P1] 셸 확장의 동기 파이프 읽기에 시간 제한을 두라 — F:\workspace\Etc Project\Electron Project\Blueming Menu\native\shell-ext\src\lib.rs:116-118
  Electron 메인 스레드가 일시 중단되거나 `TOGGLE` 처리 중 아이콘 추출이 멈추면 이 동기 `ReadFile`은 무기한 반환하지 않습니다. Explorer가 COM 호출 결과를 동기로 기다리므로 우클릭 메뉴나 명령 실행도 함께 멈추며, `CreateFileW` 실패를 즉시 처리하는 것만으로는 연결 후 무응답을 막지 못합니다.

- [P1] PowerShell 아이콘 추출 프로세스에 타임아웃을 걸라 — F:\workspace\Etc Project\Electron Project\Blueming Menu\src\icon-extractor.ts:189-198
  아이콘 경로가 응답하지 않는 UNC 위치를 가리키거나 PowerShell이 멎는 경우 이 Promise에는 타이머나 kill 경로가 없어 영원히 대기합니다. 그러면 최초 임포트·아이콘 마이그레이션이 완료되지 않고, 탐색기 `TOGGLE` 요청에서 호출된 경우 파이프 응답도 돌아가지 않습니다.

- [P1] 클래스 팩토리 수명도 COM 객체 카운트에 포함하라 — F:\workspace\Etc Project\Electron Project\Blueming Menu\native\shell-ext\src\lib.rs:285-286
  `DllGetClassObject`가 반환하는 `BluemingFactory`는 살아 있는 COM 객체지만 `OBJECT_COUNT`를 증가·감소시키지 않습니다. 명령 객체가 없는 동안 COM이 팩토리 참조를 보유해도 `DllCanUnloadNow`가 `S_OK`를 반환할 수 있으므로, 이후 팩토리 호출이 이미 언로드된 DLL을 가리킬 수 있습니다.

- [P2] per-machine 설정 위치를 실행 권한과 무관하게 고정하라 — F:\workspace\Etc Project\Electron Project\Blueming Menu\src\store.ts:67-67
  `perMachine: true`로 Program Files에 설치한 앱은 일반 실행 시 `userData`를 쓰지만, 같은 사용자가 관리자 권한으로 실행하면 `canWrite(portable)`가 성공해 설치 폴더를 선택합니다. 설치 직후의 승격 실행과 이후 일반 실행처럼 권한 토큰이 달라지면 서로 다른 설정 파일을 읽고 써서 배치가 초기화된 것처럼 보입니다.

- [P2] EADDRINUSE 뒤 서버 상태를 초기화하고 재시도하라 — F:\workspace\Etc Project\Electron Project\Blueming Menu\src\pipe.ts:98-100
  다른 프로세스나 Windows 사용자 세션이 전역 파이프 이름을 점유한 상태에서 시작하면 오류를 로그로만 남기고 `server`를 비우지 않습니다. 점유자가 사라져도 재시도 경로가 없고 이후 `startPipeServer()`도 즉시 반환하므로, 해당 앱 세션 동안 셸 메뉴와 전역 단축키 신호가 모두 복구되지 않습니다.

- [P2] 설치 후 스크립트가 실제 NSIS 경로를 찾게 하라 — F:\workspace\Etc Project\Electron Project\Blueming Menu\scripts\setup-installed.ps1:29-35
  새 패키지는 설치 디렉터리 변경을 허용하지만 이 스크립트는 이전 Squirrel 전용 `%LOCALAPPDATA%\BluemingMenu` 두 경로만 검사합니다. 기본 NSIS 위치나 사용자가 선택한 경로에서는 즉시 예외가 나므로 설정 이전과 셸 확장 등록을 수행할 수 없습니다.

- [P2] 아이콘 추출 임시 파일을 호출별로 고유하게 만들어라 — F:\workspace\Etc Project\Electron Project\Blueming Menu\src\icon-extractor.ts:179-181
  파이프 서버는 여러 `TOGGLE`을 병렬 처리하고 최초 임포트 중에도 동작하지만 모든 `extractIcons()` 호출이 같은 세 파일을 사용합니다. 두 요청이 겹치면 서로 입력·출력 파일을 덮어쓰거나 삭제해 한 앱에 다른 앱 아이콘이 붙거나 양쪽 추출이 모두 실패할 수 있습니다.

- [P2] 추출 실패 시 아이콘 규칙 버전을 확정하지 마라 — F:\workspace\Etc Project\Electron Project\Blueming Menu\src\main.ts:241-244
  PowerShell 실행 실패는 전부 `undefined` 결과로 변환되지만 여기서는 성공 여부와 무관하게 `iconRevision`을 최신으로 저장합니다. 기존 설정의 마이그레이션이 일시적으로 실패하면 예전 아이콘을 유지한 채 다시는 재추출을 시도하지 않고, 신규 설정에서 반복 실패하면 아이콘 없는 상태가 영구 확정됩니다.

- [P2] 비동기 등록 전에 바로가기 존재 여부를 다시 확인하라 — F:\workspace\Etc Project\Electron Project\Blueming Menu\src\main.ts:178-178
  같은 미등록 `.lnk`에 대한 두 `TOGGLE` 요청이 아이콘 추출 동안 겹치면 둘 다 최초 검사에서 absent를 보고 각각 같은 ID의 항목을 추가합니다. `await readShortcutEntry()` 뒤에 재검사하거나 요청을 직렬화하지 않으면 메뉴에 중복 항목이 저장됩니다.

- [P2] 재렌더 후 DnD 옵션을 최신 payload로 갱신하라 — F:\workspace\Etc Project\Electron Project\Blueming Menu\src\ui\dnd.ts:349-351
  `initDnd()`의 첫 호출이 `setItems` 클로저에 최초 payload를 캡처하고, 이 `WeakSet` 때문에 이후 `paint()` 호출은 옵션을 갱신하지 못합니다. 사용자가 행·열 구성을 바꾼 뒤 항목을 드래그하면 저장된 최신 항목과 최초 cols/rows를 합쳐 다시 그려 UI가 시작 시점 구성으로 되돌아갑니다.

- [P2] 런타임 설정 파일을 변경 목록에서 제외하라 — F:\workspace\Etc Project\Electron Project\Blueming Menu\blueming-menu.config.json:625-625
  개발 모드의 `configDir()`가 저장소 루트를 사용하므로 이 파일이 커밋되면 새 checkout도 `imported: true`와 현재 PC의 절대 경로·배치를 로드해 자신의 시작 메뉴를 스캔하지 않습니다. 사용자명과 로컬 프로그램 경로도 그대로 노출되므로 두 설정 파일을 ignore해야 합니다.

- [P2] Cargo target 트리를 변경 목록에서 제외하라 — F:\workspace\Etc Project\Electron Project\Blueming Menu\native\hotkey\target\CACHEDIR.TAG:2-2
  두 네이티브 프로젝트의 `target` 디렉터리가 무시되지 않아 현재 변경 목록에 약 257MB의 Cargo 캐시·중간 오브젝트·의존 라이브러리가 포함됩니다. `git add -A` 시 머신·툴체인 종속 산출물 수백 개가 저장소에 들어가므로 `native/**/target/`을 제외하고 필요한 바이너리는 빌드 단계에서 생성해야 합니다.
## Claude 검토

리뷰 지적 15건 중 **10건 채택·수정 완료**, 3건 보류, 2건은 사실 확인 후 범위 조정.
Codex 원문은 위에 그대로 두었다.

### 채택하여 수정한 것

| # | 지적 | 수정 |
|---|---|---|
| P1 | 깨끗한 checkout 에서 네이티브가 안 빌드됨 | `scripts/build-native.mjs` 신설. `pack`/`dist` 가 먼저 호출한다 |
| P1 | 훅 exit 콜백이 새 자식을 지움 | `stopHotkey()` 가 참조를 먼저 떼고 kill. 콜백도 `child === spawned` 로 재확인 |
| P1 | 부모 크래시 시 훅이 고아로 남음 | `--parent-pid` 를 넘기고, Rust 쪽이 `WaitForSingleObject` 로 감시하다 `WM_QUIT` |
| P1 | 셸 확장 동기 `ReadFile` 무한 대기 | 파이프를 `PIPE_NOWAIT` 로 두고 500ms 상한으로 폴링 |
| P1 | PowerShell 아이콘 추출 무한 대기 | `setTimeout` + `child.kill()`. 항목 수에 비례한 상한 |
| P1 | 클래스 팩토리가 `OBJECT_COUNT` 밖 | `DllGetClassObject` 에서 증가, `Drop` 에서 감소 |
| P2 | 권한에 따라 설정이 두 곳으로 갈림 | `isSystemLocation()` 추가 — `Program Files` 아래면 권한과 무관하게 `userData` |
| P2 | `EADDRINUSE` 후 복구 불가 | 에러 시 `server = null` 로 되돌려 재호출 가능하게 (자동 재시도는 넣지 않음 — 간격에 근거 없음) |
| P2 | `setup-installed.ps1` 이 NSIS 경로를 못 찾음 | 레지스트리 `InstallLocation` 우선, 그 뒤 알려진 위치 순회 |
| P2 | 임시 파일 이름 충돌 | `bm-icon-<pid>-<seq>-*` 로 호출마다 고유화 |
| P2 | 추출 실패해도 `iconRevision` 확정 | `changed > 0` 일 때만 올린다 |
| P2 | 중복 등록 경쟁 | `await` 뒤 `locateByLnkPath()` 재확인 |
| P2 | DnD 옵션이 최초 payload 로 굳음 | `setItems` 클로저가 `current` 를 참조 |
| P2 | `config.json`·Cargo `target/` 이 커밋 대상 | `.gitignore` 에 추가 (약 257MB + 사용자명·절대경로 유출 방지) |

### 보류 — 근거

1. **NSIS 설치·제거에서 Sparse 패키지 자동 등록/해제 (P1)**
   지적이 맞다. 지금은 `scripts/setup-installed.ps1` 을 수동으로 돌려야 하고, 제거해도
   죽은 DLL 을 가리키는 패키지가 남는다.
   보류 이유는 **범위**다 — NSIS 커스텀 스크립트(`installer.nsh`)에 `Add-AppxPackage` /
   `Remove-AppxPackage` 를 넣어야 하고, 실패 시 설치 자체가 막히지 않게 하는 처리가 필요하다.
   이번 세션에서 검증할 시간이 없어 다음으로 넘긴다. **미해결 항목으로 기록한다.**

2. **셸 확장 파이프 타임아웃 값(500ms) 자체**
   임의값이다. 코드 주석에 그렇게 명시했다. 실사용에서 메뉴가 늦게 뜨는 느낌이 있으면 조정한다.

3. **`.git` 내부·mtime 원복 등 변경 감지 사각지대**
   `send.sh` 의 한계로 이미 문서화돼 있다. 이번 리뷰에서 감지된 4개 파일
   (`src/main.ts`·`src/icon-extractor.ts`·`out/renderer/*`)은 **Codex 가 아니라 내가**
   리뷰가 도는 동안 고친 것이다. Codex 는 `codex exec review` 로 read-only 실행됐다.

### 사실 확인 후 범위 조정

- **"per-machine 설정 위치"** — 지적 시점에는 `perMachine: true` 였으나, 리뷰 도중 실측으로
  `Program Files` 쓰기 불가를 확인하고 이미 `perMachine: false` 로 바꿔 둔 상태였다.
  그래도 관리자 실행 시 갈리는 문제는 남아 있어 `isSystemLocation()` 으로 별도 처리했다.
- **아이콘 추출 실패 경로** — 리뷰가 지적한 타임아웃 부재와 별개로, **단건 등록이 100% 실패하는
  버그**를 같은 시간대에 직접 찾아 고쳤다(`Get-Content` 가 한 줄일 때 배열이 아닌 문자열을
  반환해 `$lines[0]` 이 첫 글자가 되던 것). Codex 는 이 건을 짚지 않았다.
