# [Claude 작성] 2026-08-18 세션 로그 (part2) — 1단계 UI 본체 + 네이티브 통합 + 빌드 체계 전환

<!-- HANDOFF_BEGIN -->
## 이어받기 ★

- **세션 성격**: 기초 UI(7x7 그리드·드래그·폴더) → 트레이/플로팅 → 아이콘 추출 3회 교체 →
  탐색기 1급 컨텍스트 메뉴(Rust COM) → 전역 단축키(Rust 훅) → **Forge → electron-vite 전환** →
  NSIS 인스톨러 → Codex 리뷰 반영
- **저장소/브랜치**: `comonetso/WorkSpace-LocalSpace-Electron-BluemingMenu` / `main`
  · **기준 커밋**: `3b701ff` · **remote**: 있음 (SSH)
- **미커밋 변경**: 이 커밋으로 전부 정리됨

**현재 상태**
- 목표: 1단계 본체를 실사용 가능한 수준까지 올리고 설치본을 만든다
- 완료: 패널·플로팅·트레이·드래그/폴더·아이콘 추출·탐색기 1급 메뉴·전역 단축키(Win+Alt)·
  단축키 설정 창·NSIS 설치본·Codex 리뷰 14건 반영
- 미완료: **NSIS 설치/제거 시 셸 확장 자동 등록** (지금은 `scripts/setup-installed.ps1` 수동 실행)

**다음 한 줄 액션**
- `native/shell-ext` 를 NSIS `installer.nsh` 에서 `Add-AppxPackage` / `Remove-AppxPackage` 하도록
  붙인다. 실패해도 설치 자체는 막히지 않게 처리할 것

**검증 상태**

| 항목 | 문법/컴파일 | 테스트 | 실기기·실환경 | 사용자 확인 |
|---|---|---|---|---|
| 패널 열림 애니메이션 | 통과 | 없음 | 개발 실행 확인 | ✅ "깜빡임 사라짐" |
| 트레이/플로팅 토글 | 통과 | 없음 | 개발 실행 확인 | ✅ |
| 전역 단축키 Win+Alt | 통과 | 없음 | 개발 실행 확인 | ✅ "잘 먹어" |
| 탐색기 1급 메뉴 등록/제거 | 통과 | 없음 | 실제 우클릭 동작 확인 | ✅ |
| 아이콘 추출(일괄) | 통과 | 없음 | 178개 중 177개 성공 | ✅ |
| 아이콘 추출(단건 등록) | 통과 | 없음 | **원인 수정 후 미검증** | ❌ |
| NSIS 설치본 | 통과 | 없음 | 설치·실행 확인 | 부분 (아이콘 재확인 필요) |
| 단축키 설정 창 | 통과 | 없음 | **미검증** | ❌ |
| Codex 지적 14건 수정 | 통과 | 없음 | **미검증** | ❌ |

**미해결 항목**
- 즉시 처리: 없음
- 검증 미완:
  - **단건 등록 아이콘** — `Get-Content` 배열화 수정 후 실제 등록으로 확인 안 했다.
    설치본을 새로 깔고 탐색기에서 아무거나 등록해 아이콘이 나오는지 봐야 한다
  - **단축키 설정 창** — 만들고 빌드까지 했으나 한 번도 열어보지 않았다
  - **Codex 지적 수정분 14건** — 컴파일만 통과. 특히 훅 고아 방지(`--parent-pid`)와
    셸 확장 파이프 타임아웃은 실제로 그 상황을 만들어 봐야 한다
- 별도 트랙:
  - NSIS 설치/제거 시 셸 확장 자동 등록 (Codex P1 지적, 범위 문제로 보류)
  - 임포트 범위 필터 — 178개 전부 가져오는 게 맞는지 미결정 (`DIRECTION.md` 5.1)

**⚠️ 다음 세션 주의**
- 🔴 **`src/windows/panel.ts` 의 `hidePanel()` 을 `hide()` 로 되돌리지 마라.**
  `win.hide()` 는 Chromium 이 창의 합성 표면을 버리게 만들고, 다시 `show()` 할 때
  **두 번째 열기부터 매번 깜빡인다.** 지금은 `setOpacity(0)` + `setIgnoreMouseEvents(true)` 다
