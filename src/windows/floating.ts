/**
 * 플로팅 아이콘 창 — 항상 위에 떠 있는 작은 런처 버튼.
 *
 * 사용자 요구사항 (2026-08-18)
 *   "AlwaysOnTop 플로팅 아이콘을 띄워서 그것을 클릭하면 메뉴가 나오고, 다시 클릭하면 사라짐"
 *   "플로팅은 드래그로 이동이 가능한데, 이동 좌표를 영구 저장해서 프로그램이 새로 시작해도 동일한 위치 유지"
 *
 * 규칙
 *   - 플로팅은 **하나만** 띄운다. 모니터마다 만들지 않는다
 *   - 앱 시작 시 자동으로 보이지 않는다. 표시 시점은 호출자(트레이 메뉴)가 정한다
 *   - 창을 파괴하지 않는다. 숨길 때도 hide 로만 유지한다
 *
 * 좌표계 주의
 *   Electron 의 `screen` · `setBounds` · `getBounds` 는 전부 **논리 픽셀(DIP)** 이다.
 *   이 PC 는 보조 모니터의 X 좌표가 음수(-1834)라 "주 모니터 기준 상대 계산" 을 하면 창이 화면 밖으로 나간다.
 *   그래서 `screen.getAllDisplays()` 가 주는 `workArea` 를 좌표 그대로 쓴다.
 *
 *   ⚠️ 창을 옮길 때 `setPosition()` 을 쓰지 않는다. 크기가 누적으로 부풀어 오른다 —
 *      이유는 `applyBounds()` 주석에 적어 뒀다.
 *
 * z-order 주의
 *   `alwaysOnTop` 은 **한 번 걸어두면 끝나는 설정이 아니다.** Windows 의 최상위(topmost)는
 *   층이 하나뿐이고 작업표시줄(`Shell_TrayWnd`)도 같은 층에 있다. 같은 층 안에서는
 *   **가장 나중에 올라온 창이 위**다. 자세한 것은 `reassertTopMost()` 주석에 적어 뒀다.
 */

import { BrowserWindow, screen } from 'electron';
import { FLOATING_SIZE, PANEL_MARGIN } from '../config';
import { loadRenderer, preloadPath } from './paths';
import { getConfig, setFloatingPosition, setFloatingVisible } from '../store';

let floating: BrowserWindow | null = null;

/**
 * 드래그 중 "창이 있어야 할 자리" (논리 픽셀, 소수 포함).
 * 드래그가 끝나면 null 로 되돌려 다음 드래그가 실제 창 위치에서 다시 출발하게 한다.
 *
 * 창에서 좌표를 매번 다시 읽지 않는 이유는 `applyBounds()` 주석에 있다 —
 * 논리↔물리 환산이 정수로 떨어지지 않는 배율에서는 읽은 값을 되먹일 때마다 오차가 쌓인다.
 * 소수를 그대로 들고 있다가 창에 넣을 때만 반올림하므로 1픽셀 미만의 이동도 버려지지 않는다.
 */
let intendedPos: { x: number; y: number } | null = null;

/**
 * 위치를 잡으면서 **크기를 매번 다시 못 박는다.**
 *
 * ⚠️ `setPosition()` 을 쓰면 안 된다.
 *    Electron 의 `setPosition` 은 내부적으로 "지금 크기(`getBounds()` 로 읽은 값) + 새 좌표" 를
 *    `SetBounds` 에 넘긴다. 즉 **읽은 크기를 그대로 되먹인다.**
 *    그런데 이 PC 는 배율이 1.3959 로 정수배가 아니고, Chromium 은 창 사각형을 논리↔물리로
 *    옮길 때 `ScaleToEnclosingRect`(바깥으로 넓히는 반올림)를 쓴다. 한 번 오갈 때마다 크기가
 *    최대 1픽셀씩 **커지기만 하고 줄지는 않는다.**
 *    드래그는 이 경로를 초당 수십~수백 번 지나가므로 그 확대분이 그대로 누적된다.
 *    실제 증상: "플로팅 버튼을 이동하면 점점 커짐" (아이콘이 화면 상당 부분을 덮을 때까지).
 *
 *    그래서 크기는 **창에서 읽지 않는다.** 언제나 FLOATING_SIZE 를 다시 지정한다.
 *    (같은 이유로 패널은 항상 계산된 크기를 넣기 때문에 이 증상이 없다 — `windows/panel.ts`)
 */
