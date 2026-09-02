/**
 * preload — 렌더러에 노출하는 유일한 창구.
 *
 * `contextIsolation` 이 켜져 있으므로 렌더러는 `window.bm` 만 볼 수 있다.
 * 채널 문자열은 반드시 `ipc.ts` 상수를 쓴다.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { CH, EV } from './ipc';
import type { GridEntry, GridPayload } from './types';
import type { Locale } from './i18n';

const api = {
  grid: {
    get: (): Promise<GridPayload> => ipcRenderer.invoke(CH.GRID_GET),
    save: (items: GridEntry[]): Promise<void> => ipcRenderer.invoke(CH.GRID_SAVE, items),

    /**
     * 끌어다 놓은 파일 경로들을 등록한다. 새로 들어간 개수를 돌려준다.
     * 경로는 아래 `pathForFile()` 로 얻는다.
     */
    addFiles: (paths: string[]): Promise<number> =>
      ipcRenderer.invoke(CH.GRID_ADD_FILES, paths),
    onUpdate: (cb: (payload: GridPayload) => void) => {
      ipcRenderer.on(EV.GRID_UPDATE, (_e, payload: GridPayload) => cb(payload));
    },
  },

  launch: (id: string): Promise<void> => ipcRenderer.invoke(CH.APP_LAUNCH, id),

  closePanel: (): Promise<void> => ipcRenderer.invoke(CH.PANEL_CLOSE),

  /**
   * 항목 우클릭 → 네이티브 컨텍스트 메뉴. 결과는 GRID_UPDATE 로 되돌아온다.
   * id 를 **여러 개** 넘기면(Ctrl+클릭 다중 선택) 다중 삭제 메뉴가 뜬다.
   */
  itemMenu: (ids: string | string[]): Promise<void> => ipcRenderer.invoke(CH.ITEM_MENU, ids),

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

  /**
   * 드롭된 `File` 의 실제 경로를 얻는다.
   *
   * ⚠️ Electron 32 부터 `File.path` 가 **제거됐다.** 이 앱은 43 이라 그 속성이 없다.
   *    경로는 `webUtils.getPathForFile()` 로만 얻을 수 있고, 이 API 는 **preload 에서만**
   *    쓸 수 있다. 렌더러에서 직접 부르면 undefined 가 나온다.
   *
   * 경로를 못 얻으면 빈 문자열을 돌려준다 (호출부가 걸러낸다).
   */
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
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