- 🔴 **`src/windows/floating.ts` 에서 `setPosition()` 을 쓰지 마라.**
  배율 1.3959 환경에서 논리↔물리 왕복 반올림이 누적돼 **창이 계속 커진다.**
  언제나 `applyBounds()` 로 크기를 함께 지정한다
- 🔴 **`icon-extractor.ts` 의 PowerShell 스크립트에서 `@(Get-Content ...)` 의 괄호를 지우지 마라.**
  한 줄일 때 문자열이 반환돼 첫 글자만 읽히고 **단건 등록이 100% 실패**한다
- 🔴 PowerShell 스크립트는 TS 템플릿 리터럴 안에 있다. **백틱을 쓰면 리터럴이 끊긴다** (두 번 당했다).
  탭은 `[char]9`, 주석에도 백틱 금지
- 🔴 **`native/**/target/` 과 `blueming-menu.config.json` 은 `.gitignore` 에 있다.** 되돌리지 마라
  (257MB + 사용자명·절대경로 유출)
- 🔴 `AppsFolder` · `CloudStore` · `AppResolver` · `StateRepository` · `start2.bin` 경유 금지 (변함없음)
- ⚠️ 셸 확장이 등록돼 있으면 **탐색기가 DLL 을 물고 있어 재빌드가 EPERM 으로 막힌다.**
  `Get-AppxPackage *BluemingMenu.ShellExt* | Remove-AppxPackage` 후 빌드하고 다시 등록한다
- ⚠️ Claude Code 셸은 `ELECTRON_RUN_AS_NODE=1` 을 상속시킨다. `npm start` 는 반드시
  `scripts/run-electron-vite.mjs` 를 거쳐야 한다 (빈 값으로 덮는 것으로는 안 된다)

**메모리**: [[electron-vite-build-stack]] · [[native-integration-map]] · [[windows-api-traps]] (신규)
<!-- HANDOFF_END -->

---

## 1. 작업 흐름

### 1-1. 기초 UI — 실측 기반 치수 확정
**배경/요구**: 사용자가 "시작 메뉴와 동일한 크기·애니메이션, 7x7 그리드" 를 지정.
**처리**: 시작 메뉴 스크린샷을 물리 픽셀로 재고 배율(2560/1834 = 1.3959)로 나눠 논리 픽셀 확정.
셀 96x86 · 아이콘 32 · 여백 32. `src/config.ts` 에 근거와 함께 고정.
**결과**: 아이콘 32는 `app.getFileIcon('normal')` 과 정확히 일치 — 실측이 맞다는 교차 근거가 됐다.

### 1-2. 병렬 에이전트로 UI 골격 구축
10개 파일을 에이전트에 나눠 동시 작성. **IPC 채널과 DOM 클래스 이름을 먼저 고정**하고
각 에이전트에 계약으로 배포했다. 시그니처 불일치 0건.

### 1-3. 아이콘 추출 — 세 번 갈아엎었다
`DIRECTION.md` 5.3 과 `src/icon-extractor.ts` 머리말에 실측표로 남겼다. §3 참조.

### 1-4. 탐색기 1급 컨텍스트 메뉴
사용자가 스크린샷으로 "네모친 영역에 다른 앱들은 들어가 있다" 고 지적.
실측해보니 반디집·PowerToys·VS Code 전부 **MSIX 패키지 + `SignatureKind=Developer`** 였다.
→ 상용 인증서가 필수가 아니라는 뜻. Rust COM DLL + Sparse MSIX 로 구현.

### 1-5. 전역 단축키
`globalShortcut` 은 수식키 조합을 등록조차 못 한다. Rust 저수준 훅 프로세스로 분리.
**키를 삼키지 않고 감시만** 하므로 `Win+E` 등 기존 조합이 전부 산다.

### 1-6. Forge → electron-vite + electron-builder
사용자가 "표준 인스톨러" 를 요구. Forge 에서 MSI 는 WiX + .NET 3.5 가 필요해 막혔고,
같은 워크스페이스의 **BluemingWiki 가 electron-vite + NSIS 로 잘 돌고 있어** 그 구성을 따랐다.

