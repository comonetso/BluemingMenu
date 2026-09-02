/**
 * 메인 프로세스 — 조립부.
 *
 * 창·트레이·설정·스캐너를 각 모듈이 맡고, 이 파일은 그것들을 엮고 IPC 를 받는다.
 * 여기에 UI 로직이나 배치 계산을 쓰지 마라. 각 모듈이 담당한다.
 */

import { app, BrowserWindow, ipcMain, shell, Menu } from 'electron';
import started from 'electron-squirrel-startup';
import { spawn } from 'node:child_process';

import { initI18n, changeLocale, resolveLocale, t, type Locale } from './i18n';
import { loadConfig, getConfig, updateConfig, setItems } from './store';
import { CH, EV } from './ipc';
import { buildAppMenuTemplate } from './menus';
import { scanStartMenu, readShortcutEntry, refreshIcons } from './scanner';
import { startPipeServer, stopPipeServer } from './pipe';
import { startHotkey, stopHotkey } from './hotkey';
import { openHotkeyDialog, closeHotkeyDialog } from './windows/hotkey-dialog';
import {
  createTray,
  rebuildTrayMenu,
  destroyTray,
  getTrayBounds,
  type TrayHandlers,
} from './tray';
import {
  createPanel,
  getPanel,
  hidePanel,
  showPanel,
  togglePanel,
  resizePanel,
  suspendBlurClose,
  resumeBlurClose,
  addBlurIgnoreRegion,
  setMouseButtonDown,
} from './windows/panel';
import {
  createFloating,
  getFloating,
  isFloatingVisible,
  moveFloatingBy,
  persistFloatingPosition,
  showFloating,
  toggleFloating,
} from './windows/floating';
import type { AppEntry, FolderEntry, GridEntry, GridPayload } from './types';

// Squirrel 설치/제거 중에는 바로 빠진다.
if (started) {
  app.quit();
}

/**
 * 트레이 "종료" 로 끝낼 때만 true.
 * 이 플래그가 없으면 창을 닫는 것과 앱을 끝내는 것을 구분할 수 없다.
 */
let isQuitting = false;

/**
 * 단일 인스턴스 — 트레이 상주 앱이라 두 번 뜨면 트레이 아이콘이 둘이 된다.
 * 나중에 탐색기 컨텍스트 메뉴(`--add "%1"`)를 붙일 때도 이 경로로 인자를 넘긴다.
 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showPanel();
  });
}

// ─────────────────────────────────────────────────────────────
// 그리드 데이터
// ─────────────────────────────────────────────────────────────

function buildPayload(): GridPayload {
  const cfg = getConfig();
  return {
    cols: cfg.cols,
    rows: cfg.rows,
    items: cfg.items,
    locale: cfg.locale,
  };
}

/** 패널·플로팅 양쪽 렌더러에 이벤트를 보낸다 (한쪽이 없을 수 있다) */
function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of [getPanel(), getFloating()]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
  }
}

function pushGrid(): void {
  broadcast(EV.GRID_UPDATE, buildPayload());
}

/**
 * 찾은 항목과 그 **위치**.
 *
 * 삭제·해체는 "무엇인가"만으로는 못 한다. 어느 배열의 몇 번째인지까지 알아야
 * 순서를 흐트러뜨리지 않고 빼거나 끼워 넣을 수 있다.
 */
interface Located {
  entry: GridEntry;
  /** 폴더 안에 든 항목이면 그 폴더, 최상위 항목이면 null */
  parent: FolderEntry | null;
  /** 자신이 속한 배열(`items` 또는 `parent.children`)에서의 인덱스 */
  index: number;
}

/**
 * 폴더 안까지 뒤져 항목 하나와 그 위치를 찾는다.
 *
 * 폴더 자신도 찾는다 — 폴더 우클릭 메뉴("폴더 해체")가 필요로 한다.
 * 폴더는 중첩되지 않으므로(`FolderEntry.children` 이 `AppEntry[]`) 깊이는 2단계뿐이다.
 */
function locateEntry(items: GridEntry[], id: string): Located | null {
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item.id === id) return { entry: item, parent: null, index: i };

    if (item.kind === 'folder') {
      const childIndex = item.children.findIndex((c) => c.id === id);
      if (childIndex !== -1) {
        return { entry: item.children[childIndex], parent: item, index: childIndex };
      }
    }
  }
  return null;
}

/**
 * `.lnk` 경로로 항목을 찾는다. 폴더 안까지 뒤진다.
 *
 * 탐색기 컨텍스트 메뉴는 **파일 경로**만 넘겨준다. id 를 모르므로 경로로 찾아야 한다.
 * ⚠️ Windows 경로는 대소문자를 구분하지 않는다. 그대로 비교하면 같은 파일을 못 찾아
 *    "제거" 가 "중복 등록" 이 된다.
 */
