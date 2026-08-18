import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

/**
 * 3계층 빌드 — main / preload / renderer.
 *
 * ## 왜 Electron Forge 에서 옮겼나 (2026-08-18)
 * Forge 의 Windows maker 는 Squirrel 이고, 표준 인스톨러(MSI)를 만들려면 WiX + .NET 3.5 라는
 * 시스템 도구가 필요했다. 반면 `electron-vite` + `electron-builder` 조합은 NSIS 인스톨러를
 * 추가 도구 없이 만든다 — 설치 UI · 설치 경로 선택 · 제어판 등록이 전부 딸려 온다.
 * (같은 워크스페이스의 BluemingWiki 가 이 구성으로 잘 돌고 있어 그대로 따랐다)
 *
 * ## ⚠️ 렌더러 로딩 규약이 바뀌었다
 * Forge 플러그인이 만들어 주던 전역 상수는 **더 이상 없다.**
 * ```
 *   MAIN_WINDOW_VITE_DEV_SERVER_URL   →  process.env.ELECTRON_RENDERER_URL
 *   MAIN_WINDOW_VITE_NAME             →  (없음) — 출력이 항상 out/renderer 다
 * ```
 * 창을 로드하는 코드는 `src/windows/*.ts` 세 곳에 있다.
 *
 * ## 출력 구조
 * ```
 *   out/main/main.js         ← package.json 의 "main" 이 가리킨다
 *   out/preload/preload.js
 *   out/renderer/index.html
 * ```
 * `__dirname` 은 `out/main` 이므로 렌더러는 `../renderer/index.html`, preload 는
 * `../preload/preload.js` 로 잡힌다.
 */
export default defineConfig({
  main: {
    // dependencies 는 번들하지 않고 node_modules 에서 불러온다.
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      lib: { entry: resolve(__dirname, 'src/main.ts') },
    },
  },

  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      lib: { entry: resolve(__dirname, 'src/preload.ts') },
    },
  },

  renderer: {
    // index.html 이 프로젝트 루트에 있고 `/src/renderer.ts` 를 참조한다.
    root: '.',
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: resolve(__dirname, 'index.html') },
    },
  },
});
