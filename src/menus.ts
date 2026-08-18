/**
 * 트레이와 플로팅 우클릭이 **공유하는** 메뉴 템플릿.
 *
 * 메뉴 구성과 순서는 사용자가 지정했다 (DIRECTION.md 3.8, 2026-08-18).
 *
 *   플로팅 보이기/숨김
 *   언어변경
 *   구성변경
 *   ─────────
 *   종료
 *
 * "열기" 항목은 **없다.** 패널을 여는 경로는 트레이 아이콘 좌클릭과 플로팅 아이콘이다.
 *
 * ⚠️ 두 곳이 같은 메뉴를 띄우므로 템플릿은 반드시 여기 한 곳에서만 만든다.
 *    각자 만들면 메뉴를 고칠 때마다 두 군데를 고쳐야 하고 반드시 어긋난다.
 *
 * ⚠️ 공유하는 것은 **템플릿(순수 데이터)** 뿐이다. `Menu` 객체는 공유하지 않는다 —
 *    트레이와 플로팅이 같은 `Menu` 인스턴스를 물면 문제가 생긴다.
 *    `Menu.buildFromTemplate()` 은 호출부가 각자 부른다.
 *
 * ⚠️ 이 모듈은 정책을 결정하지 않는다. 실제 동작은 전부 `AppMenuHandlers` 로 위임하고,
 *    현재 상태는 `store` 와 `i18n` 에서 읽기만 한다.
 */

import type { MenuItemConstructorOptions } from 'electron';
import { GRID_CHOICES } from './config';
import { currentLocale, t, type Locale } from './i18n';
import { getConfig } from './store';

/** 트레이와 플로팅 우클릭이 공유하는 핸들러 */
export interface AppMenuHandlers {
  onToggleFloating(): void;
  onLocaleChange(locale: Locale): void;
  onGridChange(cols: number, rows: number): void;
  /** 단축키 설정 창을 연다 */
  onHotkeySetting(): void;
  onQuit(): void;
  isFloatingVisible(): boolean;
}

/** 그리드 선택 서브메뉴 하나(가로 또는 세로)를 만든다 */
function gridSubmenu(
  current: number,
  onPick: (value: number) => void,
): MenuItemConstructorOptions[] {
  return GRID_CHOICES.map((n) => ({
    // 숫자는 번역 대상이 아니다.
    label: String(n),
    type: 'radio' as const,
    checked: n === current,
    click: () => onPick(n),
  }));
}

/**
 * 트레이·플로팅이 공유하는 메뉴 템플릿을 만든다.
 *
 * 매번 새로 만들어야 한다 — 라벨(언어)과 radio 체크 상태(구성·플로팅)가 그때그때 달라진다.
 * 템플릿을 캐싱하면 언어를 바꿔도 옛 문구가 남고, radio 체크가 실제 값과 어긋난다.
 */
export function buildAppMenuTemplate(h: AppMenuHandlers): MenuItemConstructorOptions[] {
  // 설정은 loadConfig() 가 끝난 뒤에만 유효하다. 메뉴를 띄우는 시점은 그 이후다.
  const cfg = getConfig();

  // 라벨은 i18next 의 현재 언어로 찍힌다. radio 체크도 같은 값을 봐야 서로 어긋나지 않는다.
  const locale = currentLocale();

  return [
    {
      label: h.isFloatingVisible() ? t('tray.floatingHide') : t('tray.floatingShow'),
      click: () => h.onToggleFloating(),
    },
    {
      label: t('tray.language'),
      submenu: [
        {
          label: t('tray.langKo'),
          type: 'radio',
          checked: locale === 'ko',
          click: () => h.onLocaleChange('ko'),
        },
        {
          label: t('tray.langEn'),
          type: 'radio',
          checked: locale === 'en',
          click: () => h.onLocaleChange('en'),
        },
      ],
    },
    {
      label: t('tray.layout'),
      // 사용자 결정 (2026-08-18) — 가로·세로를 따로 고른다.
      submenu: [
        {
          label: t('tray.layoutCols'),
          submenu: gridSubmenu(cfg.cols, (cols) => h.onGridChange(cols, cfg.rows)),
        },
        {
          label: t('tray.layoutRows'),
          submenu: gridSubmenu(cfg.rows, (rows) => h.onGridChange(cfg.cols, rows)),
        },
      ],
    },
    {
      // 사용자 결정 (2026-08-18) — 프리셋 목록이 아니라 키를 직접 눌러 정한다.
      label: t('tray.hotkey'),
      click: () => h.onHotkeySetting(),
    },
    { type: 'separator' },
    {
      label: t('tray.quit'),
      click: () => h.onQuit(),
    },
  ];
}
