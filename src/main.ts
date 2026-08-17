import { app, BrowserWindow, Tray, Menu, nativeImage } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { initI18n, resolveLocale, t } from './i18n';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// Tray 객체가 GC 되면 트레이 아이콘이 사라진다. 모듈 스코프에 붙들어 둔다.
let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

const showWindow = () => {
  if (!mainWindow) {
    createWindow();
    return;
  }
  mainWindow.show();
  mainWindow.focus();
};

const createTray = () => {
  // .ico 를 쓴다 — 16~256px 을 모두 담고 있어 Windows 가 DPI 에 맞는 해상도를 고른다.
  // 이 PC 는 DPI 스케일이 걸려 있어 단일 PNG 를 주면 뭉갠다.
  const iconPath = path.join(app.getAppPath(), 'assets', 'icons', 'icon.ico');
  const icon = nativeImage.createFromPath(iconPath);

  if (icon.isEmpty()) {
    console.error(`[tray] 아이콘을 읽지 못했다: ${iconPath}`);
  }

  tray = new Tray(icon);
  tray.setToolTip(t('app.name'));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t('tray.open'), click: showWindow },
      { type: 'separator' },
      { label: t('tray.quit'), click: () => app.quit() },
    ]),
  );

  // 트레이 아이콘 클릭으로도 연다 (Windows 관행)
  tray.on('click', showWindow);

  console.log(`[tray] 준비 완료 — ${iconPath}`);
};

app.on('ready', async () => {
  // app.getLocale() 은 ready 이후에야 정확한 값을 준다.
  const osLocale = app.getLocale();
  const locale = resolveLocale(osLocale);
  await initI18n(locale);
  console.log(`[i18n] OS=${osLocale} → ${locale} | ${t('contextMenu.add')}`);

  // 트레이를 먼저 띄운다. 창이 없어도 앱이 살아 있다는 것을 보장하는 유일한 접점이다.
  createTray();
  createWindow();
});

// 트레이 상주 앱이므로 창이 닫혀도 종료하지 않는다.
// (1단계 요구사항 — 포커스를 잃으면 패널이 닫히지만 앱 자체는 계속 떠 있어야 한다)
// 종료 경로는 트레이 메뉴뿐이다.
app.on('window-all-closed', () => {
  // 의도적으로 비워 둔다. 여기서 app.quit() 을 부르면 트레이 상주가 깨진다.
});
