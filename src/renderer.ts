/**
 * 렌더러 진입점 — 패널과 플로팅 아이콘이 **이 파일 하나를 공유한다.**
 *
 * `index.html` 은 하나뿐이고, 어느 창인지는 `location.hash` 로 갈린다.
 *   (없음)      → 팝업 패널
 *   `#floating` → 플로팅 아이콘
 *
 * 메인과의 통신은 preload 가 노출한 `window.bm` 만 쓴다. `electron` 을 import 하지 않는다.
 */

import './index.css';
import { initI18n, changeLocale, type Locale } from './i18n';
import { renderGrid, getCurrentItems, closeFolder } from './ui/grid';
import { initDnd } from './ui/dnd';
import { mountFloating } from './ui/floating';
import { mountHotkeyDialog } from './ui/hotkey';
import type { GridEntry, GridPayload } from './types';
import type { BluemingApi } from './preload';

declare global {
  interface Window {
    bm: BluemingApi;
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('[renderer] #root 가 없다 — index.html 을 확인하라');

const isFloatingWindow = window.location.hash === '#floating';
const isHotkeyWindow = window.location.hash === '#hotkey';

// ─────────────────────────────────────────────────────────────
// 패널
// ─────────────────────────────────────────────────────────────

/** 마지막으로 그린 내용. 언어만 바뀔 때 데이터를 다시 받아오지 않으려고 들고 있는다. */
let current: GridPayload | null = null;

/** 열림 애니메이션을 풀 차례가 예약돼 있는 동안 true. 중복 예약을 막는다 */
let releasePending = false;

/**
 * 그리기 + 드래그 리스너 재부착. payload 가 바뀔 때마다 통째로 다시 그린다.
 *
 * ⚠️ **스크롤 위치를 반드시 보존한다.**
 * `renderGrid` 는 `.bm-panel` 을 통째로 새로 만든다. 그 패널이 곧 스크롤 컨테이너라서
 * (`index.css` 의 `overflow-y: auto`) 그냥 두면 항목을 삭제하거나 옮길 때마다 화면이
 * 맨 위로 튄다. 아래쪽 항목을 정리하는 중이라면 그때마다 다시 스크롤해 내려와야 한다.
 *
 * 새 패널의 내용이 짧아져 이전 위치가 범위를 넘으면 브라우저가 알아서 최대값으로 맞춘다.
 */
function paint(payload: GridPayload): void {
  const prevScrollTop = panelEl()?.scrollTop ?? 0;

  current = payload;
  renderGrid(root as HTMLElement, payload);

  if (prevScrollTop > 0) {
    const next = panelEl();
    if (next) next.scrollTop = prevScrollTop;
  }

  initDnd({
    root: root as HTMLElement,
    getItems: getCurrentItems,
    setItems: (items: GridEntry[]) => {
      // 저장은 메인이, 재렌더는 여기서. 두 가지를 드래그 담당이 알 필요는 없다.
      void window.bm.grid.save(items);

      /*
       * ⚠️ `payload` 가 아니라 **`current`** 를 쓴다.
       *    `initDnd()` 는 첫 호출의 옵션만 붙들고 있어(중복 등록 방지), 이 클로저가 캡처한
       *    `payload` 는 **앱 시작 시점의 cols/rows** 로 굳는다. 그대로 두면 트레이에서 구성을
       *    바꾼 뒤 아이콘을 드래그했을 때 그리드가 옛 구성으로 되돌아간다.
       *    (Codex 리뷰 2026-08-18 지적)
       */
      paint({ ...(current ?? payload), items });
    },
  });

  // `renderGrid` 는 `.bm-panel` 을 통째로 새로 만들므로 `is-entering` 이 날아간다.
  // 창이 아직 안 보이거나 열림 애니메이션을 기다리는 중이면 시작 상태를 다시 씌운다 —
  // 그러지 않으면 최종 상태로 그려진 패널이 그대로 노출돼 다시 깜빡인다.
  // ⚠️ `document.hidden` 은 보지 않는다. 패널 창은 hide 되지 않고 투명해질 뿐이라
  //    이 값은 항상 false 다 (실측 확인).
  if (releasePending) armOpenAnimation();
}

/* ------------------------------------------------- 열림 애니메이션
 *
 * "시작 메뉴 올라오는 것과 동일" (사용자 지정). 실제 곡선·시간은 index.css 담당이다.
 * 여기서 정하는 것은 **언제 시작 상태를 씌우고 언제 푸는가** 하나뿐이다.
 *
 * ## 왜 두 단계로 쪼갰나 — 깜빡임의 정체
 * 창이 숨어 있는 동안 Chromium 은 합성 프레임을 만들지 않는다. `show()` 직후 처음 그려지는
 * 프레임이 사용자가 보는 첫 화면이다. 그 순간 패널이 **최종 상태**(불투명·제자리)로 남아 있으면
 * "다 그려진 패널이 보임 → 투명해짐 → 다시 올라옴" 으로 한 번 튄다.
 * 그래서 시점을 이렇게 못 박는다.
 *   arm(씌우기)  — 창이 보이기 **전에** 끝나 있어야 한다
 *   release(풀기) — 창이 보인 **뒤** 시작 상태가 한 프레임 그려진 다음이어야 한다
 * 메인은 이 전제에 맞춰 `show()` **보다 먼저** PANEL_SHOW 를 보낸다 (`windows/panel.ts`).
 */

/** `.bm-panel`. 재렌더로 매번 새 요소가 되므로 캐시하지 않는다 */
function panelEl(): HTMLElement | null {
  return document.querySelector('.bm-panel');
}

/** 시작 상태를 씌운다. 창이 아직 안 보일 때 불러야 의미가 있다 */
function armOpenAnimation(): void {
  const panel = panelEl();
  if (!panel) return;

  panel.classList.add('is-entering');
  void panel.offsetHeight; // 리플로우 강제 — 없으면 두 상태가 하나로 합쳐져 전이가 생략된다 (제거하지 마라)
}

/**
 * 시작 상태를 풀어 최종 상태로 전이시킨다.
 *
 * `requestAnimationFrame` 을 두 겹으로 쓰는 이유가 둘이다.
 *   1. 창이 숨어 있는 동안 rAF 콜백은 돌지 않는다. 그래서 "창이 보인 뒤" 라는 시점을
 *      **지연값을 지어내지 않고** 맞출 수 있다 (setTimeout 을 쓰면 임의의 ms 를 정해야 한다).
 *   2. 첫 콜백이 도는 프레임에 시작 상태가 실제로 그려지고, 두 번째 콜백에서 떼기 때문에
 *      브라우저가 두 상태를 확실히 다르게 본다.
 */
function releaseOpenAnimation(): void {
  if (releasePending) return;
  releasePending = true;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      releasePending = false;
      panelEl()?.classList.remove('is-entering');
    });
  });
}

