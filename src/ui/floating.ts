/**
 * 플로팅 아이콘 — 렌더러 쪽 화면.
 *
 * 사용자 요구사항 (2026-08-18)
 *   "AlwaysOnTop 플로팅 아이콘을 띄워서 그것을 클릭하면 메뉴가 나오고, 다시 클릭하면 사라짐"
 *   "플로팅은 드래그로 이동이 가능한데, 이동 좌표를 영구 저장해서 프로그램이 새로 시작해도 동일한 위치 유지"
 *   우클릭 컨텍스트 메뉴는 "숨김 / 종료" 두 개 — 메뉴 자체는 메인 프로세스가 띄운다.
 *
 * ⚠️ 이 파일은 **렌더러 프로세스**에서 돈다. `electron` 을 import 하지 않는다.
 *    메인과의 통신은 preload 가 노출한 `window.bm` 만 쓴다.
 *
 * ⚠️ CSS 의 `-webkit-app-region: drag` 를 쓰지 않는다.
 *    그 속성이 걸린 영역은 OS 가 창 이동으로 가로채므로 마우스 이벤트가 렌더러까지 오지 않는다.
 *    그러면 "클릭하면 토글" 이 아예 동작하지 않는다.
 *    그래서 드래그도 클릭도 Pointer 이벤트로 직접 구분해 처리한다.
 *
 * 스타일(배경·크기·모양)은 전부 CSS 담당이다. 여기서는 클래스명만 붙인다.
 * 창이 `transparent: true` 이므로 이 파일에서 배경을 칠하지 않는다.
 */

import type { BluemingApi } from '../preload';

// 창 크기가 FLOATING_SIZE(48 논리 픽셀)다.
// config.ts 실측대로 이 PC 배율이 1.3959 → 창의 물리 크기는 약 67px 이다.
//   - icon-64.png 는 67px 에 못 미쳐 업스케일 흐림이 생긴다
//   - icon-128.png 는 배율 2.0(물리 96px) 환경까지 덮으면서 다운스케일만 일어난다
// 그래서 128 을 고른다. 파일 경로는 Vite 가 번들해 URL 로 바꿔 준다
// (렌더러는 파일시스템 경로를 직접 읽지 못한다).
import iconUrl from '../../assets/icons/build/icon-128.png';

/**
 * 클릭과 드래그를 가르는 이동 거리 (CSS 픽셀).
 *
 * ⚠️ **임의값** — 사용자가 지정한 바 없다.
 *    누른 채로 이 거리보다 덜 움직이면 손떨림으로 보고 클릭(토글)으로 처리한다.
 *    값을 키우면 "살짝 끌었는데 창이 안 움직인다", 줄이면 "누르기만 했는데 창이 밀린다" 가 된다.
 */
const DRAG_THRESHOLD_PX = 4;

/** 마우스 주 버튼 (PointerEvent.button) */
const PRIMARY_BUTTON = 0;

/**
 * `window.bm` 의 전역 타입 선언은 이 파일의 담당이 아니다.
 * 중복 선언으로 충돌하지 않도록 여기서는 참조만 한다.
 */
function bm(): BluemingApi {
  return (window as unknown as { bm: BluemingApi }).bm;
}

/**
 * IPC 는 실패해도 화면을 멈추지 않는다. 미처리 rejection 만 삼킨다.
 * 이 로그는 개발자용이라 번역 대상이 아니다.
 */
function fire(p: Promise<void>): void {
  p.catch((err: unknown) => console.error('[floating] IPC 실패', err));
}

