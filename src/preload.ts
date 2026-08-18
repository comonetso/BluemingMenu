/**
 * preload — 렌더러에 노출하는 유일한 창구.
 *
 * `contextIsolation` 이 켜져 있으므로 렌더러는 `window.bm` 만 볼 수 있다.
 * 채널 문자열은 반드시 `ipc.ts` 상수를 쓴다.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { CH, EV } from './ipc';
import type { GridEntry, GridPayload } from './types';
import type { Locale } from './i18n';

const api = {
  grid: {
    get: (): Promise<GridPayload> => ipcRenderer.invoke(CH.GRID_GET),
    save: (items: GridEntry[]): Promise<void> => ipcRenderer.invoke(CH.GRID_SAVE, items),
    onUpdate: (cb: (payload: GridPayload) => void) => {
      ipcRenderer.on(EV.GRID_UPDATE, (_e, payload: GridPayload) => cb(payload));
    },
  },

  launch: (id: string): Promise<void> => ipcRenderer.invoke(CH.APP_LAUNCH, id),

  closePanel: (): Promise<void> => ipcRenderer.invoke(CH.PANEL_CLOSE),

  /** 항목 우클릭 → 네이티브 컨텍스트 메뉴. 결과는 GRID_UPDATE 로 되돌아온다 */
  itemMenu: (id: string): Promise<void> => ipcRenderer.invoke(CH.ITEM_MENU, id),

  /** 단축키 설정 창 전용 */
  hotkey: {
    get: (): Promise<string> => ipcRenderer.invoke(CH.HOTKEY_GET),
    set: (combo: string): Promise<void> => ipcRenderer.invoke(CH.HOTKEY_SET, combo),
    close: (): Promise<void> => ipcRenderer.invoke(CH.HOTKEY_CLOSE),
  },

  onPanelShow: (cb: () => void) => {
    ipcRenderer.on(EV.PANEL_SHOW, () => cb());
  },

  /** 패널이 감춰졌다 — 다음 열기를 위해 애니메이션 시작 상태를 미리 씌우라 */
  onPanelHide: (cb: () => void) => {
    ipcRenderer.on(EV.PANEL_HIDE, () => cb());
  },

  onLocaleChange: (cb: (locale: Locale) => void) => {
    ipcRenderer.on(EV.LOCALE_CHANGE, (_e, locale: Locale) => cb(locale));
  },

  floating: {
    toggle: (): Promise<void> => ipcRenderer.invoke(CH.FLOATING_TOGGLE),
    move: (dx: number, dy: number): Promise<void> => ipcRenderer.invoke(CH.FLOATING_MOVE, dx, dy),
    moveEnd: (): Promise<void> => ipcRenderer.invoke(CH.FLOATING_MOVE_END),
    menu: (): Promise<void> => ipcRenderer.invoke(CH.FLOATING_MENU),
  },
};

contextBridge.exposeInMainWorld('bm', api);

export type BluemingApi = typeof api;
