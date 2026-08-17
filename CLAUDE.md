# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 이 프로젝트

Windows 11 시작 메뉴 **대체** 팝업 런처. Electron 앱이며 Windows 전용이다.

**`docs/DIRECTION.md` 가 이 프로젝트의 단일 진실원이다.** 요구사항·결정·미결정이 전부 거기 있고,
"살아있는 문서"라 결정이 바뀌면 그 파일을 고친다. 작업 전에 반드시 읽는다.

### 존재 이유를 깨뜨리지 말 것

이 PC 프로필은 **새로 설치한 앱이 시작 메뉴·검색에 나타나지 않는다**(원인 미규명). 이 앱은 그 장애를
우회하려고 만든다. 따라서 **`Start Menu\Programs` 아래의 `.lnk` 파일을 직접 읽는 것이 유일한 수집 경로다.**

- **AppsFolder · CloudStore · AppResolver · StateRepository 를 경유하는 코드를 넣지 마라.** 프로젝트가 무의미해진다
- **`start2.bin` 을 읽지도 쓰지도 않는다** (LZ4 + 비문서화 protobuf, 빌드마다 바뀜)
- **원본 `.lnk` 는 읽기 전용이다.** 이동·삭제·수정하지 않는다
- `Programs` 폴더를 실시간 추종하지 않는다. 최초 1회 임포트 후 자체 데이터로 관리한다

## 명령어

```bash
npm start            # 개발 실행 (Vite 핫리로드 + Electron 기동)
npm run package      # 패키징만 (설치본 없음)
npm run make         # 배포물 생성 → out/ 에 BluemingMenu.exe
npm run lint         # eslint --ext .ts,.tsx .
```

**테스트 프레임워크는 아직 없다.** 검증은 `npm start` 로 실제 창을 띄워서 한다.

`npm start` 는 포그라운드에서 블로킹되고 창을 닫아도 프로세스가 남을 수 있다. 백그라운드로 돌렸다면
`electron.exe` 잔여 프로세스를 확인하고 정리한다(전부 이 프로젝트 `node_modules` 것이다).

## 아키텍처

### Forge Vite 플러그인의 3-빌드 구조

`forge.config.ts` 가 **서로 다른 3개의 Vite 빌드**를 정의한다. 각자 별도 config 파일을 가진다.

| 대상 | 진입점 | config |
|---|---|---|
| main | `src/main.ts` | `vite.main.config.ts` |
| preload | `src/preload.ts` | `vite.preload.config.ts` |
| renderer | `index.html` (루트) | `vite.renderer.config.ts` |

**renderer 는 `forge.config.ts` 에서 `name: 'main_window'` 로 등록돼 있고, 이 이름이 전역 상수를 만든다.**

```ts
MAIN_WINDOW_VITE_DEV_SERVER_URL   // 개발 중에만 정의됨 → loadURL
MAIN_WINDOW_VITE_NAME             // 패키징 후 → loadFile(../renderer/<name>/index.html)
```

타입 선언은 `forge.env.d.ts` 의 `/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />`
한 줄에서 온다. **renderer 이름을 바꾸면 상수 이름도 같이 바뀐다** (`MAIN_WINDOW_` 접두사가 이름 유래).
`main.ts` 의 dev/prod 분기가 이 상수에 의존하므로 함께 고쳐야 한다.

### i18n — 프로세스마다 따로 init 한다

`src/i18n/` 에 i18next 설정과 `ko.json` / `en.json` 이 있다.

**메인과 렌더러는 메모리를 공유하지 않으므로 각 프로세스가 `initI18n()` 을 각각 호출해야 한다.**
언어의 단일 진실원은 메인이고, 변경은 IPC 로 렌더러에 통보한다.

```
resolveLocale(app.getLocale())   // ko-* 로 시작할 때만 'ko', 그 외는 전부 'en'
```

- `app.getLocale()` 은 **`ready` 이벤트 이후에야** 정확한 값을 준다
- **사용자에게 보이는 문자열은 전부 리소스로 뺀다.** 코드에 한글/영어를 직접 쓰지 않는다
- 로그·개발자용 에러 메시지는 번역 대상이 아니다
- 컨텍스트 메뉴(`HKCU` 레지스트리) 문구도 앱 언어를 따라가며, 언어 변경 시 레지스트리를 다시 쓴다
- 앱 이름 `Blueming Menu` 는 고유명사라 번역하지 않는다

## 이 환경 특유의 함정

읽어보지 않으면 반드시 밟는 것들이다.

**경로에 공백이 3개 있다** — `Etc Project` · `Electron Project` · `Blueming Menu`.
스크립트·빌드 설정·출력 경로에서 인용을 빠뜨리면 깨진다. (Forge + Vite 기동 자체는 검증 완료.)

**`packagerConfig.executableName: 'BluemingMenu'` 를 지우지 마라.** `productName` 이 `Blueming Menu`
(공백 포함)라 이 설정이 없으면 exe 파일명에 공백이 들어간다. 문서가 지정한 이름은 `BluemingMenu.exe` 다.

**창 배치는 `screen` 의 `workArea` 를 쓴다.** 작업표시줄이 이미 제외된 사각형이라 높이를 직접 빼지 않는다.
작업표시줄 정렬·위치·높이는 **런타임에 읽는다. 하드코딩 금지.**

**모니터 관련 3가지** (이 PC 실측):
1. 보조 모니터 X 좌표가 **음수(-1834)** 다. 주 모니터 기준 상대 계산을 하면 창이 화면 밖으로 나간다.
   `screen.getAllDisplays()` 의 `bounds` 를 그대로 쓴다
2. **양쪽 모니터 모두에 작업표시줄이 있다.** "주 모니터에만 있다"고 가정하지 않는다
3. DPI 스케일이 걸려 있다. 물리 픽셀이 필요한 계산에서는 `display.scaleFactor` 를 반영한다

**`globalShortcut` 은 수식키 단독 등록이 불가능하다.** `Win` 키 단독 탈취는 저수준 훅이 필요하며
4단계(선택 목표)로 미뤄져 있다. 1~3단계에서 시도하지 않는다.

## 결정 규칙

**`docs/DIRECTION.md` 5장 "미결정" 항목을 임의로 정하지 마라.** 패널 크기, 기본 단축키 값, 설정 저장
위치, 그룹 펼치기 방식, 다중 모니터 인스턴스 정책 등이 여기 속한다. 근거 없는 값(유예 시간, 재시도 간격,
폴백 순서, 임계치)을 코드에 넣지 않는다. 확정되면 코드와 함께 `DIRECTION.md` 를 갱신한다.

`git add -A` 를 쓰지 않는다. 세션에서 실제로 만진 경로만 명시적으로 add 한다.
