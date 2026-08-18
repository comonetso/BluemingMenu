/**
 * 팝업 패널 창 — 시작 메뉴 대체 본체.
 *
 * 창을 파괴하지 않고 **숨겼다 다시 보여주는** 방식이다. 매번 새로 만들면 렌더러가 다시 로드되어
 * 열리는 순간이 느려지고, 그리드 상태도 매번 새로 받아야 한다.
 *
 * 배치 규칙은 `docs/DIRECTION.md` 3.5 절을 따른다. 이 PC 특유의 함정이 세 가지 있다.
 *   1. 보조 모니터의 X 좌표가 음수(-1834)다 → 주 모니터 기준 상대 계산을 하면 화면 밖으로 나간다.
 *      `screen` 이 주는 `bounds` / `workArea` 를 **그대로** 쓴다.
 *   2. 양쪽 모니터 모두에 작업표시줄이 있다 → "주 모니터에만 있다"고 가정하지 않는다.
 *      커서가 있는 디스플레이의 `workArea` 를 그때그때 읽는다.
 *   3. DPI 스케일이 걸려 있다 → 여기서 다루는 값은 전부 논리 픽셀이다. `workArea` 도 논리 픽셀이므로
 *      `scaleFactor` 를 곱하거나 나누지 않는다. 물리 픽셀이 필요한 계산은 이 파일에 없다.
 */

import { BrowserWindow, screen } from 'electron';
import { PANEL_MARGIN, panelHeight, panelWidth } from '../config';
import { EV } from '../ipc';
import { getConfig } from '../store';
import { IS_DEV, loadRenderer, preloadPath } from './paths';

// 개발/배포 판정과 로딩 경로는 `paths.ts` 한 곳에서 관리한다 (빌드 도구가 바뀌면 거기만 고친다).

/**
 * blur(포커스 상실)로 패널을 닫을지. **기본은 항상 켜짐이다.**
 *
 * "메뉴 밖을 클릭하면 사라진다" 는 시작 메뉴와 같은 거동이고 사용자가 요구한 동작이다.
 * 개발 모드에서도 켜져 있어야 실사용과 같은 감각으로 검증할 수 있다.
 *
 * ⚠️ 유일한 예외 — DevTools 를 열면 패널이 포커스를 잃어 즉시 닫히므로 디버깅이 불가능해진다.
 *    그때만 끈다:  `BM_NO_BLUR_CLOSE=1 npm start`
 *    패키징 빌드는 이 환경변수를 보지 않는다. 배포본에서는 언제나 켜져 있다.
 */
const BLUR_CLOSE_ENABLED = !IS_DEV || process.env.BM_NO_BLUR_CLOSE !== '1';

/**
 * 네이티브 팝업 메뉴가 떠 있는 동안만 true.
 *
 * ⚠️ Windows 에서 컨텍스트 메뉴가 뜨면 `BrowserWindow` 가 **`blur` 를 받는다.**
 *    그대로 두면 패널이 숨어 버리고 메뉴까지 함께 닫혀 우클릭이 아예 동작하지 않는다.
 *    blur 닫기가 기본으로 켜져 있으므로 이 문제는 개발 모드에서도 그대로 재현된다
 *    (예전에는 개발 모드에서 blur 닫기가 꺼져 있어 패키징 빌드에서만 터졌다).
 */
let blurSuspended = false;

/** 팝업 메뉴를 띄우기 직전에 부른다 */
export function suspendBlurClose(): void {
  blurSuspended = true;
}

/** 팝업 메뉴가 닫힌 뒤 부른다. 반드시 짝을 맞춰야 패널이 blur 로 안 닫히는 상태에 갇히지 않는다 */
export function resumeBlurClose(): void {
  blurSuspended = false;
}