---

## 2. 의사결정 로그

| 결정 | 근거 | 검토한 대안 | 트레이드오프 |
|---|---|---|---|
| 셀·아이콘 크기 기준 (패널이 커짐) | 사용자 선택 | 패널 크기 고정하고 셀 축소 | 7x7 패널이 시작 메뉴보다 크다 |
| 설정 저장 = 포터블 | 사용자 선택 | `%APPDATA%` | 설치 위치에 따라 폴백 필요해짐 |
| 단축키 = Win+Alt | 사용자 지정 | Ctrl+Shift(입력 언어 충돌 우려) | 이 PC 는 입력 언어가 하나뿐이라 충돌 없음 |
| 등록 항목을 **맨 앞**에 추가 | "등록이 안 된다" 반복 보고. 실제로는 178개 끝에 붙어 안 보였다 | 맨 뒤 유지 | 기존 배치가 한 칸씩 밀린다 |
| 네이티브 툴체인 = Rust **GNU** | MSVC 는 VS Build Tools 3~5GB + 관리자 권한. winget 무인 설치가 UAC 로 실패 | MSVC | COM DLL 링킹 사례가 적음 (실측으로 정상 확인) |
| 셸 확장 자동 등록 보류 | `installer.nsh` 작성·검증 시간 부족 | 이번에 처리 | 지금은 수동 스크립트 필요 |

---

## 3. 시행착오

### 3-1. 아이콘 추출 — 세 번 틀렸다
- **잘못된 가정 ①**: "dataURL 이 짧으면 빈 아이콘이다" → **틀렸다.** 단순한 아이콘일수록 PNG 가 작다.
  AnyDesk(911B)를 이미지로 꺼내 보니 멀쩡했다
- **잘못된 가정 ②**: "`.lnk` 로 뽑으면 더 정확하다" → **더 나빠졌다.** 137개 **전부** 바로가기
  기본 아이콘(파란 문서+화살표)이 됐다
- **발견 경위**: 실패한 것들의 dataURL 길이가 **전부 똑같다**(992B, 나중엔 1346B)는 점.
  같은 크기 = 같은 이미지 = 같은 기본 아이콘
- **복구**: Electron `getFileIcon` 을 버리고 .NET `ExtractIconEx` + `.lnk` 의 `icon`/`iconIndex` +
  **환경변수 확장**(`%SystemRoot%` 가 그대로 들어 있었다)
- **교훈**: 크기가 여러 개 똑같으면 그 자체가 단서다. 그리고 **추측 대신 이미지를 꺼내 눈으로 봐라**

### 3-2. 깜빡임 — 애니메이션이 아니라 창 표면 문제였다
- **잘못된 가정**: "애니메이션 트리거가 중복된다" → 두 라운드를 타이밍 조정에 썼다
- **발견 경위**: 렌더러 콘솔을 메인 터미널로 중계하는 코드를 심자 **즉시** 드러났다.
  `arm` 1회 / `release` 1회로 정상이었고, 로그에는 `hidePanel → togglePanel(visible=false) → showPanel`
  이 찍혀 있었다. 즉 **닫혔다 다시 열리는 것**이 깜빡임의 정체
- **교훈**: **로그 중계를 먼저 붙였어야 했다.** 붙이자마자 두 건 다 원인이 즉시 나왔다

### 3-3. 단건 등록 아이콘 — PowerShell 의 함정
- **증상**: 일괄 스캔은 178개 중 177개 성공하는데, 탐색기로 등록한 것만 **100% 실패**
- **원인**: `Get-Content` 는 줄이 하나뿐이면 배열이 아니라 `[string]` 을 반환한다.
  그러면 `$lines[0]` 이 첫 줄이 아니라 **첫 글자**(`C`)가 되고 필드 분리가 깨진다
- **복구**: `@(Get-Content ...)` 로 강제 배열화. PowerShell 로 직접 재현해 증명했다
- **교훈**: "여러 개는 되는데 하나만 안 된다" 는 **배열/스칼라 경계**를 의심하라