function locateByLnkPath(items: GridEntry[], lnkPath: string): Located | null {
  const key = lnkPath.toLowerCase();

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];

    if (item.kind === 'app') {
      if (item.lnkPath.toLowerCase() === key) return { entry: item, parent: null, index: i };
      continue;
    }

    const childIndex = item.children.findIndex((c) => c.lnkPath.toLowerCase() === key);
    if (childIndex !== -1) {
      return { entry: item.children[childIndex], parent: item, index: childIndex };
    }
  }
  return null;
}

/**
 * 탐색기 컨텍스트 메뉴의 토글. 이미 있으면 빼고, 없으면 넣는다.
 *
 * ⚠️ **원본 `.lnk` 파일은 건드리지 않는다.** 앱 데이터에서만 넣고 뺀다.
 */
async function toggleByLnkPath(lnkPath: string): Promise<'added' | 'removed' | 'error'> {
  const items = getConfig().items;
  const found = locateByLnkPath(items, lnkPath);

  if (found) {
    if (found.parent) found.parent.children.splice(found.index, 1);
    else items.splice(found.index, 1);

    setItems(items);
    pushGrid();
    console.log(`[pipe] 제거 — ${found.entry.name}`);
    return 'removed';
  }

  const entry = await readShortcutEntry(lnkPath);
  if (!entry) {
    console.warn(`[pipe] 등록 실패, .lnk 를 읽지 못했다 — ${lnkPath}`);
    return 'error';
  }

  /*
   * ⚠️ 위 `readShortcutEntry()` 는 **await 다** (아이콘 추출에 PowerShell 을 띄운다).
   *    그 사이 같은 파일에 대한 두 번째 요청이 들어오면 둘 다 "없음" 을 보고 각각 추가해
   *    **같은 id 의 항목이 두 개** 저장된다. 그래서 넣기 직전에 다시 확인한다.
   *    (Codex 리뷰 2026-08-18 지적)
   */
  if (locateByLnkPath(items, lnkPath)) {
    console.log(`[pipe] 이미 등록됨 (경쟁) — ${entry.name}`);
    return 'added';
  }

  /*
   * 새 항목은 **맨 앞**에 넣는다.
   *
   * 맨 뒤에 붙였더니 "등록이 안 된다" 는 보고가 반복됐다. 실제로는 저장까지 정상이었고
   * 항목이 100개를 넘다 보니 한참 스크롤해야 보이는 것이 원인이었다.
   * 방금 등록한 것이 바로 눈에 보여야 등록됐다는 사실을 알 수 있다.
   *
   * 대신 기존 항목이 한 칸씩 밀린다. 배치를 고정하고 싶다는 요구가 나오면 여기를 바꾼다.
   */
  items.unshift(entry);
  setItems(items);
  pushGrid();
  console.log(`[pipe] 등록 — ${entry.name}`);
  return 'added';
}

/**
 * 현재 아이콘 추출 규칙의 버전.
 *
 * | 값 | 규칙 | 결과 |
 * |---|---|---|
 * | 0 | Electron `app.getFileIcon(target)` | Office·Orca 등 다수가 **기본 문서 아이콘** |
 * | 1 | Electron `app.getFileIcon(.lnk)` | **전부** 바로가기 기본 아이콘 — 더 나빴다 |
 * | 2 | .NET `ExtractAssociatedIcon(target)` | 대부분 정상. 단 **`.lnk` 지정 아이콘을 무시** |
 * | 3 | `ExtractIconEx(.lnk 의 icon, iconIndex)` + 환경변수 확장 | 탐색기와 같은 그림 |
 *
 * 2 의 한계: 바로가기가 자기 아이콘을 따로 지정한 경우를 못 살렸다. `SHELL32.dll` 을
 * 공유하고 인덱스로만 갈리는 항목들(절전모드·우분투시작 등)이 서로 같은 그림이 됐고,
 * `%SystemRoot%` 같은 환경변수가 든 경로는 아예 파일을 못 찾았다.
 *
 * 규칙을 또 바꾸면 이 값을 올린다. 그러면 다음 실행에서 아이콘만 자동으로 다시 뽑힌다.
 * 실측 근거는 `src/icon-extractor.ts` 머리말에 표로 있다.
 */
const ICON_REVISION = 3;

/**
 * 아이콘 추출 규칙이 바뀌었으면 **아이콘만** 다시 뽑는다.
 *
 * 재임포트가 아니다 — 사용자가 만든 배치·폴더·삭제 이력은 그대로 둔다.
 */