/**
 * blur 를 무시할 화면 영역을 돌려주는 함수. 없으면 null.
 *
 * ### 왜 필요한가 — 실측으로 확인한 순서 문제 (2026-08-18)
 * 패널이 열린 상태에서 트레이·플로팅 아이콘을 누르면 이벤트가 이 순서로 온다.
 * ```
 * blur → hidePanel()          ← 패널이 먼저 닫혀 버린다
 * click → togglePanel()       ← "닫혀 있네" 하고 다시 연다
 * ```
 * 그래서 **아무리 눌러도 안 닫히고**, 그 닫힘→열림이 눈에는 깜빡임으로 보인다.
 *
 * 해결은 blur 를 일으킨 클릭이 "토글 버튼을 누른 것" 인지 가리는 것이다.
 * **시간 유예(쿨다운·디바운스)를 쓰지 않는다** — ms 값에 근거가 없다.
 * 대신 blur 가 난 순간의 **커서 좌표**를 본다. 커서가 토글 버튼 위면 그 blur 는
 * "패널 밖을 클릭한 것" 이 아니므로 무시하고, 뒤따라오는 토글이 정상적으로 닫게 둔다.
 */
type BlurIgnoreRegion = () => Electron.Rectangle | null;

const blurIgnoreRegions: BlurIgnoreRegion[] = [];

/**
 * 토글 버튼의 영역을 등록한다 (플로팅 창, 트레이 아이콘).
 *
 * ⚠️ 좌표는 **호출 시점에** 구해야 한다. 플로팅은 드래그로 움직이고 트레이 아이콘도
 *    다른 아이콘이 늘고 줄면 위치가 바뀐다. 그래서 사각형이 아니라 **함수**를 받는다.
 * ⚠️ 등록은 `main.ts` 가 한다. 여기서 `tray.ts`·`floating.ts` 를 import 하면 순환이 된다.
 */
export function addBlurIgnoreRegion(region: BlurIgnoreRegion): void {
  blurIgnoreRegions.push(region);
}

/** 지금 커서가 등록된 무시 영역 안에 있는가 */
function cursorInIgnoreRegion(): boolean {
  const p = screen.getCursorScreenPoint();

  for (const region of blurIgnoreRegions) {
    const r = region();
    if (!r) continue;
    if (p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height) {
      return true;
    }
  }
  return false;
}

/** 작업표시줄이 붙어 있는 화면 변 */
type TaskbarEdge = 'top' | 'bottom' | 'left' | 'right';

/**
 * 작업표시줄을 못 찾았을 때 쓰는 변.
 *
 * ⚠️ 임의값이다. `workArea` 와 `bounds` 가 완전히 같으면(자동 숨김 등) 어느 변인지 알 방법이 없다.
 * 다만 이 경우 아래 `computeBounds()` 의 'bottom' 분기는 "workArea 좌하단"이라는 뜻이 되어,
 * 예약 영역이 없는 화면에서도 결과가 어색하지 않다.
 */
const FALLBACK_EDGE: TaskbarEdge = 'bottom';

let panel: BrowserWindow | null = null;

/**
 * 작업표시줄이 어느 변에 있는지 `workArea` 와 `bounds` 의 차이로 **런타임에** 유도한다.
 * 하드코딩하지 않는다 — 사용자가 작업표시줄을 옮기면 배치도 따라가야 한다.
 *
 * `workArea` 는 작업표시줄이 이미 빠진 사각형이므로, 네 변 중 가장 많이 깎인 쪽이 작업표시줄이다.
 */
function detectTaskbarEdge(display: Electron.Display): TaskbarEdge {
  const b = display.bounds;
  const wa = display.workArea;

  const gaps: Array<{ edge: TaskbarEdge; size: number }> = [
    { edge: 'left', size: wa.x - b.x },
    { edge: 'top', size: wa.y - b.y },
    { edge: 'right', size: b.x + b.width - (wa.x + wa.width) },
    { edge: 'bottom', size: b.y + b.height - (wa.y + wa.height) },
  ];

  const found = gaps.reduce((max, cur) => (cur.size > max.size ? cur : max));
  return found.size > 0 ? found.edge : FALLBACK_EDGE;
}