### 3-4. 설치본이 설정을 저장하지 못했다
`perMachine: true` → `C:\Program Files` 설치 → **쓰기 권한 없음** → 매 실행마다 재임포트.
사용자에게는 "등록해도 사라진다" 로 보였다. `perMachine: false` + `isSystemLocation()` 폴백으로 해결.

---

## 4. 발견한 코드베이스 함정

**1. `win.hide()` 는 Chromium 의 창 합성 표면을 버린다**
다시 `show()` 하면 표면을 새로 만드는데 첫 프레임 전 빈 구간이 화면에 스친다.
"최초엔 안 깜빡, 두 번째부터 깜빡" 이라는 비대칭이 이것 말고는 설명되지 않는다.
→ `setOpacity(0)` + `setIgnoreMouseEvents(true)` + `blur()` 로 감춘다. `isVisible()` 이 항상 true 가
되므로 열림 판정은 **자체 플래그**(`panelOpen`)로 한다.

**2. `setPosition()` 은 창 크기를 되먹인다**
Electron 내부에서 `SetBounds(위치, getSize())` 로 바뀌는데, Chromium 의 논리↔물리 변환이
`ScaleToEnclosingRect`(바깥 반올림)라 정수배가 아닌 배율에서 **왕복마다 최대 1px 커지기만 한다.**
드래그는 초당 수십~수백 번 이 경로를 지나가므로 몇 초 만에 화면을 덮는다.
→ 언제나 `setBounds` 로 크기를 명시한다. 패널이 멀쩡했던 이유도 이것이다.

**3. blur 가 클릭보다 먼저 온다**
트레이·플로팅을 누르면 `blur → hidePanel()` 이 먼저 돌고 그 다음 `click → togglePanel()` 이
"닫혀 있네" 하고 다시 연다. 결과적으로 **아무리 눌러도 안 닫힌다.**
→ 시간 유예를 쓰지 않고 **blur 시점의 커서 좌표**가 토글 버튼 영역 안인지로 판정한다.

**4. `app.getFileIcon()` 은 실패해도 기본 아이콘을 돌려준다**
`isEmpty()` 가 false 라 코드에서 감지할 수 없다. Office(Click-to-Run)·Orca 등이 여기 해당했다.
→ .NET `ExtractIconEx` 로 갈아탔다. `.lnk` 의 `icon` 필드에는 **환경변수가 그대로** 들어 있어
`ExpandEnvironmentVariables` 가 필수다. `SHELL32.dll` 을 공유하고 `iconIndex` 로만 갈리는 항목이 많다.

**5. `Get-Content` 는 한 줄이면 문자열을 반환한다**
`$lines[0]` 이 첫 글자가 된다. `@()` 로 강제 배열화해야 한다.