async function migrateIconsIfNeeded(): Promise<void> {
  const cfg = getConfig();

  // 폴더 안 항목까지 평평하게 모은다. 참조를 그대로 넘기므로 제자리에서 갱신된다.
  const all: AppEntry[] = [];
  for (const item of cfg.items) {
    if (item.kind === 'app') all.push(item);
    else all.push(...item.children);
  }

  /*
   * 규칙이 그대로여도 **아이콘이 비어 있는 항목은 다시 시도한다.**
   * 추출이 실패하는 경로가 있었고(단건 등록), 그렇게 생긴 빈 아이콘은 규칙 번호를 올리지 않는 한
   * 영영 채워지지 않는다. 재시도 비용은 그 항목 수만큼뿐이다.
   */
  const flat = cfg.iconRevision >= ICON_REVISION ? all.filter((e) => e.icon === null) : all;

  if (flat.length === 0) {
    updateConfig({ iconRevision: ICON_REVISION });
    return;
  }

  console.log(`[icon] 재추출 — 규칙 ${cfg.iconRevision} → ${ICON_REVISION} · 대상 ${flat.length}개`);
  const changed = await refreshIcons(flat);

  setItems(cfg.items);
  pushGrid();

  /*
   * ⚠️ **하나도 못 뽑았으면 규칙 번호를 올리지 않는다.**
   * PowerShell 실행 실패는 전부 "결과 없음" 으로 돌아오는데, 그때도 번호를 확정해 버리면
   * 다음 실행부터는 재시도 대상에서 빠져 **아이콘 없는 상태가 영구히 굳는다.**
   * (Codex 리뷰 2026-08-18 지적)
   */
  if (changed > 0) {
    updateConfig({ iconRevision: ICON_REVISION });
  } else {
    console.warn('[icon] 하나도 바뀌지 않았다 — 규칙 번호를 올리지 않고 다음 실행에 다시 시도한다');
  }

  console.log(`[icon] 재추출 완료 — ${changed}개 바뀜`);
}

/**
 * `Start Menu\Programs` 최초 임포트.
 *
 * DIRECTION.md 5.1 — 실시간 추종하지 않는다. **최초 1회만** 가져오고 그 뒤로는 자체 데이터로 관리한다.
 * 임포트 범위(필터 여부)는 결과를 보고 사용자가 정하기로 되어 있어 지금은 전부 가져온다.
 */
async function importIfNeeded(): Promise<void> {
  const cfg = getConfig();
  if (cfg.imported) {
    console.log(`[import] 이미 임포트됨 — 항목 ${cfg.items.length}개`);
    return;
  }

  console.log('[import] 최초 임포트 시작');
  const entries = await scanStartMenu();
  setItems(entries);
  updateConfig({ imported: true });
  console.log(`[import] 완료 — ${entries.length}개`);
}

// ─────────────────────────────────────────────────────────────
// 항목 컨텍스트 메뉴 동작
// ─────────────────────────────────────────────────────────────

/**
 * PowerShell 의 **작은따옴표 문자열**로 감싼다.
 *
 * 작은따옴표 안에서는 `$`·백틱·큰따옴표가 전부 리터럴이라 변수 확장도 부분식 실행도 없다.
 * 이스케이프가 필요한 문자는 작은따옴표 하나뿐이고, 두 번 겹쳐 쓰면 된다.
 * `C:\Program Files\...` 처럼 공백이 든 경로도 이 방식이면 따옴표를 손으로 조립할 필요가 없다.
 */
function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * 관리자 권한으로 실행.
 *
 * `shell.openPath` 로는 승격을 요청할 수 없다. ShellExecute 의 `runas` 동사가 필요하고,
 * 네이티브 모듈 없이 그것을 부르는 경로가 PowerShell 의 `Start-Process -Verb RunAs` 다.
 *
 * ⚠️ 대상은 `.lnk` 가 아니라 **`entry.target`(실제 실행 파일)** 이다.
 *    `.lnk` 를 RunAs 하면 승격되는 것은 셸이지 대상 프로그램이 아니다.
 *
 * ⚠️ 명령 문자열을 이어 붙여 만들지 않는다. 값은 전부 `psSingleQuote()` 로 감싸고,
 *    PowerShell 자체에는 `spawn` 의 **배열 인자**로 넘긴다 (`shell: true` 를 쓰지 않는다).
 *    그래야 경로·인자에 든 공백이 명령행 파싱 단계에서 쪼개지지 않는다.
 */
function runAsAdmin(entry: AppEntry): void {
  const parts = [
    `Start-Process -FilePath ${psSingleQuote(entry.target)} -Verb RunAs -ErrorAction Stop`,
  ];

  // `.lnk` 의 args 는 이미 완성된 명령행 문자열이다. 공백으로 쪼개면 원본이 가진 인용이 깨지므로
  // 통째로 하나의 `-ArgumentList` 로 넘겨 그대로 보존한다.
  if (entry.args !== '') {
    parts.push(`-ArgumentList ${psSingleQuote(entry.args)}`);
  }

  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', parts.join(' ')],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
  );

  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  child.on('error', (err) => {
    console.error(`[runas] PowerShell 을 띄우지 못했다 — ${entry.name}\n${err}`);
  });

  // 사용자가 UAC 를 취소하면 `-ErrorAction Stop` 때문에 종료 코드가 0 이 아니게 된다.
  // 정상 동작이지만 조용히 삼키지 않는다 — "눌렀는데 아무 일도 없다" 를 추적할 단서다.
  child.on('close', (code) => {
    if (code === 0) return;
    console.warn(
      `[runas] 실행되지 않았다 (exit ${code}, UAC 취소 가능성) — ${entry.name}\n${stderr.trim()}`,
    );
  });
}