function applyBounds(win: BrowserWindow, x: number, y: number): void {
  win.setBounds({
    x: Math.round(x),
    y: Math.round(y),
    width: FLOATING_SIZE,
    height: FLOATING_SIZE,
  });
}

/**
 * 두 사각형이 한 픽셀이라도 겹치는가.
 * "얼마나 겹쳐야 보이는 것으로 치는지" 는 사용자가 정한 바 없으므로 임계치를 두지 않는다.
 * 조금이라도 걸쳐 있으면 사용자가 그 자리에 둔 것으로 본다.
 */
function intersects(a: Electron.Rectangle, b: Electron.Rectangle): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/**
 * 저장된 좌표가 지금의 모니터 구성에서 화면 밖일 수 있다.
 * (모니터를 뺐거나, 해상도·배치가 바뀌었거나, 배율이 달라진 경우)
 * 이 검사를 빼먹으면 플로팅이 켜져도 영영 보이지 않는다.
 *
 * 어느 디스플레이의 `workArea` 에도 걸치지 않을 때만 보이는 자리로 끌어온다.
 * 끌어올 기준 디스플레이는 `screen.getDisplayMatching()` 이 고른다 —
 * 겹치는 곳이 없으면 가장 가까운 디스플레이를 주므로, 원래 있던 방향에서 가장 덜 튀는 자리가 된다.
 */
function clampIntoVisibleArea(x: number, y: number): { x: number; y: number } {
  const rect: Electron.Rectangle = { x, y, width: FLOATING_SIZE, height: FLOATING_SIZE };

  const onScreen = screen.getAllDisplays().some((d) => intersects(rect, d.workArea));
  if (onScreen) return { x, y };

  const wa = screen.getDisplayMatching(rect).workArea;
  const clamped = {
    x: Math.min(Math.max(x, wa.x), wa.x + wa.width - FLOATING_SIZE),
    y: Math.min(Math.max(y, wa.y), wa.y + wa.height - FLOATING_SIZE),
  };

  console.log(`[floating] 저장 좌표가 화면 밖 (${x}, ${y}) → (${clamped.x}, ${clamped.y}) 로 보정`);
  return clamped;
}

/**
 * 창을 처음 놓을 자리.
 *
 * 저장된 좌표가 있으면 그대로 쓴다(영구 저장 요구사항). 화면 밖일 때만 보정한다.
 * 한 번도 옮긴 적이 없으면 커서가 있는 디스플레이의 작업 영역 **우하단**,
 * 가장자리에서 `PANEL_MARGIN` 안쪽에 둔다.
 *
 * ⚠️ 우하단이라는 기본 위치는 사용자가 지정한 바 없는 **임의값**이다.
 *    (작업표시줄 알림 영역 근처라 "상주 아이콘" 인상에 맞다는 것이 유일한 근거다)
 */
function initialPosition(): { x: number; y: number } {
  const { floating: saved } = getConfig();

  if (saved.x !== null && saved.y !== null) {
    return clampIntoVisibleArea(saved.x, saved.y);
  }

  // workArea 는 작업표시줄이 이미 빠진 사각형이다. 높이를 따로 빼지 않는다.
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  return {
    x: wa.x + wa.width - FLOATING_SIZE - PANEL_MARGIN,
    y: wa.y + wa.height - FLOATING_SIZE - PANEL_MARGIN,
  };
}