**6. PowerShell 스크립트를 TS 템플릿 리터럴에 담으면 백틱이 리터럴을 끊는다**
`` `t ``(탭)와 주석의 백틱 모두. → `[char]9` 를 쓰고 주석에도 백틱을 넣지 않는다.

**7. Windows 의 topmost 는 층이 하나뿐이다**
Electron 의 `level` 인자(`'screen-saver'`)는 macOS 개념이고 Windows 에서는 접힌다.
작업표시줄도 같은 층이라 클릭하면 explorer 가 자기를 위로 올려 우리 창이 밀린다.
→ 설정값 문제가 아니라 **뺏긴 순서를 되찾는** 문제다. `setAlwaysOnTop` 왕복이
`SWP_NOACTIVATE` 를 달고 나가므로 포커스를 훔치지 않는다.

**8. `nativeImage.createFromPath()` 는 asar 안을 못 읽는다**
네이티브 코드라 asar 가상 경로를 모른다. 조용히 빈 이미지가 되어 트레이 아이콘이 빈 사각형이 된다.
개발 중에는 asar 가 없어 멀쩡하므로 **패키징 후에만 드러난다.** → `extraResources` 로 뺀다.

**9. Windows 11 1급 컨텍스트 메뉴는 MSIX 패키지 identity 를 요구한다**
레지스트리 verb 는 "추가 옵션 표시" 하위로 밀린다. 다만 **상용 인증서는 필수가 아니다** —
실측한 반디집·PowerToys·VS Code 전부 `SignatureKind=Developer` 였고, 개발자 모드에서는
`Add-AppxPackage -Register` 로 서명 없이 등록된다.

**10. `AllowExternalContent` 를 선언하면 `-ExternalLocation` 이 필수다**
빠뜨리면 `0x80073CF9`. `win32App` 동작에는 `runFullTrust` capability 선언도 필요하다(`0x80080204`).

**11. Claude Code 셸이 `ELECTRON_RUN_AS_NODE=1` 을 상속시킨다**
Electron 이 순수 Node 로 떠서 `require('electron').app` 이 undefined 가 된다.
**빈 값으로 덮는 것으로는 안 된다** — 변수의 존재만으로 판정하므로 완전히 `delete` 해야 한다.
Forge 는 내부에서 처리해 줬고 electron-vite 는 안 한다.

---

## 5. 사용자 핵심 발언

- > "지금 삭제하고 재설치하고 있어" / "내가 똥개냐?"
  — 재설치가 필요하다는 것을 **먼저** 말하지 않고 물어본 뒤에야 답했다.
  **전제 조건이 바뀌면 지시를 완결된 형태로 먼저 준다.**
- > "다른 일렉트론 앱은 그냥 되던데, 왜 여기서만?"
  — 도구 선택 차이(Forge vs electron-builder)를 설명 없이 "불가능" 으로 답했던 것에 대한 지적.
  **"불가능" 이라 말하기 전에 조건을 명시하라** (JavaScript 만으로는 / 이 도구로는).
- > "네가 해, 빨리 만들어"
  — 방법을 나열하고 고르게 하는 것보다 **판단해서 실행**하기를 원한다.

---

## 8. 변경 파일 인벤토리

```
신규 — 앱
M src/config.ts            실측 레이아웃 상수 (근거 주석 포함)
M src/types.ts             공용 타입
M src/store.ts             포터블 설정 + 설치 형태별 경로 분기
M src/ipc.ts               IPC 채널 상수 (단일 진실원)
M src/scanner.ts           .lnk 스캔 + 단건 읽기
M src/icon-extractor.ts    PowerShell + ExtractIconEx 일괄 추출
M src/pipe.ts              named pipe 서버 (셸 확장·훅 클라이언트)
M src/hotkey.ts            훅 프로세스 수명 관리
M src/menus.ts             트레이·플로팅 공유 메뉴 템플릿
M src/tray.ts              트레이 아이콘
M src/windows/paths.ts     렌더러 로딩 규약 (빌드 도구 의존 격리)
M src/windows/panel.ts     패널 창 (opacity 방식 · blur 판정)
M src/windows/floating.ts  플로팅 창 (크기 고정 · topmost 재주장)
M src/windows/hotkey-dialog.ts  단축키 설정 창
M src/ui/{grid,dnd,floating,hotkey}.ts  렌더러 UI

신규 — 네이티브
M native/hotkey/           Rust 저수준 키보드 훅 프로세스
M native/shell-ext/        Rust COM DLL (IExplorerCommand) + Sparse MSIX

신규 — 빌드/스크립트
M electron.vite.config.ts        3계층 빌드
M scripts/build-native.mjs       Rust 빌드 + MSIX 조립
M scripts/run-electron-vite.mjs  ELECTRON_RUN_AS_NODE 회피 래퍼
M scripts/setup-installed.ps1    설치 후 설정 이전 + 셸 확장 등록

수정
M package.json             electron-vite + electron-builder(NSIS)
M .gitignore               Cargo target(257MB) · config.json 제외
M src/main.ts              조립부 + IPC + 마이그레이션
M src/renderer.ts          창별 분기 + 애니메이션 + 스크롤 보존
M src/index.css            시작 메뉴풍 다크 (불투명)
M src/i18n/{ko,en}.json    트레이·단축키·컨텍스트 메뉴 문자열
M docs/DIRECTION.md        확정 사항 반영 (3.7 · 3.8 신설, 5장 갱신)
M forge.config.ts          유지 (전환 롤백용)
```
