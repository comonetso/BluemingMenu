/**
 * 레이아웃 상수 — 이 PC 의 Windows 11 시작 메뉴 실측값 (2026-08-18).
 *
 * 측정 방법
 *   1. 시작 메뉴 스크린샷을 떠서 아이콘 중심 간격을 물리 픽셀로 쟀다
 *   2. 화면 배율로 나눠 논리 픽셀로 환산했다 (Electron 은 논리 픽셀로 동작한다)
 *
 *   GetDeviceCaps 실측:  물리 2560x1440 / 논리 1834x1032  →  배율 1.3959
 *
 *   | 항목      | 물리 | ÷1.3959 | 논리 |
 *   |-----------|------|---------|------|
 *   | 셀 폭     | 134  | 95.99   | 96   |
 *   | 셀 높이   | 120  | 85.97   | 86   |
 *   | 아이콘    |  44  | 31.5    | 32   |
 *   | 안쪽 여백 |  45  | 32.2    | 32   |
 *
 * 아이콘 32 논리는 `app.getFileIcon(p, {size:'normal'})` 이 주는 크기와 정확히 같다.
 * 리사이즈 없이 그대로 쓸 수 있다는 뜻이며, 실측이 맞다는 교차 근거다.
 *
 * ⚠️ 이 값들을 "적당히" 고치지 마라. 시작 메뉴와 같은 밀도로 보이는 것이 요구사항이다.
 *    실측을 다시 했다면 위 표와 함께 갱신한다.
 */

/** 셀 하나의 폭 (논리 픽셀) */
export const CELL_WIDTH = 96;

/** 셀 하나의 높이 (논리 픽셀) */
export const CELL_HEIGHT = 86;

/** 아이콘 변 길이 (논리 픽셀) */
export const ICON_SIZE = 32;

/** 패널 안쪽 여백 (논리 픽셀) */
export const PANEL_PADDING = 32;

/**
 * 기본 그리드 구성 — 사용자 지정 (2026-08-18).
 * "가로 7개, 세로도 7개로 하고 향후에 수정하면 될 것 같음"
 */
export const DEFAULT_COLS = 7;
export const DEFAULT_ROWS = 7;

/**
 * 트레이 "구성변경" 메뉴에서 고를 수 있는 범위.
 * 사용자가 범위를 지정한 적은 없다 — 조정이 필요하면 이 배열만 고치면 된다.
 */
export const GRID_CHOICES = [4, 5, 6, 7, 8, 9, 10] as const;

/**
 * 패널이 화면 가장자리에서 띄우는 거리 (논리 픽셀).
 * 시작 메뉴도 작업표시줄·화면 끝에 딱 붙지 않는다.
 */
export const PANEL_MARGIN = 8;

/** 플로팅 아이콘 창 한 변 (논리 픽셀) */
export const FLOATING_SIZE = 48;

/** 그리드 열 수로부터 패널 전체 폭을 구한다 */
export function panelWidth(cols: number): number {
  return cols * CELL_WIDTH + PANEL_PADDING * 2;
}

/**
 * 그리드 행 수로부터 패널 전체 높이를 구한다.
 * 검색창은 사용자 결정에 따라 넣지 않는다 (2026-08-18).
 */
export function panelHeight(rows: number): number {
  return rows * CELL_HEIGHT + PANEL_PADDING * 2;
}