/**
 * 최상위를 **다시 뺏어온다.**
 *
 * 왜 필요한가 (증상: "작업표시줄에 두면 작업표시줄을 클릭할 때 뒤로 숨는다")
 *   Windows 에는 최상위 층이 **하나뿐**이다 (`WS_EX_TOPMOST`). Electron 의 `level` 인자
 *   (`'screen-saver'` 등)는 macOS 의 창 레벨 개념이고, Windows 에서는 "topmost 냐 아니냐" 로만
 *   접힌다. 작업표시줄도 topmost 창이므로 우리 창과 **같은 층**에 있다.
 *   같은 층 안의 순서는 "누가 나중에 올라왔는가" 로 정해지고, 작업표시줄을 클릭하면 explorer 가
 *   자신을 그 층의 맨 위로 끌어올린다. 그 순간 우리 창이 아래로 밀린다.
 *   → 그러므로 이건 설정값 문제가 아니라 **뺏긴 순서를 다시 가져오는** 문제다.
 *
 * 왜 `setAlwaysOnTop` 왕복인가 (`moveTop()` 이 아니라)
 *   `setAlwaysOnTop(false)` → `setAlwaysOnTop(true, ...)` 는 Chromium 에서
 *   `SetWindowPos(HWND_NOTOPMOST)` → `SetWindowPos(HWND_TOPMOST)` 두 번으로 나간다.
 *   두 호출 모두 **`SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE`** 를 달고 있다. 그래서
 *     · 위치·크기를 건드리지 않는다 → `applyBounds()` 가 막아 둔 크기 폭주 경로를 타지 않는다
 *     · 창을 활성화하지 않는다 → **포커스를 훔치지 않는다** (`showInactive()` 의 전제가 유지된다)
 *   `HWND_TOPMOST` 로 다시 들어가면 topmost 층의 **맨 위**에 삽입되므로 작업표시줄을 다시 넘어선다.
 *
 *   반면 `moveTop()` 은 쓰지 않는다. 포커스를 안 뺏는 건 맞지만(문서: "regardless of focus"),
 *   Electron 의 Windows 구현이 `SWP_NOMOVE|SWP_NOSIZE` 를 쓰지 않고 **지금 위치·크기를 읽어
 *   그대로 되먹인다.** 그건 `applyBounds()` 주석이 설명한 논리↔물리 왕복 확대 경로 그 자체라,
 *   z-order 를 되찾으려다 크기 폭주 버그를 되살리게 된다. 얻는 것이 같은데 위험만 크다.
 *
 * 숨어 있는 창에는 하지 않는다. 보이지 않는 창의 순서를 다툴 이유가 없다.
 */
function reassertTopMost(win: BrowserWindow): void {
  if (!win.isVisible()) return;

  win.setAlwaysOnTop(false);
  win.setAlwaysOnTop(true, 'screen-saver');
}

/**
 * ⚠️ **근거 없는 임의값이다. 사용자 확인이 필요하다.**
 *
 * 작업표시줄 클릭은 우리 프로세스에 **아무 이벤트도 발생시키지 않는다.**
 * 플로팅은 `showInactive()` 로 뜨고 포커스를 받은 적이 없으므로 `blur` 조차 오지 않고,
 * Electron 에는 "다른 앱이 전면에 나왔다"를 알려주는 API 가 없다
 * (Win32 `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)` 는 네이티브 모듈이 필요하다).
 * 그래서 이벤트만으로는 이 증상을 잡을 수 없고, 주기적 재주장이 유일한 백스톱이다.
 *
 * 이 간격이 무엇을 정하는가: **밀려난 뒤 다시 올라오기까지 최대 얼마나 걸리는가.**
 * 짧을수록 빨리 돌아오지만 `SetWindowPos` 호출이 그만큼 잦아진다. "얼마나 빨라야 하는가" 는
 * 체감의 문제라 실측으로 정할 수 없다 — 사용자가 정할 값이다.
 */
