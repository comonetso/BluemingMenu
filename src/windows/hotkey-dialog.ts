/**
 * 단축키 설정 창.
 *
 * 사용자가 "키 입력 창" 방식을 골랐다 (2026-08-18). 프리셋 목록이 아니라 **직접 눌러서** 정한다.
 *
 * 이 창은 패널·플로팅과 달리 **평범한 창**이다.
 *   - 포커스를 받아야 키 입력을 잡는다 (`showInactive` 를 쓰면 안 된다)
 *   - blur 로 닫지 않는다. 키를 누르는 도중 포커스가 흔들려 창이 사라지면 못 쓴다
 *   - 창을 파괴한다. 자주 여는 창이 아니라 붙들고 있을 이유가 없다
 */

import { BrowserWindow, screen } from 'electron';
import { loadRenderer, preloadPath } from './paths';

/**
 * 창 크기. **임의값이다** — 안내 문구와 조합 표시가 들어갈 만한 크기를 눈대중으로 잡았다.
 * 내용이 잘리거나 남으면 여기를 고친다.
 */
const DIALOG_WIDTH = 380;
const DIALOG_HEIGHT = 220;

let dialog: BrowserWindow | null = null;

/** 커서가 있는 화면 한가운데. 여러 모니터에서 엉뚱한 곳에 뜨지 않게 한다 */
function centerOnCursor(): { x: number; y: number } {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = display.workArea;
  return {
    x: Math.round(wa.x + (wa.width - DIALOG_WIDTH) / 2),
    y: Math.round(wa.y + (wa.height - DIALOG_HEIGHT) / 2),
  };
}

/** 이미 떠 있으면 앞으로 가져오고, 없으면 만든다 */
export function openHotkeyDialog(): void {
  if (dialog && !dialog.isDestroyed()) {
    dialog.show();
    dialog.focus();
    return;
  }

  const { x, y } = centerOnCursor();

  const win = new BrowserWindow({
    x,
    y,
    width: DIALOG_WIDTH,
    height: DIALOG_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 렌더러는 index.html 하나를 공유하고 해시로 갈린다 (패널 / #floating / #hotkey).
  loadRenderer(win, 'hotkey');

  win.once('ready-to-show', () => {
    win.show();
    // 키 입력을 받아야 하므로 반드시 포커스를 준다.
    win.focus();
  });

  win.on('closed', () => {
    dialog = null;
  });

  dialog = win;
}

export function closeHotkeyDialog(): void {
  if (dialog && !dialog.isDestroyed()) dialog.close();
  dialog = null;
}
