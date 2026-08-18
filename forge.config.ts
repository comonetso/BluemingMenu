import fs from 'node:fs/promises';
import path from 'node:path';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    // productName 이 "Blueming Menu" 라 그대로 두면 exe 에 공백이 들어간다.
    // DIRECTION.md 가 지정한 실행 파일명은 BluemingMenu.exe 이므로 명시한다.
    executableName: 'BluemingMenu',
    // 확장자를 붙이지 않는다 — packager 가 플랫폼별로 .ico/.icns 를 알아서 붙인다.
    // 원본은 assets/icons/d-rising.svg 이고 `npm run icon` 으로 생성한다.
    icon: 'assets/icons/icon',

    /**
     * asar 밖에 그대로 복사할 것들. 설치 후 `process.resourcesPath` 아래에 놓인다.
     *
     * ⚠️ **전역 단축키 훅 프로세스는 반드시 여기 있어야 한다.** asar 안에 들어가면
     *    `spawn` 으로 실행할 수 없다(실행 파일은 실제 파일시스템에 있어야 한다).
     *    빠뜨리면 설치본에서 단축키만 조용히 동작하지 않는다 — `src/hotkey.ts` 가
     *    경로를 못 찾고 경고만 남기기 때문에 눈치채기 어렵다.
     *
     * ⚠️ 이 파일은 `npm run make` 전에 미리 빌드돼 있어야 한다:
     *      cd native/hotkey
     *      cargo +stable-x86_64-pc-windows-gnu build --release
     */
    extraResource: [
      'native/hotkey/target/release/blueming-hotkey.exe',

      /**
       * ⚠️ 트레이 아이콘도 **asar 밖**에 있어야 한다.
       *    `nativeImage.createFromPath()` 는 네이티브 코드로 파일을 읽어서 asar 가상 경로를
       *    이해하지 못한다. asar 안에 두면 패키징 후 트레이 아이콘이 **빈 사각형**으로 나온다
       *    (2026-08-18 실측 — 개발 중에는 asar 가 없어 멀쩡해서 눈치채기 어렵다).
       */
      'assets/icons/icon.ico',
    ],
  },
  rebuildConfig: {},

  hooks: {
    /**
     * 최종 배포물을 `dist/` 한 곳에 모은다.
     *
     * Forge 기본 출력은 `out/make/squirrel.windows/x64/...` 로 깊고, 파일명에 공백이 들어간다
     * (`Blueming Menu-0.1.0 Setup.exe`). 이 프로젝트는 경로 공백 때문에 이미 여러 번 데였고
     * `executableName` 도 공백 없이 `BluemingMenu` 로 고정해 두었다 — 배포물도 같은 규칙을 따른다.
     *
     * `out/` 은 중간 산출물이라 그대로 둔다. 사람이 가져다 쓰는 것은 `dist/` 뿐이다.
     */
    async postMake(_forgeConfig, makeResults) {
      const distDir = path.join(__dirname, 'dist');
      await fs.rm(distDir, { recursive: true, force: true });
      await fs.mkdir(distDir, { recursive: true });

      for (const result of makeResults) {
        for (const artifact of result.artifacts) {
          // "Blueming Menu-0.1.0 Setup.exe" → "BluemingMenu-0.1.0-Setup.exe"
          // 앱 이름은 붙여 쓰고(executableName 과 같은 규칙), 나머지 공백만 하이픈으로 바꾼다.
          const cleaned = path
            .basename(artifact)
            .replace(/Blueming Menu/g, 'BluemingMenu')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-');
          const dest = path.join(distDir, cleaned);
          await fs.copyFile(artifact, dest);
          console.log(`[dist] ${cleaned}`);
        }
      }

      return makeResults;
    },
  },
  makers: [
    new MakerSquirrel({ setupIcon: 'assets/icons/icon.ico' }),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