/**
 * 패널이 놓일 사각형을 계산한다.
 *
 * ### 가로 정렬에 대해 — 반드시 읽을 것
 * 작업표시줄의 **정렬**(왼쪽 ↔ 가운데)은 `workArea` 로는 알 수 없다. 정렬을 바꿔도 예약 영역은
 * 똑같기 때문이다. 정확한 값은 레지스트리
 * `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced` 의 `TaskbarAl`
 * (0=왼쪽, 1=가운데) 에 있으나 네이티브 모듈 없이 읽기 어려워 **이번 단계에서는 읽지 않는다.**
 *
 * 그래서 가로는 **항상 왼쪽 기준**으로 둔다. 이 PC 실측이 `TaskbarAl = 0`(왼쪽 정렬)이라
 * 현재 환경과는 일치한다(`docs/DIRECTION.md` 3.5). 하지만 **"가운데 정렬일 것"이라 가정한 것이
 * 아니라, 판정을 못 해서 왼쪽으로 고정한 것**이다. 정렬 추종이 필요해지면 여기를 고친다.
 *
 * 세로는 작업표시줄 변에 따라 갈린다 — 위에 있으면 위에서, 아니면 아래에서 올라온다.
 * (Windows 11 은 좌/우 작업표시줄을 공식 지원하지 않는다. 그 경우도 아래 기준으로 둔다)
 */
function computeBounds(cols: number, rows: number): Electron.Rectangle {
  const width = panelWidth(cols);
  const height = panelHeight(rows);

  // 커서가 있는 디스플레이에 띄운다. 좌표는 screen 이 준 것을 그대로 쓴다(음수 X 주의).
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = display.workArea;
  const edge = detectTaskbarEdge(display);

  const x = wa.x + PANEL_MARGIN;
  const y =
    edge === 'top'
      ? wa.y + PANEL_MARGIN
      : wa.y + wa.height - height - PANEL_MARGIN;

  return {
    x: clamp(x, wa.x, wa.x + wa.width - width),
    y: clamp(y, wa.y, wa.y + wa.height - height),
    width,
    height,
  };
}

/**
 * `workArea` 안으로 밀어 넣는다.
 * 패널이 `workArea` 보다 큰 경우에는 `min` 이 `lo` 보다 작아지는데, `Math.max` 를 마지막에 두어
 * 최소한 왼쪽(위쪽) 모서리는 화면 안에 남게 한다.
 */
function clamp(value: number, lo: number, hi: number): number {
  return Math.round(Math.max(lo, Math.min(value, hi)));
}

/** 두 사각형이 완전히 같은가 */
function sameBounds(a: Electron.Rectangle, b: Electron.Rectangle): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** 로드가 끝나기 전에 보낸 이벤트는 그냥 사라진다. 로딩 중이면 완료를 기다렸다 보낸다. */
function sendPanelShow(win: BrowserWindow): void {
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => {
      if (!win.isDestroyed()) win.webContents.send(EV.PANEL_SHOW);
    });
    return;
  }
  win.webContents.send(EV.PANEL_SHOW);
}

/**
 * 패널 창을 만든다. 이미 살아 있으면 그것을 돌려준다.
 * 만들기만 하고 **보여주지는 않는다** (`show: false`).
 */