export function mountFloating(root: HTMLElement): void {
  const el = document.createElement('div');
  el.className = 'bm-floating';

  const img = document.createElement('img');
  img.className = 'bm-floating-icon';
  img.src = iconUrl;
  img.alt = '';
  // 브라우저 기본 이미지 드래그(고스트 이미지가 끌려다니는 것)를 막는다.
  img.draggable = false;

  // 드래그 중 텍스트/이미지가 선택되거나 끌려가지 않게 한다.
  // 배경·크기 같은 겉모습은 건드리지 않으므로 CSS 담당과 충돌하지 않는다.
  el.style.userSelect = 'none';
  img.style.setProperty('-webkit-user-drag', 'none');

  el.appendChild(img);
  root.appendChild(el);

  // ── 드래그 상태 ─────────────────────────────────────────────
  /** 추적 중인 포인터. 없으면 -1 */
  let activePointerId = -1;
  /** 누른 지점 (화면 절대 좌표) */
  let startScreenX = 0;
  let startScreenY = 0;
  /** 마지막으로 메인에 반영한 지점 (화면 절대 좌표) */
  let lastScreenX = 0;
  let lastScreenY = 0;
  /** 임계값을 넘어 드래그로 확정됐는가 */
  let dragging = false;
  /** 누른 지점의 창 안 좌표 (CSS 픽셀 = 논리 픽셀). 진단용 — 아래 endPointer 참고 */
  let startClientX = 0;
  let startClientY = 0;
  /** 이번 드래그에서 메인에 보낸 이동량 합계. 진단용 */
  let sentX = 0;
  let sentY = 0;

  el.addEventListener('pointerdown', (e: PointerEvent) => {
    // 우클릭은 contextmenu 로만 처리한다. 여기서 잡으면 메뉴 중에 창이 끌린다.
    if (e.button !== PRIMARY_BUTTON) return;

    // 기본 동작(이미지 드래그·텍스트 선택·포커스 이동)을 막는다.
    e.preventDefault();

    activePointerId = e.pointerId;
    startScreenX = lastScreenX = e.screenX;
    startScreenY = lastScreenY = e.screenY;
    startClientX = e.clientX;
    startClientY = e.clientY;
    sentX = sentY = 0;
    dragging = false;

    // 개발용 진단 로그 (번역 대상 아님).
    // screen 좌표가 어떤 단위로 오는지 이 환경에서 확정되지 않았다 — 아래 endPointer 로그가 답을 준다.
    console.log(
      `[floating] pointerdown — screen(${e.screenX}, ${e.screenY}) client(${e.clientX}, ${e.clientY}) ` +
        `dpr ${window.devicePixelRatio} winScreen(${window.screenX}, ${window.screenY}) ` +
        `outer ${window.outerWidth}x${window.outerHeight} inner ${window.innerWidth}x${window.innerHeight} ` +
        `display ${window.screen.width}x${window.screen.height}`,
    );

    // 창이 커서를 따라 움직이면 포인터가 창 밖으로 벗어나는 순간이 생긴다.
    // 포인터를 붙잡아 두지 않으면 그때 pointermove·pointerup 이 끊긴다.
    el.setPointerCapture(e.pointerId);
  });

  el.addEventListener('pointermove', (e: PointerEvent) => {
    if (e.pointerId !== activePointerId) return;

    // ⚠️ 델타는 반드시 **화면 절대 좌표(screenX/screenY)** 로 잰다.
    //    창 자체가 따라 움직이므로 clientX/clientY 는 창 기준으로 거의 변하지 않는다.
    //    그 값으로 델타를 만들면 이동량이 0 에 수렴하거나 되먹임으로 떨린다.
    if (!dragging) {
      const movedX = e.screenX - startScreenX;
      const movedY = e.screenY - startScreenY;
      if (Math.hypot(movedX, movedY) < DRAG_THRESHOLD_PX) return;
      dragging = true;
      // 여기서 lastScreen 은 아직 누른 지점이다.
      // 덕분에 아래 델타가 "누른 지점 → 현재" 전체가 되어, 임계값만큼 창이 뒤처지지 않는다.
    }

    // 메인은 `현재 창 위치 + dx, dy` 로 옮긴다. 누적 절대량이 아니라 직전 대비 이동량이다.
    const dx = e.screenX - lastScreenX;
    const dy = e.screenY - lastScreenY;
    lastScreenX = e.screenX;
    lastScreenY = e.screenY;
    if (dx === 0 && dy === 0) return;

    sentX += dx;
    sentY += dy;
    fire(bm().floating.move(dx, dy));
  });

  /**
   * 드래그가 끝날 때 **screen 좌표의 단위**를 실측해 남긴다 (개발용, 번역 대상 아님).
   *
   * 배경: `screenX/screenY` 가 이 환경에서 논리 픽셀(DIP)인지 물리 픽셀인지 확정되지 않았다.
   * 메인은 받은 델타를 **논리 픽셀로 해석해서** 창을 옮기므로, 만약 screen 좌표가 물리 픽셀이면
   * 창이 배율(이 PC 1.3959)만큼 커서보다 빨리 달아난다.
   *
   * 판별식 — 단위를 몰라도 되는 관계식이다.
   *   커서의 실제 이동(논리 픽셀) = 창이 움직인 양(= 우리가 보낸 델타 합) + 창 안에서 커서가 밀린 양(clientΔ)
   *   비율 = screenΔ / 커서 실제 이동
   *     · 1        → screen 좌표도 논리 픽셀이다. 보정할 것이 없다
   *     · dpr(≈1.4) → screen 좌표가 물리 픽셀이다. 델타를 dpr 로 나눠 보내야 한다
   *
   * (clientX 는 CSS 픽셀이라 논리 픽셀과 같고, 창이 화면 밖으로 밀리지 않은 보통의 드래그에서만 유효하다)
   */
  const logDragUnits = (e: PointerEvent): void => {
    const screenDx = e.screenX - startScreenX;
    const screenDy = e.screenY - startScreenY;
    const clientDx = e.clientX - startClientX;
    const clientDy = e.clientY - startClientY;
    const cursorDipX = sentX + clientDx;
    const cursorDipY = sentY + clientDy;
    const ratio = (screenDelta: number, dip: number): string =>
      dip === 0 ? '-' : (screenDelta / dip).toFixed(3);

    console.log(
      `[floating] 드래그 종료 — screenΔ(${screenDx}, ${screenDy}) 보낸Δ(${sentX}, ${sentY}) ` +
        `clientΔ(${clientDx}, ${clientDy}) 커서실이동DIP(${cursorDipX}, ${cursorDipY}) ` +
        `screen/DIP 비율 x=${ratio(screenDx, cursorDipX)} y=${ratio(screenDy, cursorDipY)} ` +
        `(1=DIP / ${window.devicePixelRatio.toFixed(4)}=물리픽셀)`,
    );
  };

  /** 포인터 추적을 끝낸다. 드래그였으면 좌표를 저장하고, 아니면 클릭으로 본다. */
  const endPointer = (e: PointerEvent, treatAsClick: boolean): void => {
    if (e.pointerId !== activePointerId) return;

    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    activePointerId = -1;

    if (dragging) {
      dragging = false;
      logDragUnits(e);
      // 드래그가 끝날 때만 저장한다 (메인이 디스크에 쓴다).
      fire(bm().floating.moveEnd());
      return;
    }

    if (treatAsClick) fire(bm().floating.toggle());
  };

  el.addEventListener('pointerup', (e: PointerEvent) => endPointer(e, true));

  // 포인터가 취소되면(창 전환, 입력 장치 변경 등) 클릭으로 치지 않는다.
  // 이미 드래그로 창을 옮겨 놨다면 그 위치는 저장해야 한다 — endPointer 가 처리한다.
  el.addEventListener('pointercancel', (e: PointerEvent) => endPointer(e, false));

  el.addEventListener('contextmenu', (e: MouseEvent) => {
    // 브라우저 기본 메뉴를 막는다. 메뉴는 메인 프로세스가 네이티브로 띄운다.
    e.preventDefault();
    fire(bm().floating.menu());
  });
}
