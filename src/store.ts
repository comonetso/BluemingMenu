/**
 * 설정 저장소 — **포터블** (사용자 결정 2026-08-18).
 *
 * 설정 파일은 실행 파일 옆에 둔다. `%APPDATA%` 를 쓰지 않는다.
 *
 *   개발 중 (`npm start`)  →  프로젝트 루트
 *   패키징 후              →  BluemingMenu.exe 가 있는 폴더
 *
 * 패키징 후 `app.getAppPath()` 는 `resources/app.asar` 안을 가리켜 **쓸 수 없다.**
 * 그래서 실행 파일 경로에서 폴더를 뽑아 쓴다.
 */

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_COLS, DEFAULT_ROWS } from './config';
import { FALLBACK_LOCALE, type Locale } from './i18n';
import type { AppConfig, GridEntry } from './types';

const CONFIG_VERSION = 1;
const FILE_NAME = 'blueming-menu.config.json';

/**
 * 설정 파일이 놓일 폴더.
 *
 * ### 개발 중
 * 프로젝트 루트. asar 도 설치 폴더도 없으므로 그냥 여기 쓴다.
 *
 * ### 패키징 후 — ⚠️ exe 옆이 아니라 **설치 루트**다
 * Squirrel 설치본은 버전마다 폴더를 새로 만든다.
 * ```
 *   %LocalAppData%\BluemingMenu\
 *      blueming-menu.config.json   ← 여기 (버전과 무관하게 유지)
 *      app-0.1.0\BluemingMenu.exe
 *      app-0.2.0\BluemingMenu.exe  ← 업데이트하면 새로 생긴다
 *      Update.exe
 * ```
 * exe 옆(`app-0.1.0\`)에 두면 **업데이트할 때마다 배치·폴더·단축키가 통째로 초기화된다.**
 * 그래서 `app-<버전>` 폴더면 한 단계 위를 쓴다.
 *
 * Squirrel 이 아닌 배포(압축 해제형 등)는 폴더가 고정이므로 exe 옆을 그대로 쓴다.
 *
 * asar 안(`app.getAppPath()`)은 패키징 후 읽기 전용이라 쓸 수 없다.
 */
/**
 * 시스템이 관리하는 설치 위치인가 (`Program Files` 계열).
 *
 * 권한이 있든 없든 여기엔 사용자 데이터를 쓰지 않는다 — 관리자로 실행했을 때만 쓰기가 성공해
 * 설정 파일이 두 곳으로 갈리기 때문이다.
 */
function isSystemLocation(dir: string): boolean {
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432]
    .filter((r): r is string => !!r)
    .map((r) => r.toLowerCase());

  const target = dir.toLowerCase();
  return roots.some((root) => target === root || target.startsWith(`${root}\\`));
}