/**
 * 메뉴에서 삭제.
 *
 * ⚠️ **원본 `.lnk` 파일은 건드리지 않는다.** 앱 데이터(`items`)에서만 뺀다.
 *    `.lnk` 읽기 전용은 이 프로젝트의 핵심 규칙이다 (`docs/DIRECTION.md` 5.1).
 *
 * 폴더 안 항목이면 그 폴더의 `children` 에서 뺀다.
 *
 * ⚠️ 인덱스는 **클릭 시점에 다시 구한다.** 메뉴가 떠 있는 동안 렌더러가 `GRID_SAVE` 로
 *    배열을 통째로 갈아끼울 수 있고, 그러면 메뉴를 만들 때의 인덱스는 엉뚱한 항목을 가리킨다.
 */
function removeEntry(id: string): void {
  const items = getConfig().items;
  const removed = spliceOut(items, id);
  if (!removed) {
    console.warn(`[item] 삭제할 항목이 이미 없다: ${id}`);
    return;
  }

  setItems(items);
  pushGrid();
  console.log(`[item] 메뉴에서 삭제 — ${removed.name}`);
}

/** `items` 에서 id 하나를 뺀다. 저장·재렌더는 하지 않는다. 뺐으면 그 항목을 돌려준다 */
function spliceOut(items: GridEntry[], id: string): GridEntry | null {
  const found = locateEntry(items, id);
  if (!found) return null;

  if (found.parent) {
    found.parent.children.splice(found.index, 1);
  } else {
    items.splice(found.index, 1);
  }
  return found.entry;
}

/**
 * 여러 개를 한 번에 삭제 (Ctrl+클릭 다중 선택. 사용자 지정 2026-09-02).
 *
 * ⚠️ 하나씩 **매번 다시 찾아** 뺀다. 앞 항목을 빼면 뒤 항목의 인덱스가 밀리므로
 *    미리 구해 둔 인덱스는 쓸 수 없다. 폴더 자체와 그 안의 자식이 함께 들어와도
 *    (폴더를 먼저 빼면 자식은 이미 없다 → 못 찾음 → 건너뜀) 이 방식이면 안전하다.
 *
 * 저장과 재렌더는 **마지막에 한 번**만 한다. 항목마다 하면 그 수만큼 디스크에 쓴다.
 */
function removeEntries(ids: string[]): void {
  const items = getConfig().items;
  const names: string[] = [];

  for (const id of ids) {
    const removed = spliceOut(items, id);
    if (removed) names.push(removed.name);
  }

  if (names.length === 0) {
    console.warn(`[item] 삭제할 항목이 하나도 없다 (${ids.length}개 요청)`);
    return;
  }

  setItems(items);
  pushGrid();
  console.log(`[item] 다중 삭제 — ${names.length}개 (${names.join(', ')})`);
}

/**
 * 폴더 해체 — 자식들을 **폴더가 있던 자리에** 순서 그대로 펼치고 폴더를 없앤다.
 *
 * `splice(index, 1, ...children)` 한 번으로 "폴더 제거 + 같은 자리에 자식 삽입" 이 동시에 끝난다.
 * 지우고 다시 넣는 두 단계로 나누면 그 사이에 인덱스가 밀려 순서가 어긋난다.
 * 자식 배열을 그대로 펼치므로 폴더 안의 순서도 보존된다.
 *
 * 위치를 클릭 시점에 다시 구하는 이유는 `removeEntry()` 와 같다.
 */
function dissolveFolder(id: string): void {
  const items = getConfig().items;
  const found = locateEntry(items, id);
  if (!found || found.entry.kind !== 'folder') {
    console.warn(`[item] 해체할 폴더가 이미 없다: ${id}`);
    return;
  }

  const folder = found.entry;
  // 폴더는 중첩되지 않으므로 항상 최상위다 → `found.index` 는 `items` 기준 인덱스다.
  items.splice(found.index, 1, ...folder.children);

  setItems(items);
  pushGrid();
  console.log(`[item] 폴더 해체 — ${folder.name} (자식 ${folder.children.length}개)`);
}

/**
 * 항목 종류에 맞는 메뉴 구성을 만든다. **순서는 사용자 지정이다. 임의로 바꾸거나 추가하지 마라.**
 *
 * `target` 이 빈 항목이 실제로 있다 — CLSID 기반 특수 바로가기(제어판 등)는 `.lnk` 에 실행 파일
 * 경로가 없다. 승격 실행도 파일 위치 열기도 대상이 없으니 **숨기지 않고 `enabled: false`** 로 둔다.
 * 항목이 통째로 사라지면 사용자는 "왜 나만 메뉴가 다르지" 를 알 수 없다.
 */
