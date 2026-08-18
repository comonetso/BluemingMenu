/**
 * 트레이 아이콘 + 컨텍스트 메뉴.
 *
 * ⚠️ 메뉴 **템플릿은 여기서 만들지 않는다.** `menus.ts` 의 `buildAppMenuTemplate()` 이
 *    단일 진실원이다. 플로팅 우클릭도 같은 템플릿을 쓰기 때문이다 (사용자 요구 2026-08-18).
 *    여기서 따로 만들면 메뉴를 고칠 때마다 두 군데를 고쳐야 하고 반드시 어긋난다.
 *
 * ⚠️ `Menu` 인스턴스는 공유하지 않는다. 공유하는 것은 템플릿(순수 데이터)이고
 *    `Menu.buildFromTemplate()` 은 트레이·플로팅이 각자 부른다.
 *
 * 이 모듈이 여전히 책임지는 것: 트레이 아이콘 로딩, 툴팁, 좌클릭 동작, Tray 객체 수명.
 */

import { app, Menu, Tray, nativeImage } from 'electron';
import path from 'node:path';
import { t } from './i18n';
import { buildAppMenuTemplate, type AppMenuHandlers } from './menus';

/**
 * 트레이 전용 핸들러.
 *
 * 공통 항목은 `AppMenuHandlers` 에서 물려받고, 트레이에만 있는 좌클릭만 더한다.
 * (`main.ts` 가 이 이름으로 객체를 넘긴다 — 이름을 바꾸지 않는다)
 */
export interface TrayHandlers extends AppMenuHandlers {
  onTrayClick(): void;
}

// Tray 객체가 GC 되면 트레이 아이콘이 사라진다. 모듈 스코프에 붙들어 둔다.
let tray: Tray | null = null;

/**
 * 트레이 아이콘이 차지한 화면 사각형. 트레이가 없으면 null.
 *
 * 패널의 blur 무시 판정에 쓴다 (`windows/panel.ts` 의 `addBlurIgnoreRegion`).
 * 트레이를 클릭해서 생긴 blur 로 패널이 닫혀 버리면, 뒤따르는 토글이 다시 열어
 * 아무리 눌러도 안 닫히는 상태가 된다.
 *
 * ⚠️ 매번 새로 조회한다. 트레이 아이콘 위치는 다른 아이콘이 늘고 줄면 바뀐다.
 */
export function getTrayBounds(): Electron.Rectangle | null {
  return tray ? tray.getBounds() : null;
}

// rebuildTrayMenu() 가 재사용해야 하므로 핸들러도 모듈 스코프에 보관한다.
let handlers: TrayHandlers | null = null;

/**
 * 매번 새로 만든다 — 라벨(언어)과 radio 체크 상태(구성·플로팅)가 그때그때 달라지기 때문이다.
 * 캐싱하면 언어를 바꿔도 옛 문구가 남는다.
 */
function buildMenu(h: TrayHandlers): Menu {
  return Menu.buildFromTemplate(buildAppMenuTemplate(h));
}

/**
 * 트레이 아이콘 파일 경로.
 *
 * `.ico` 를 쓴다 — 16~256px 을 모두 담고 있어 Windows 가 DPI 에 맞는 해상도를 고른다.
 * 이 PC 는 DPI 스케일이 걸려 있어 단일 PNG 를 주면 뭉갠다.
 *
 * ### ⚠️ 패키징 후에는 asar 밖을 봐야 한다 (2026-08-18 실측)
 * `nativeImage.createFromPath()` 는 **네이티브 코드로 파일을 읽어 asar 가상 경로를 모른다.**
 * `app.getAppPath()`(= `resources/app.asar`) 아래를 가리키면 조용히 빈 이미지가 돌아와
 * 트레이에 **빈 사각형**이 뜬다. 개발 중에는 asar 가 없어 멀쩡하므로 눈치채기 어렵다.
 *
 * 그래서 `forge.config.ts` 의 `extraResource` 로 `resources/` 에 복사해 두고 그것을 쓴다.
 */
function trayIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(app.getAppPath(), 'assets', 'icons', 'icon.ico');
}

export function createTray(trayHandlers: TrayHandlers): void {
  // 두 번 만들면 트레이에 아이콘이 두 개 남는다. 기존 것을 먼저 정리한다.
  if (tray) destroyTray();

  handlers = trayHandlers;

  const iconPath = trayIconPath();
  const icon = nativeImage.createFromPath(iconPath);

  if (icon.isEmpty()) {
    console.error(`[tray] 아이콘을 읽지 못했다: ${iconPath}`);
  }

  tray = new Tray(icon);
  tray.setToolTip(t('app.name'));
  tray.setContextMenu(buildMenu(trayHandlers));

  // 좌클릭은 패널 토글이다 — 플로팅 아이콘과 같은 동작 (사용자 지정 2026-08-18).
  tray.on('click', () => trayHandlers.onTrayClick());

  console.log(`[tray] 준비 완료 — ${iconPath}`);
}

/**
 * 언어 · 구성 · 플로팅 표시 상태가 바뀐 뒤에 호출한다.
 * 호출하지 않으면 메뉴 문구가 옛 언어로 남고 radio 체크가 실제 값과 어긋난다.
 */
export function rebuildTrayMenu(): void {
  if (!tray || !handlers) return;

  // 툴팁도 리소스에서 온다. 언어가 바뀌었을 수 있으니 함께 다시 쓴다.
  tray.setToolTip(t('app.name'));
  tray.setContextMenu(buildMenu(handlers));
}

export function destroyTray(): void {
  if (!tray) return;
  tray.destroy();
  tray = null;
  handlers = null;
}
