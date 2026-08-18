/// <reference types="vite/client" />

// 렌더러가 이미지를 `import iconUrl from '...png'` 로 가져온다 (플로팅 아이콘).
// 이 참조가 없으면 Vite 는 정상 번들하는데 tsc/에디터만 "모듈을 찾을 수 없다"고 한다.
//
// ⚠️ 예전에는 여기에 `@electron-forge/plugin-vite/forge-vite-env` 참조가 있었다.
//    그것이 `MAIN_WINDOW_VITE_DEV_SERVER_URL` / `MAIN_WINDOW_VITE_NAME` 전역 상수를
//    만들어 줬는데, 빌드를 `electron-vite` 로 옮기면서 그 상수들이 사라졌다.
//    렌더러 로딩은 이제 `src/windows/paths.ts` 가 담당한다.