/** 그 폴더에 실제로 파일을 쓸 수 있는가. 권한은 물어보는 것보다 해 보는 게 정확하다 */
function canWrite(dir: string): boolean {
  const probe = path.join(dir, '.bm-write-test');
  try {
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function configDir(): string {
  if (!app.isPackaged) return app.getAppPath();

  const exeDir = path.dirname(app.getPath('exe'));

  // Squirrel 규칙: `app-<major>.<minor>.<patch>`. 그 상위가 설치 루트다.
  const portable = /^app-\d+\.\d+\.\d+/i.test(path.basename(exeDir))
    ? path.dirname(exeDir)
    : exeDir;

  /*
   * ⚠️ 쓰기 가능 여부만으로 고르면 **권한에 따라 설정 파일이 갈린다.**
   *    `Program Files` 에 설치된 앱을 관리자로 실행하면 `canWrite` 가 성공해 설치 폴더를 쓰고,
   *    평소 실행에서는 실패해 `userData` 를 쓴다. 두 파일이 따로 놀아 배치가 초기화된 것처럼 보인다.
   *    (Codex 리뷰 2026-08-18 지적)
   *
   *    그래서 **위치가 권한과 무관하게 정해지도록** 설치 경로부터 본다.
   *    `Program Files` 아래는 애초에 사용자 데이터를 둘 곳이 아니다 — 권한이 있어도 쓰지 않는다.
   */
  if (!isSystemLocation(portable) && canWrite(portable)) return portable;

  /*
   * ⚠️ 쓸 수 없는 곳에 설치된 경우 (2026-08-18 실측)
   *
   * NSIS `perMachine: true` 로 설치하면 `C:\Program Files\BluemingMenu` 에 들어가는데
   * 그 폴더는 **관리자만 쓸 수 있다.** 그대로 두면 설정 저장이 조용히 실패하고,
   * 앱을 켤 때마다 "설정 없음 → 최초 임포트" 를 반복해 배치가 매번 초기화된다.
   *
   * 그래서 쓰기가 막히면 Electron 표준 경로(`%APPDATA%\Blueming Menu`)로 물러난다.
   * 포터블 방침을 버리는 것이 아니라, **쓸 수 있는 곳에 설치했을 때만 포터블**이라는 뜻이다.
   * (per-user 설치나 압축 해제형 배포에서는 위의 `portable` 경로가 그대로 쓰인다)
   */
  const fallback = app.getPath('userData');
  console.warn(`[store] ${portable} 에 쓸 수 없다 → ${fallback} 사용`);
  return fallback;
}

export function configPath(): string {
  return path.join(configDir(), FILE_NAME);
}

function defaults(locale: Locale): AppConfig {
  return {
    version: CONFIG_VERSION,
    locale,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    // 사용자가 "앱 시작 시 기본 표시"를 고르지 않았다 → 처음엔 숨김.
    // 트레이 메뉴의 "플로팅 보이기" 로 켠다.
    floating: { x: null, y: null, visible: false },
    items: [],
    imported: false,
    // 기존 설정 파일에는 이 필드가 없다 → 0 으로 읽혀 마이그레이션이 돈다.
    iconRevision: 0,
    // 사용자 지정 (2026-08-18). 수식키만으로 이뤄진 조합이라 저수준 훅이 필요하다.
    hotkey: 'win+alt',
  };
}

let cache: AppConfig | null = null;

/**
 * 디스크에서 읽는다. 파일이 없거나 깨졌으면 기본값을 쓴다.
 * `initI18n()` 뒤에 부를 필요는 없지만, OS 로케일을 넘겨야 최초 실행 언어가 맞는다.
 */
export function loadConfig(osResolvedLocale: Locale = FALLBACK_LOCALE): AppConfig {
  if (cache) return cache;

  const file = configPath();
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    const base = defaults(osResolvedLocale);

    cache = {
      ...base,
      ...parsed,
      // 중첩 객체는 얕은 병합이 통하지 않는다. 개별로 채운다.
      floating: { ...base.floating, ...(parsed.floating ?? {}) },
      items: Array.isArray(parsed.items) ? parsed.items : base.items,
    };
    console.log(`[store] 설정 로드 — ${file}`);
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code === 'ENOENT' ? '파일 없음' : String(err);
    console.log(`[store] 기본값 사용 (${reason}) — ${file}`);
    cache = defaults(osResolvedLocale);
  }

  return cache;
}

/** 현재 설정. `loadConfig()` 를 먼저 부른 뒤에만 유효하다. */
export function getConfig(): AppConfig {
  if (!cache) throw new Error('[store] loadConfig() 를 먼저 호출해야 한다');
  return cache;
}

/**
 * 디스크에 쓴다.
 *
 * 포터블이라 `Program Files` 같은 곳에 설치하면 쓰기가 막힐 수 있다.
 * 그때 조용히 다른 경로로 옮기지 않는다 — 사용자가 포터블을 선택했기 때문이다.
 * 실패는 로그로 남긴다.
 */
export function saveConfig(): void {
  if (!cache) return;
  const file = configPath();
  try {
    fs.writeFileSync(file, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (err) {
    console.error(`[store] 저장 실패 — ${file}\n${err}`);
  }
}

/** 부분 갱신 후 즉시 저장 */
export function updateConfig(patch: Partial<AppConfig>): AppConfig {
  const cfg = getConfig();
  Object.assign(cfg, patch);
  saveConfig();
  return cfg;
}

export function setFloatingPosition(x: number, y: number): void {
  const cfg = getConfig();
  cfg.floating.x = x;
  cfg.floating.y = y;
  saveConfig();
}

export function setFloatingVisible(visible: boolean): void {
  const cfg = getConfig();
  cfg.floating.visible = visible;
  saveConfig();
}

export function setItems(items: GridEntry[]): void {
  const cfg = getConfig();
  cfg.items = items;
  saveConfig();
}