export function createPanel(): BrowserWindow {
  if (panel && !panel.isDestroyed()) return panel;

  const cfg = getConfig();

  const win = new BrowserWindow({
    width: panelWidth(cfg.cols),
    height: panelHeight(cfg.rows),
    frame: false,
    transparent: true,
    /**
     * ⚠️ 투명 창이라도 `backgroundColor` 를 주지 않으면 Electron 기본값(#FFF, 흰색)이 쓰인다.
     *    창이 숨어 있는 동안 Chromium 은 합성 프레임을 들고 있지 않으므로, `show()` 직후
     *    첫 프레임이 도착하기 전까지는 이 색이 그대로 화면에 깔린다 — **흰 판이 한 번 번쩍인다.**
     *    `#AARRGGBB` 형식의 완전 투명값을 넣어 그 빈 구간이 아무것도 안 그리게 만든다.
     */
    backgroundColor: '#00000000',
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    movable: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 패널은 해시 없이 로드한다 (플로팅은 `#floating`, 단축키 설정은 `#hotkey`).
  loadRenderer(win);

  // ── 진단용 (임시) ───────────────────────────────────────────────
  // 렌더러의 console.log 는 DevTools 에만 나온다. 터미널만 보고는 무엇이 몇 번 도는지
  // 알 수 없어 메인 쪽으로 중계한다. 원인을 잡고 나면 걷어낸다.
  // Electron 버전에 따라 이 이벤트의 인자 형태가 다르다(구: (e, level, message, ...) /
  // 신: (event) with event.message). 양쪽을 모두 받아 문자열만 골라낸다.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  win.webContents.on('console-message', (...args: any[]) => {
    const msg =
      typeof args[0]?.message === 'string'
        ? args[0].message
        : args.find((a) => typeof a === 'string');
    if (msg) console.log(`[renderer] ${msg}`);
  });
  // ────────────────────────────────────────────────────────────────

  // 포커스를 잃으면 닫는다 — 시작 메뉴와 같은 거동. 파괴가 아니라 숨김이다.
  win.on('blur', () => {
    // 팝업 메뉴가 떠 있는 동안의 blur 는 "패널 밖을 클릭한 것" 이 아니다. 무시한다.
    if (blurSuspended) {
      console.log('[panel] blur 무시 — 팝업 메뉴 표시 중');
      return;
    }
    if (!BLUR_CLOSE_ENABLED) {
      console.log('[panel] blur 무시 — BM_NO_BLUR_CLOSE=1 (개발 모드 전용 예외)');
      return;
    }
    // 토글 버튼(트레이·플로팅)을 누른 blur 는 닫기 신호가 아니다.
    // 여기서 닫아 버리면 뒤따르는 토글이 "닫혀 있네" 하고 다시 열어 영영 안 닫힌다.
    if (cursorInIgnoreRegion()) {
      console.log('[panel] blur 무시 — 커서가 토글 버튼 위 (토글이 닫는다)');
      return;
    }
    hidePanel();
  });

  win.on('closed', () => {
    panel = null;
  });

  panel = win;

  console.log(
    `[panel] 생성 — ${cfg.cols}x${cfg.rows} / blur 닫기 ${BLUR_CLOSE_ENABLED ? 'on' : 'off'}`,
  );

  return win;
}

/** 살아 있는 패널 창. 없으면 null. */
export function getPanel(): BrowserWindow | null {
  return panel && !panel.isDestroyed() ? panel : null;
}

/**
 * 패널이 사용자에게 열려 있는가.
 *
 * ⚠️ **`win.isVisible()` 을 쓰지 마라.** 아래 `hidePanel()` 이 창을 숨기지 않고 투명하게만
 *    만들기 때문에 `isVisible()` 은 항상 true 다. 열림/닫힘의 단일 진실원은 이 플래그다.
 */
let panelOpen = false;

/**
 * 패널을 띄운다.
 * **위치는 열 때마다 다시 계산한다** — 모니터 구성·작업표시줄 설정·커서 위치가 그 사이에 바뀔 수 있다.
 *
 * ### ★ 왜 `hide()` / `show()` 를 쓰지 않는가 — 깜빡임의 진짜 원인 (2026-08-18 실측)
 *
 * `win.hide()` 를 하면 Chromium 이 그 창의 **합성 표면(compositor surface)을 버린다.**
 * 다시 `show()` 하면 표면을 새로 만드는데, 첫 프레임이 도착하기 전까지 빈 구간이 화면에 스친다.
 * 그게 사용자가 본 깜빡임이다.
 *
 * 결정적 근거 — 사용자 관찰이 **"최초에는 안 깜빡, 두 번째부터 깜빡"** 이었다.
 * 첫 열기는 창이 갓 생성돼 표면이 살아 있어 멀쩡하고, **한 번 `hide()` 한 뒤부터** 매번 깜빡인다.
 * 이 비대칭을 설명하는 것은 표면 파기뿐이다. 렌더러 애니메이션 로그는 매번 정상이었고
 * (arm 1회 / release 1회), `PANEL_SHOW` 순서를 바꾸고 `backgroundColor` 를 넣어도 그대로였다.
 *
 * 그래서 **창을 숨기지 않는다.** 투명하게 만들고 마우스를 통과시킨다.
 * 표면이 유지되므로 재생성 자체가 일어나지 않는다.
 *
 * ⚠️ 여기서 `hide()` / `show()` 로 되돌리지 마라. 깜빡임이 그대로 돌아온다.
 */