function itemMenuTemplate(entry: GridEntry): Electron.MenuItemConstructorOptions[] {
  const remove: Electron.MenuItemConstructorOptions = {
    label: t('item.remove'),
    click: () => removeEntry(entry.id),
  };

  if (entry.kind === 'folder') {
    return [
      { label: t('folder.dissolve'), click: () => dissolveFolder(entry.id) },
      { type: 'separator' },
      remove,
    ];
  }

  const hasTarget = entry.target !== '';

  return [
    {
      label: t('item.runAsAdmin'),
      enabled: hasTarget,
      click: () => {
        runAsAdmin(entry);
        // 실행했으면 패널을 닫는다 — 일반 실행(APP_LAUNCH)과 같은 거동.
        hidePanel();
      },
    },
    {
      label: t('item.openLocation'),
      enabled: hasTarget,
      click: () => {
        // 사용자 지정 — "바로가기 위치가 아닌, 실제 실행파일이 있는 디렉을 열어야함".
        // 그래서 `entry.lnkPath` 가 아니라 `entry.target` 이다.
        shell.showItemInFolder(entry.target);
        hidePanel();
      },
    },
    { type: 'separator' },
    remove,
  ];
}

/**
 * 다중 선택 메뉴 — **삭제 하나뿐이다.**
 *
 * 관리자 실행·파일 위치 열기는 항목 하나에 대한 동작이라 여러 개에는 뜻이 없다.
 * 폴더 해체도 마찬가지다. 탐색기가 여러 개를 골랐을 때 항목별 동작을 감추는 것과 같다.
 */
function multiMenuTemplate(ids: string[]): Electron.MenuItemConstructorOptions[] {
  return [
    {
      label: t('item.removeSelected', { count: ids.length }),
      click: () => removeEntries(ids),
    },
  ];
}

// ─────────────────────────────────────────────────────────────
// IPC
// ─────────────────────────────────────────────────────────────

