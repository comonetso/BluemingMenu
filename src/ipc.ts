/**
 * IPC 채널 이름 — 메인 · preload · 렌더러가 **모두 이 파일만** 참조한다.
 *
 * 문자열을 각자 적으면 오타가 런타임까지 살아남는다. 반드시 여기 상수를 쓴다.
 */

/** 렌더러 → 메인 (ipcRenderer.invoke) */
export const CH = {
  /** 그리드 구성·항목·언어를 한 번에 받아온다 → GridPayload */
  GRID_GET: 'bm:grid:get',
  /** 재배치·폴더 변경 결과를 저장한다 (items: GridEntry[]) */
  GRID_SAVE: 'bm:grid:save',

  /**
   * 탐색기에서 끌어다 놓은 파일을 등록한다 (paths: string[]).
   *
   * ⚠️ 셸 확장의 `TOGGLE` 과 다르다. 저쪽은 있으면 빼고 없으면 넣는 **토글**이지만,
   *    끌어다 놓기는 언제나 **추가**다. 이미 있는 항목을 다시 떨궜다고 지워지면 안 된다.
   *
   * 등록 결과는 `EV.GRID_UPDATE` 로 되돌아온다. 반환값은 실제로 새로 넣은 개수다.
   */
  GRID_ADD_FILES: 'bm:grid:addFiles',
  /** 항목 실행 (id: string). 실행 후 패널은 닫힌다 */
  APP_LAUNCH: 'bm:app:launch',
  /** 패널 닫기 요청 (Esc 등) */
  PANEL_CLOSE: 'bm:panel:close',

  /**
   * 그리드 항목 우클릭 → 네이티브 컨텍스트 메뉴를 띄운다 (ids: string | string[]).
   *
   * 메뉴 구성은 메인이 항목 종류를 보고 정한다.
   *   앱   → 관리자 권한으로 실행 / 파일 위치 열기 / 메뉴에서 삭제
   *   폴더 → 폴더 해체 / 메뉴에서 삭제
   *   여러 개(Ctrl+클릭 다중 선택, 2개 이상) → 선택한 N개 삭제 **하나뿐**
   *
   * 선택 결과로 데이터가 바뀌면 메인이 저장하고 `EV.GRID_UPDATE` 를 브로드캐스트한다.
   * 렌더러는 응답을 기다려 무언가 할 필요가 없다.
   */
  ITEM_MENU: 'bm:item:menu',

  /** 단축키 설정 창 — 현재 조합을 읽는다 → string (`'win+alt'` 형식, `'none'` 가능) */
  HOTKEY_GET: 'bm:hotkey:get',
  /** 단축키 설정 창 — 새 조합을 저장하고 훅을 다시 건다 (combo: string) */
  HOTKEY_SET: 'bm:hotkey:set',
  /** 단축키 설정 창 닫기 */
  HOTKEY_CLOSE: 'bm:hotkey:close',

  /** 플로팅 아이콘 클릭 → 패널 토글 */
  FLOATING_TOGGLE: 'bm:floating:toggle',
  /** 플로팅 드래그 이동 (dx, dy 만큼 창을 옮긴다) */
  FLOATING_MOVE: 'bm:floating:move',
  /** 플로팅 드래그 종료 → 현재 좌표를 영구 저장 */
  FLOATING_MOVE_END: 'bm:floating:moveEnd',
  /**
   * 플로팅 우클릭 → 네이티브 컨텍스트 메뉴.
   *
   * 트레이 메뉴와 **같은 구성**이다 (사용자 지정 2026-08-18).
   * 템플릿은 `src/menus.ts` 의 `buildAppMenuTemplate()` 한 곳에서만 만든다 —
   * 양쪽이 따로 만들면 메뉴를 고칠 때 반드시 어긋난다.
   */
  FLOATING_MENU: 'bm:floating:menu',
} as const;

/** 메인 → 렌더러 (webContents.send) */
export const EV = {
  /** 그리드 내용이 바뀌었다 (GridPayload) */
  GRID_UPDATE: 'bm:evt:grid:update',
  /** 언어가 바뀌었다 (Locale) */
  LOCALE_CHANGE: 'bm:evt:locale:change',
  /** 패널이 열린다 — 슬라이드업 애니메이션 시작 */
  PANEL_SHOW: 'bm:evt:panel:show',

  /**
   * 패널이 감춰졌다 — 다음 열기를 대비해 애니메이션 **시작 상태를 미리 씌우라**는 신호.
   *
   * 패널 창은 `hide()` 되지 않고 투명해질 뿐이라(`windows/panel.ts` 참조)
   * `visibilitychange` 가 오지 않는다. 그래서 이 신호로 대신한다.
   * 미리 씌워 두지 않으면 다음에 열 때 완성된 패널이 한 프레임 보였다가 애니메이션이 시작된다.
   */
  PANEL_HIDE: 'bm:evt:panel:hide',
} as const;
