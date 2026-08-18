/**
 * 창을 만들 때 쓰는 경로·로딩 헬퍼.
 *
 * ## 왜 이 파일이 생겼나 (2026-08-18)
 * Electron Forge → `electron-vite` + `electron-builder` 로 옮기면서 **렌더러 로딩 규약이
 * 통째로 바뀌었다.** Forge 플러그인이 만들어 주던 전역 상수는 더 이상 존재하지 않는다.
 *
 * ```
 *   MAIN_WINDOW_VITE_DEV_SERVER_URL   →  process.env.ELECTRON_RENDERER_URL
 *   MAIN_WINDOW_VITE_NAME             →  (없음) — 출력이 항상 out/renderer 다
 *   preload: __dirname/preload.js     →  __dirname/../preload/preload.js
 * ```
 *
 * 창은 셋(패널 · 플로팅 · 단축키 설정)이고 셋 다 같은 분기를 필요로 한다.
 * 한 곳에 모아 두지 않으면 빌드 도구를 또 바꿀 때 세 군데를 따로 고쳐야 하고 반드시 하나를 빠뜨린다.
 *
 * ## 출력 구조
 * ```
 *   out/main/main.js         ← __dirname 이 여기다
 *   out/preload/preload.js
 *   out/renderer/index.html
 * ```
 */

import type { BrowserWindow } from 'electron';
import path from 'node:path';

/**
 * 개발 모드인가.
 *
 * `electron-vite dev` 로 띄우면 렌더러가 개발 서버에서 오고 이 환경변수가 채워진다.
 * 패키징 빌드에는 없다.
 */
export const IS_DEV = !!process.env.ELECTRON_RENDERER_URL;

/** preload 스크립트 절대 경로 */
export function preloadPath(): string {
  return path.join(__dirname, '../preload/preload.js');
}

/**
 * 렌더러를 로드한다.
 *
 * `hash` 를 주면 어느 화면인지 갈린다 — `renderer.ts` 가 `location.hash` 로 분기한다.
 *   (없음)      → 팝업 패널
 *   `floating`  → 플로팅 아이콘
 *   `hotkey`    → 단축키 설정
 *
 * ⚠️ 개발 서버 URL 에는 `#` 를 직접 붙이고, 파일 로드에는 `{ hash }` 옵션을 쓴다.
 *    `loadFile` 에 `#` 를 이어 붙이면 경로의 일부로 해석돼 파일을 못 찾는다.
 */
export function loadRenderer(win: BrowserWindow, hash?: string): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL;

  if (devUrl) {
    win.loadURL(hash ? `${devUrl}#${hash}` : devUrl);
    return;
  }

  const file = path.join(__dirname, '../renderer/index.html');
  win.loadFile(file, hash ? { hash } : undefined);
}