function registerIpc(): void {
  ipcMain.handle(CH.GRID_GET, () => buildPayload());

  ipcMain.handle(CH.GRID_SAVE, (_e, items: GridEntry[]) => {
    setItems(items);
  });

  /**
   * 탐색기에서 끌어다 놓은 파일을 등록한다. 새로 넣은 개수를 돌려준다.
   *
   * ⚠️ 토글이 **아니라 추가**다. 셸 확장의 TOGGLE 은 있으면 빼지만, 끌어다 놓기는 언제나 넣기다.
   *    이미 있는 항목을 다시 떨궜다고 지워지면 사용자는 사라진 이유를 알 수 없다.
   *
   * ⚠️ 받는 것은 `.lnk` 뿐이다. 항목(`AppEntry`)이 원본 바로가기 경로를 반드시 갖는 구조이고,
   *    셸 확장이 다루는 대상도 `.lnk` 하나다. 두 등록 경로의 규칙을 같게 둔다.
   *    `.exe` 나 폴더까지 받을지는 **사용자 결정 사항**이라 여기서 정하지 않는다.
   *
   * ⚠️ 원본 `.lnk` 는 **읽기만 한다.** 이동·삭제·수정하지 않는다.
   */
  ipcMain.handle(CH.GRID_ADD_FILES, async (_e, paths: string[]) => {
    if (!Array.isArray(paths)) return 0;

    const items = getConfig().items;
    const added: AppEntry[] = [];

    for (const raw of paths) {
      if (typeof raw !== 'string') continue;

      const lnkPath = raw.trim();
      if (lnkPath === '') continue;

      if (!lnkPath.toLowerCase().endsWith('.lnk')) {
        console.log(`[drop] .lnk 가 아니라 건너뜀 — ${lnkPath}`);
        continue;
      }

      // Windows 경로는 대소문자를 구분하지 않는다. 비교는 항상 소문자로 맞춘다.
      const key = lnkPath.toLowerCase();

      if (locateByLnkPath(items, lnkPath)) {
        console.log(`[drop] 이미 등록됨 — ${lnkPath}`);
        continue;
      }
      // 한 번의 드롭 안에서의 중복도 막는다 (같은 파일이 두 번 넘어오는 경우)
      if (added.some((e) => e.lnkPath.toLowerCase() === key)) continue;

      const entry = await readShortcutEntry(lnkPath);
      if (!entry) {
        console.warn(`[drop] .lnk 를 읽지 못했다 — ${lnkPath}`);
        continue;
      }

      /*
       * ⚠️ 위 `readShortcutEntry()` 는 **await 다** (아이콘 추출에 PowerShell 을 띄운다).
       *    그 사이 셸 확장이나 또 다른 드롭이 같은 파일을 넣었을 수 있어 넣기 직전에 다시 본다.
       *    (같은 이유로 `toggleByLnkPath()` 도 재확인한다)
       */
      if (locateByLnkPath(items, lnkPath)) continue;

      added.push(entry);
    }

    if (added.length === 0) return 0;

    /*
     * 새 항목은 **맨 뒤**에 붙인다 (사용자 지정 2026-09-02).
     *
     * 처음에는 맨 앞에 넣었다 — 항목이 많으면 뒤에 붙인 것이 화면 밖이라 "등록이 안 된다" 는
     * 오해를 부른다는 이유였다(셸 확장 등록 `toggleByLnkPath` 가 지금도 그 규칙이다).
     * 그러나 앞에 넣으면 **기존 배치가 통째로 한 칸씩 밀린다.** 끌어다 놓기는 사용자가 스스로
     * 놓는 동작이라 등록된 사실을 이미 알고 있으므로, 밀리지 않는 쪽이 낫다는 것이 사용자 판단이다.
     *
     * ⚠️ 감수한 것 — 항목이 많으면 새로 넣은 것을 보려면 스크롤해야 한다.
     *    등록 후 그 자리로 자동 스크롤할지는 정해진 바 없어 손대지 않았다.
     *
     * 여러 개를 한 번에 떨궜을 때 **떨어뜨린 순서가 유지되도록** 모아서 한 번에 붙인다.
     */
    items.push(...added);
    setItems(items);
    pushGrid();

    console.log(`[drop] 등록 — ${added.length}개 (${added.map((e) => e.name).join(', ')})`);
    return added.length;
  });

  ipcMain.handle(CH.APP_LAUNCH, async (_e, id: string) => {
    const found = locateEntry(getConfig().items, id);
    if (!found || found.entry.kind !== 'app') {
      console.warn(`[launch] 실행할 앱 항목을 찾지 못했다: ${id}`);
      return;
    }
    const entry = found.entry;

    // 원본 .lnk 를 그대로 연다. Windows 가 target/args/작업폴더를 알아서 처리하므로
    // 우리가 인자를 재조립하다 틀릴 여지가 없다.
    // ⚠️ .lnk 는 읽기 전용이다. 여는 것 외의 조작을 하지 않는다.
    const err = await shell.openPath(entry.lnkPath);
    if (err) console.error(`[launch] 실패: ${entry.lnkPath}\n${err}`);

    // 시작 메뉴와 동일하게, 실행하면 패널이 닫힌다.
    hidePanel();
  });

  // 그리드 항목 우클릭 → 네이티브 컨텍스트 메뉴.
  // 메뉴를 띄울 창은 패널이다. 결과로 데이터가 바뀌면 각 동작이 저장·브로드캐스트까지 마친다.
  ipcMain.handle(CH.ITEM_MENU, (_e, ids: string | string[]) => {
    const win = getPanel();
    if (!win) return;

    // 여러 개(Ctrl+클릭 다중 선택)면 다중 삭제 메뉴. 하나면 기존 항목 메뉴.
    let template: Electron.MenuItemConstructorOptions[];
    if (Array.isArray(ids) && ids.length >= 2) {
      template = multiMenuTemplate(ids);
    } else {
      const id = Array.isArray(ids) ? (ids[0] ?? '') : ids;
      const found = locateEntry(getConfig().items, id);
      if (!found) {
        console.warn(`[itemMenu] 항목을 찾지 못했다: ${id}`);
        return;
      }
      template = itemMenuTemplate(found.entry);
    }

    // ⚠️ 팝업이 뜨는 순간 패널이 blur 를 받는다. 막지 않으면 패널이 숨으면서 메뉴까지 닫혀
    //    우클릭이 통째로 동작하지 않는다. blur 닫기는 이제 개발 모드에서도 켜져 있으므로
    //    이 증상은 `npm start` 에서도 그대로 재현된다.
    suspendBlurClose();
    Menu.buildFromTemplate(template).popup({
      window: win,
      callback: () => resumeBlurClose(),
    });
  });

  ipcMain.handle(CH.PANEL_CLOSE, () => hidePanel());

  // ── 단축키 설정 창 ──────────────────────────────────────
  ipcMain.handle(CH.HOTKEY_GET, () => getConfig().hotkey);

  ipcMain.handle(CH.HOTKEY_SET, (_e, combo: string) => {
    applyHotkey(combo);
    closeHotkeyDialog();
  });

  ipcMain.handle(CH.HOTKEY_CLOSE, () => closeHotkeyDialog());

  // 플로팅 아이콘 클릭 → 패널 토글 (트레이 좌클릭과 동일 동작)
  ipcMain.handle(CH.FLOATING_TOGGLE, () => togglePanel());

  ipcMain.handle(CH.FLOATING_MOVE, (_e, dx: number, dy: number) => moveFloatingBy(dx, dy));

  ipcMain.handle(CH.FLOATING_MOVE_END, () => persistFloatingPosition());

  /**
   * 플로팅 우클릭 메뉴 — **트레이와 똑같은 메뉴**를 띄운다 (사용자 지정 2026-08-18).
   *
   * 템플릿은 `menus.ts` 한 곳에서만 만든다. 여기서 따로 조립하면 메뉴를 고칠 때 두 군데를
   * 고쳐야 하고 반드시 어긋난다. 핸들러도 트레이와 **같은 객체**(`appMenuHandlers`)를 쓴다.
   *
   * ⚠️ `Menu` 인스턴스는 공유하지 않는다. 템플릿(순수 데이터)만 공유하고
   *    `Menu.buildFromTemplate()` 은 트레이와 별개로 여기서 부른다.
   *
   * ⚠️ 여기서는 `suspendBlurClose()` 를 **쓰지 않는다.** `CH.ITEM_MENU` 와 사정이 다르다.
   *    ITEM_MENU 는 메뉴의 주인 창이 **패널**이라, blur 로 패널이 숨으면 메뉴까지 함께 사라져
   *    우클릭이 아예 동작하지 않는다. 반면 이 메뉴의 주인은 **플로팅 창**이고 플로팅에는
   *    blur 핸들러가 없어(`windows/floating.ts`) 숨지 않는다 — 메뉴는 그대로 살아 있다.
   *    이때 패널이 닫히는 것은 "패널 밖을 클릭했다"는 뜻이라 의도된 거동이며,
   *    트레이 아이콘을 우클릭했을 때와도 같다.
   *    억지로 막으면 오히려 **포커스를 잃은 채 열려 있는 패널**이 남는다.
   *    blur 를 이미 흘려보냈으니 다음 blur 가 오지 않아 스스로 닫히지 못한다.
   *
   *    "구성변경" 을 골라도 마찬가지다. `applyGrid()` → `resizePanel()` 은 숨은 패널에
   *    `setBounds` 를 거는 것뿐이고, 위치·크기는 `showPanel()` 이 열 때마다 다시 계산한다.
   */
  ipcMain.handle(CH.FLOATING_MENU, () => {
    const win = getFloating();
    if (!win) return;

    Menu.buildFromTemplate(buildAppMenuTemplate(appMenuHandlers)).popup({ window: win });
  });
}