export function showPanel(): void {
  const win = getPanel() ?? createPanel();
  const cfg = getConfig();

  console.log(`[panel] showPanel — 현재 open=${panelOpen}`);

  // 값이 그대로면 건너뛴다. 보이기 직전의 리사이즈는 렌더러 뷰포트를 다시 잡게 만든다.
  const bounds = computeBounds(cfg.cols, cfg.rows);
  if (!sameBounds(win.getBounds(), bounds)) win.setBounds(bounds);

  // 렌더러의 슬라이드업 애니메이션 트리거. 창이 실제로 나타나기 전에 시작 상태를 만들어 둔다.
  sendPanelShow(win);

  // 창 자체는 이미 떠 있다(투명). 클릭을 다시 받게 하고 불투명으로 되돌린다.
  win.setIgnoreMouseEvents(false);
  win.setOpacity(1);

  // 최초 1회만 실제로 띄운다. 그 뒤로는 이미 visible 이라 이 호출이 아무것도 하지 않는다.
  if (!win.isVisible()) win.show();
  win.focus();

  panelOpen = true;
}

/**
 * 감춘다. **창을 파괴하지도, `hide()` 하지도 않는다.**
 * 위 `showPanel()` 주석의 "왜 hide() 를 쓰지 않는가" 를 반드시 읽을 것.
 */
export function hidePanel(): void {
  const win = getPanel();
  if (!win || !panelOpen) return;

  console.log('[panel] hidePanel — 투명화');

  win.setOpacity(0);
  // 투명해도 창은 그 자리에 있다. 이걸 빼면 보이지 않는 창이 클릭을 가로챈다.
  win.setIgnoreMouseEvents(true);

  // 창을 숨기지 않으므로 포커스가 그대로 남는다. 명시적으로 놓아야 다음에 다른 곳을
  // 클릭했을 때 blur 가 제대로 발생한다.
  win.blur();

  // 다음 열기를 위해 렌더러가 애니메이션 시작 상태를 미리 씌우게 한다.
  // (창이 hide 되지 않으므로 `visibilitychange` 는 오지 않는다)
  win.webContents.send(EV.PANEL_HIDE);

  panelOpen = false;
}

/** 열려 있으면 감추고, 아니면 띄운다. */
export function togglePanel(): void {
  console.log(`[panel] togglePanel — open=${panelOpen} → ${panelOpen ? '감춤' : '띄움'}`);

  if (panelOpen) {
    hidePanel();
    return;
  }
  showPanel();
}

/**
 * 그리드 구성이 바뀌었을 때 크기를 다시 잡는다 (트레이의 "구성변경").
 * 크기가 바뀌면 좌하단 기준점도 달라지므로 위치까지 함께 다시 계산한다.
 *
 * ⚠️ 설정 저장은 하지 않는다. 저장은 호출한 쪽(store) 책임이며, 이 함수는 이미 갱신된
 * 설정을 화면에 반영할 뿐이다. 그래서 cols/rows 를 인자로 받는다.
 */
export function resizePanel(cols: number, rows: number): void {
  const win = getPanel();
  if (!win) return;

  const bounds = computeBounds(cols, rows);
  win.setBounds(bounds);

  console.log(`[panel] 크기 변경 — ${cols}x${rows} (${bounds.width}x${bounds.height})`);
}