/** 씌우고 곧바로 풀기를 예약한다. 메인의 PANEL_SHOW 가 부른다 */
function playOpenAnimation(): void {
  armOpenAnimation();
  releaseOpenAnimation();
}

/** 폴더가 열려 있으면 폴더만 닫고, 아니면 패널을 닫는다. */
function handleEscape(): void {
  if (document.querySelector('.bm-folder-overlay')) {
    closeFolder();
    return;
  }
  void window.bm.closePanel();
}

async function bootPanel(): Promise<void> {
  const payload = await window.bm.grid.get();

  // 메인과 별개로 렌더러도 각자 init 해야 한다 (두 프로세스는 메모리를 공유하지 않는다).
  await initI18n(payload.locale);
  document.documentElement.lang = payload.locale;

  paint(payload);

  window.bm.grid.onUpdate((next) => {
    document.documentElement.lang = next.locale;
    paint(next);
  });

  window.bm.onLocaleChange((locale: Locale) => {
    void changeLocale(locale).then(() => {
      document.documentElement.lang = locale;
      // 언어가 바뀌면 리소스에서 뽑는 라벨("새 폴더" 등)을 다시 그려야 한다.
      // 메인이 곧 GRID_UPDATE 도 보내지만 그걸 기다리지 않고 현재 데이터로 즉시 반영한다.
      if (current) paint({ ...current, locale });
    });
  });

  window.bm.onPanelShow(() => playOpenAnimation());

  // 감춰질 때 미리 시작 상태를 씌워 둔다. 그래야 다음에 열릴 때 완성된 패널이
  // 한 프레임 보였다가 애니메이션이 시작되는 일이 없다.
  window.bm.onPanelHide(() => armOpenAnimation());

  /*
   * ⚠️ `visibilitychange` 를 쓰지 않는다.
   * 패널 창은 `hide()` 되지 않고 **투명해질 뿐**이라(`windows/panel.ts`) 이 이벤트가 오지 않는다.
   * 창 상태는 오직 메인이 보내는 PANEL_SHOW / PANEL_HIDE 로만 안다.
   */

  // 폴더가 열려 있을 때의 Esc 는 grid.ts 가 캡처 단계에서 먼저 가로채 폴더만 닫는다.
  // 여기까지 오면 폴더가 없다는 뜻이라 패널을 닫는다.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') handleEscape();
  });

  // 패널 바깥 클릭은 blur 로 자동으로 닫힌다 (windows/panel.ts). 여기서 따로 처리하지 않는다.
  // 폴더 오버레이 바깥 클릭도 grid.ts 가 자체 처리한다.

  // 최초 표시에도 애니메이션이 걸리게 한다 — PANEL_SHOW 가 위 `onPanelShow` 등록 **전에**
  // 도착했다면 그 메시지는 그냥 사라진다. 그 경우를 메우는 보험이다.
  //
  // PANEL_SHOW 가 제때 도착하는 정상 경로에서는 이 호출과 겹치는데, `releaseOpenAnimation()`
  // 의 `releasePending` 이 두 번째를 흡수하므로 애니메이션이 두 번 돌지 않는다.
  // (예전에는 그대로 두 번 돌아 열릴 때 두 번 깜빡였다)
  playOpenAnimation();
}

// ─────────────────────────────────────────────────────────────
// 부팅
// ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (isHotkeyWindow) {
    const payload = await window.bm.grid.get();
    await initI18n(payload.locale);
    document.documentElement.lang = payload.locale;
    mountHotkeyDialog(root as HTMLElement);
    return;
  }

  if (isFloatingWindow) {
    // 플로팅은 표시할 문자열이 없지만, t() 를 쓰게 될 경우를 대비해 init 은 해 둔다.
    const payload = await window.bm.grid.get();
    await initI18n(payload.locale);
    mountFloating(root as HTMLElement);
    return;
  }

  await bootPanel();
}

void main().catch((err) => {
  console.error('[renderer] 초기화 실패', err);
});