const TOPMOST_REASSERT_INTERVAL_MS = 1000;

let topMostTimer: NodeJS.Timeout | null = null;

/** 재주장 타이머를 돌린다. 창이 보이는 동안에만 돈다. 중복 기동하지 않는다. */
function startTopMostGuard(): void {
  if (topMostTimer) return;

  topMostTimer = setInterval(() => {
    const win = getFloating();
    // 창이 사라졌거나 숨겨졌으면 타이머도 접는다. (hide 이벤트를 놓쳤을 때의 보험)
    if (!win || !win.isVisible()) {
      stopTopMostGuard();
      return;
    }
    reassertTopMost(win);
  }, TOPMOST_REASSERT_INTERVAL_MS);

  console.log(`[floating] 최상위 유지 시작 — ${TOPMOST_REASSERT_INTERVAL_MS}ms 간격 (임의값)`);
}

function stopTopMostGuard(): void {
  if (!topMostTimer) return;

  clearInterval(topMostTimer);
  topMostTimer = null;
  console.log('[floating] 최상위 유지 중지');
}

/**
 * 플로팅 창을 만든다. 만들기만 하고 **띄우지는 않는다** (`show: false`).
 * 표시 여부는 호출자가 `showFloating()` 으로 정한다.
 */
export function createFloating(): BrowserWindow {
  if (floating && !floating.isDestroyed()) return floating;

  const { x, y } = initialPosition();

  const win = new BrowserWindow({
    x,
    y,
    width: FLOATING_SIZE,
    height: FLOATING_SIZE,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    movable: true,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 'screen-saver' 는 일반 alwaysOnTop 보다 높은 층이다.
  // 전체화면 앱이나 다른 상주 도구에 가려지지 않게 확실히 최상위를 잡는다.
  win.setAlwaysOnTop(true, 'screen-saver');

  // 렌더러는 index.html 하나를 패널과 공유하고 location.hash 로 화면을 가른다.
  loadRenderer(win, 'floating');

  // ── z-order 되찾기 ──
  // 이벤트가 먼저다. 이벤트로 잡히는 순간은 즉시 되찾고, 이벤트가 아예 오지 않는 경우
  // (작업표시줄 클릭 등)만 타이머가 뒤에서 받친다. `reassertTopMost()` 주석 참조.
  //
  // 창의 표시/숨김을 `showFloating()`/`hideFloating()` 이 아니라 창 이벤트에 묶는다.
  // 다른 경로로 숨겨지더라도 타이머가 혼자 남아 돌지 않게 하기 위해서다.
  win.on('show', () => {
    reassertTopMost(win);
    startTopMostGuard();
  });
  win.on('hide', stopTopMostGuard);

  // 플로팅은 `showInactive()` 로 뜨므로 보통은 포커스를 받지 않는다. 다만 사용자가 아이콘을
  // 직접 클릭하면 활성화되고, 그 뒤 다른 창을 누르면 blur 가 온다 — 그때가 밀려나는 시점이다.
  win.on('blur', () => reassertTopMost(win));

  // 정상 경로에서는 파괴되지 않지만(hide 로만 숨긴다), 앱 종료 등으로 파괴되면
  // 참조를 끊어 둔다. 그래야 getFloating() 이 죽은 창을 돌려주지 않는다.
  win.on('closed', () => {
    stopTopMostGuard();
    if (floating === win) {
      floating = null;
      intendedPos = null;
    }
  });

  floating = win;
  intendedPos = null;
  console.log(`[floating] 생성 — (${x}, ${y}) ${FLOATING_SIZE}x${FLOATING_SIZE}`);
  return win;
}

/** 살아 있는 플로팅 창. 없으면 null */
export function getFloating(): BrowserWindow | null {
  if (!floating || floating.isDestroyed()) return null;
  return floating;
}

/**
 * 보이게 한다.
 *
 * `show()` 가 아니라 **`showInactive()`** 를 쓴다.
 * 플로팅이 포커스를 가져가면 열려 있던 패널에 blur 가 걸려 패널이 닫혀 버린다.
 * 플로팅은 클릭만 받으면 되고 키 입력을 받지 않으므로 포커스가 필요 없다.
 */
export function showFloating(): void {
  const win = getFloating() ?? createFloating();

  // 숨겨 둔 사이에 크기가 어그러져 있을 수 있으므로(위 `applyBounds()` 주석의 누적 확대),
  // 보이기 직전에 규정 크기를 다시 못 박는다. 좌표는 지금 있는 자리를 그대로 쓴다.
  const before = win.getBounds();
  applyBounds(win, before.x, before.y);
  intendedPos = null;

  win.showInactive();
  // 'show' 이벤트에서도 하지만, 여기서 한 번 더 못 박는다.
  // 숨어 있는 동안 작업표시줄이 topmost 층의 위를 차지했을 수 있고,
  // 둘 다 불려도 `SetWindowPos` 두 번이라 손해가 없다(중복 기동은 막혀 있다).
  reassertTopMost(win);
  startTopMostGuard();

  setFloatingVisible(true);

  console.log(
    `[floating] 표시 — (${before.x}, ${before.y}) 크기 ${before.width}x${before.height} → ${FLOATING_SIZE}x${FLOATING_SIZE}`,
  );
}

/** 숨긴다. 창은 파괴하지 않는다 — 다시 켤 때 로딩 없이 즉시 뜬다. */
export function hideFloating(): void {
  // 창이 이미 없거나 'hide' 이벤트가 오지 않는 경우에도 타이머가 남지 않도록 여기서 먼저 접는다.
  stopTopMostGuard();

  const win = getFloating();
  if (win) win.hide();
  setFloatingVisible(false);
}

export function toggleFloating(): void {
  if (isFloatingVisible()) hideFloating();
  else showFloating();
}

export function isFloatingVisible(): boolean {
  const win = getFloating();
  return win !== null && win.isVisible();
}

/**
 * 드래그 이동. 현재 위치에서 dx, dy(논리 픽셀) 만큼 옮긴다.
 *
 * ⚠️ 드래그 중 매 프레임 호출된다. **여기서 디스크에 저장하지 마라.**
 *    저장은 드래그가 끝날 때 `persistFloatingPosition()` 이 한 번만 한다.
 */
export function moveFloatingBy(dx: number, dy: number): void {
  const win = getFloating();
  if (!win) return;

  // 드래그의 첫 이동에서만 실제 창 위치를 읽는다. 그 뒤로는 우리가 들고 있는 좌표에 더한다.
  if (!intendedPos) {
    const b = win.getBounds();
    intendedPos = { x: b.x, y: b.y };
    console.log(
      `[floating] 드래그 시작 — (${b.x}, ${b.y}) 크기 ${b.width}x${b.height} (규정 ${FLOATING_SIZE}x${FLOATING_SIZE})`,
    );
  }

  intendedPos.x += dx;
  intendedPos.y += dy;

  applyBounds(win, intendedPos.x, intendedPos.y);
}

/**
 * 현재 좌표를 디스크에 저장한다. 드래그가 끝날 때만 부른다.
 * 이 값이 다음 실행에서 그대로 복원된다.
 */
export function persistFloatingPosition(): void {
  const win = getFloating();
  if (!win) return;

  const b = win.getBounds();
  const intended = intendedPos;
  // 드래그가 끝났다. 다음 드래그는 실제 창 위치에서 다시 출발한다.
  intendedPos = null;

  setFloatingPosition(b.x, b.y);
  console.log(
    `[floating] 드래그 종료 — 실제 (${b.x}, ${b.y}) 크기 ${b.width}x${b.height}` +
      (intended
        ? ` / 지시 (${intended.x.toFixed(1)}, ${intended.y.toFixed(1)})`
        : ' / 지시값 없음(드래그 아님)'),
  );
}