// ─────────────────────────────────────────────────────────────
// 공유 메뉴 핸들러 — 트레이 · 플로팅 우클릭
// ─────────────────────────────────────────────────────────────

async function applyLocale(locale: Locale): Promise<void> {
  await changeLocale(locale);
  updateConfig({ locale });

  // 트레이 라벨은 자동으로 안 바뀐다. 메뉴를 다시 만들어야 한다.
  rebuildTrayMenu();
  broadcast(EV.LOCALE_CHANGE, locale);
  pushGrid();

  console.log(`[i18n] 언어 변경 → ${locale}`);
}

function applyGrid(cols: number, rows: number): void {
  updateConfig({ cols, rows });
  resizePanel(cols, rows);
  rebuildTrayMenu();
  pushGrid();
  console.log(`[grid] 구성 변경 → ${cols} x ${rows}`);
}

/**
 * 단축키 조합을 바꾸고 훅을 다시 건다.
 *
 * 훅 프로세스는 인자로 조합을 받으므로 **바꾸려면 다시 띄우는 수밖에 없다.**
 * 자주 있는 일이 아니라 비용은 문제되지 않는다.
 */
function applyHotkey(combo: string): void {
  updateConfig({ hotkey: combo });
  startHotkey(combo);
  console.log(`[hotkey] 변경 → ${combo}`);
}

function quitApp(): void {
  isQuitting = true;
  destroyTray();
  // 파이프가 사라지면 셸 확장이 메뉴 항목을 숨긴다 — "앱이 켜져 있을 때만" 이 그대로 성립한다.
  stopPipeServer();
  // 훅 프로세스도 함께 내린다. 남겨두면 키보드 훅이 떠돈다.
  stopHotkey();
  app.quit();
}

/**
 * 트레이 메뉴와 플로팅 우클릭 메뉴가 **함께 쓰는** 핸들러.
 *
 * 두 메뉴는 구성이 같으므로(DIRECTION.md 3.8) 동작도 하나여야 한다.
 * 각자 들고 있으면 한쪽만 고치는 실수가 반드시 나온다.
 *
 * `onTrayClick` 은 `TrayHandlers` 에만 있는 항목이다. `buildAppMenuTemplate()` 이 받는
 * `AppMenuHandlers` 에는 없지만, **변수**로 넘기면 초과 프로퍼티 검사가 걸리지 않으므로
 * 이 객체 하나를 양쪽에 그대로 넘긴다.
 *
 * ⚠️ 상태를 바꾸는 항목은 `rebuildTrayMenu()` 까지 불러야 한다. 안 부르면 플로팅 메뉴로
 *    바꾼 값이 트레이 메뉴의 라벨·radio 체크에 반영되지 않는다.
 *    `applyLocale()` · `applyGrid()` 는 함수 안에서 이미 부르고 있고, 플로팅 토글만
 *    여기서 이어 부른다.
 *
 * 위쪽 `registerIpc()` 가 이 상수를 참조하지만 TDZ 문제는 없다 —
 * 그 함수가 실제로 도는 시점은 모듈 평가가 끝난 뒤인 `ready` 이후다.
 */
const appMenuHandlers: TrayHandlers = {
  onToggleFloating: () => {
    toggleFloating();
    rebuildTrayMenu();
  },
  onLocaleChange: (locale) => void applyLocale(locale),
  onGridChange: applyGrid,
  onHotkeySetting: openHotkeyDialog,
  onQuit: quitApp,
  onTrayClick: () => togglePanel(),
  isFloatingVisible,
};

// ─────────────────────────────────────────────────────────────
// 기동
// ─────────────────────────────────────────────────────────────

app.on('ready', async () => {
  // app.getLocale() 은 ready 이후에야 정확한 값을 준다.
  const osLocale = app.getLocale();
  const osResolved = resolveLocale(osLocale);

  // 저장된 언어가 있으면 그것이 OS 자동 감지보다 우선한다 (DIRECTION.md 3.6).
  const cfg = loadConfig(osResolved);
  await initI18n(cfg.locale);
  console.log(`[i18n] OS=${osLocale} → 적용=${cfg.locale}`);

  registerIpc();

  // 트레이를 먼저 띄운다. 창이 없어도 앱이 살아 있다는 것을 보장하는 유일한 접점이다.
  // 핸들러는 플로팅 우클릭 메뉴와 공유한다 (`appMenuHandlers`).
  createTray(appMenuHandlers);

  createPanel();
  createFloating();

  /*
   * 토글 버튼 영역을 패널에 알려 준다.
   *
   * 이 두 곳을 누른 blur 는 "패널 밖을 클릭한 것" 이 아니다. 실측 로그로 확인한 순서는
   *   blur → hidePanel()  →  click → togglePanel()
   * 이라, 그냥 두면 패널이 먼저 닫히고 토글이 곧바로 다시 열어 **아무리 눌러도 안 닫힌다**
   * (그 닫힘→열림이 화면에는 깜빡임으로 보인다).
   *
   * 등록을 여기서 하는 이유는 순환 import 를 피하기 위해서다.
   * `panel.ts` 가 `tray.ts` / `floating.ts` 를 직접 알면 서로를 물게 된다.
   */
  addBlurIgnoreRegion(() => getFloating()?.getBounds() ?? null);
  addBlurIgnoreRegion(getTrayBounds);

  /*
   * 탐색기 셸 확장이 물어볼 통로를 연다.
   *
   * 파이프가 살아 있다는 것 자체가 "앱이 켜져 있다" 는 신호다 — 셸 확장은 파이프에 붙지
   * 못하면 메뉴 항목을 아예 숨긴다 (사용자 지정: "앱이 켜져 있을 때만").
   * 프로세스가 죽으면 파이프도 사라지므로 별도 정리가 필요 없다.
   */
  startPipeServer({
    isRegistered: (lnkPath) => locateByLnkPath(getConfig().items, lnkPath) !== null,
    toggle: toggleByLnkPath,
    hotkey: (action) => {
      if (action === 'TOGGLE') {
        console.log('[hotkey] 단축키 감지 → 패널 토글');
        togglePanel();
      }
    },
    // 마우스 왼쪽 버튼 상태. 패널의 "드래그 중 blur 보류" 판정에 쓰인다.
    mouse: (down) => setMouseButtonDown(down),
  });

  // 전역 단축키 감시 프로세스. 앱이 살아 있는 동안만 돈다.
  startHotkey(cfg.hotkey);

  // 지난 세션에 켜 둔 상태면 복원한다 — 플로팅 상태도 영구 저장 대상이다.
  if (cfg.floating.visible) showFloating();

  await importIfNeeded();
  pushGrid();

  // 임포트 뒤에 돈다. 최초 실행이면 이미 새 규칙으로 뽑혀 있어 바뀌는 게 없다.
  await migrateIconsIfNeeded();
});

/**
 * 트레이 상주 앱이므로 창이 닫혀도 종료하지 않는다.
 *
 * ⚠️ 여기서 app.quit() 을 부르면 트레이 상주가 깨진다. **의도적으로 비어 있다.**
 * 종료 경로는 트레이 메뉴와 플로팅 컨텍스트 메뉴뿐이다.
 */
app.on('window-all-closed', () => {
  // 비워 둔다.
});

app.on('before-quit', () => {
  isQuitting = true;
});

// 패널·플로팅은 hide 로 살려 두므로 이 핸들러는 사실상 안 타지만,
// 외부에서 창이 파괴됐을 때 앱이 끌려 죽지 않도록 방어한다.
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && !isQuitting) {
    createPanel();
    createFloating();
  }
});
