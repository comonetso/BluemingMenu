/**
 * 그리드 DOM 렌더러 — **렌더러 프로세스 전용**.
 *
 * 역할은 "그리는 것" 하나다. 드래그&드롭은 `src/ui/dnd.ts` 가 맡는다.
 * 여기서는 드래그 관련 리스너를 일절 달지 않는다.
 *
 * ⚠️ 이 파일에서 `electron` 을 import 하지 마라. 메인과의 통신은 `window.bm` 만 쓴다.
 * ⚠️ 클래스 이름(`bm-*`)은 CSS·DnD 담당이 그대로 의존한다. 바꾸면 스타일과 드래그가 깨진다.
 *
 * ## DnD 와의 DOM 계약 (dnd.ts 가 읽는 것)
 *
 * 메인 그리드 셀과 폴더 오버레이 안의 셀은 **같은 `.bm-cell` 클래스**를 쓴다.
 * 클래스만으로는 구분되지 않으므로 소속을 data 속성으로 명시한다.
 *
 * | 속성 | 어디에 | 뜻 |
 * |---|---|---|
 * | `data-scope="grid"`   | 그리드 컨테이너 · 셀 | 메인 그리드. `data-index` 는 **`items`** 인덱스 |
 * | `data-scope="folder"` | 그리드 컨테이너 · 셀 | 폴더 오버레이. `data-index` 는 **`children`** 인덱스 |
 * | `data-parent="<폴더id>"` | 폴더 안의 셀에만 | 이 셀이 들어 있는 폴더의 id |
 * | `data-folder="<폴더id>"` | `.bm-folder-grid` 컨테이너에만 | 어느 폴더의 그리드인가 |
 * | `data-id` / `data-kind` | 항목 셀 | 항목 id · `'app'`\|`'folder'` |
 * | `data-index` | 항목 셀 · 빈 칸 | 소속 배열 안에서의 위치 (`data-scope` 가 어느 배열인지 정한다) |
 *
 * 빈 칸(`.bm-cell-empty`)에도 `data-scope` / `data-parent` 가 붙는다.
 * 폴더 안의 빈 칸은 "그 폴더 children 의 끝"이고, 메인 그리드의 빈 칸은 "items 의 끝"이다.
 * **`data-scope` 를 보지 않고 `data-index` 만 읽으면 두 배열이 뒤섞인다.**
 */

import { CELL_WIDTH, CELL_HEIGHT, ICON_SIZE, PANEL_PADDING } from '../config';
import { t } from '../i18n';
import type { AppEntry, FolderEntry, GridEntry, GridPayload } from '../types';
// 타입만 가져온다 — `import type` 은 빌드에서 완전히 지워지므로 preload 의 electron 이 딸려오지 않는다.
import type { BluemingApi } from '../preload';

/** 렌더가 끝났음을 알리는 이벤트. DnD 담당이 이걸 듣고 리스너를 다시 건다 */
const RENDERED_EVENT = 'bm:grid:rendered';

/** 폴더 미리보기에 넣는 미니 아이콘 최대 개수 — Windows 11 시작 메뉴 폴더가 4개(2x2)다 */
const FOLDER_PREVIEW_MAX = 4;

/**
 * 셀이 속한 컬렉션. `data-index` 가 **어느 배열의 인덱스인지**를 가르는 표식이다.
 * 자세한 계약은 파일 첫머리 표 참조.
 */
type CellScope = { kind: 'grid' } | { kind: 'folder'; folderId: string };

/** 메인 그리드용 스코프. 폴더 id 를 갖지 않으므로 하나를 재사용한다 */
const GRID_SCOPE: CellScope = { kind: 'grid' };

/* ------------------------------------------------------------------ 상태 */

/** 마지막으로 렌더한 항목 배열. DnD 가 `getCurrentItems()` 로 이 **참조**를 읽는다 */
let currentItems: GridEntry[] = [];
let currentCols = 0;
let currentRows = 0;

/** `renderGrid` 가 받은 루트 */
let rootEl: HTMLElement | null = null;

/** 열려 있는 폴더 오버레이. 닫혀 있으면 null */
let overlayEl: HTMLElement | null = null;
let openFolderId: string | null = null;

/** 전역 리스너를 한 번만 걸기 위한 플래그 */
let globalListenersBound = false;

/* ------------------------------------------------------------------ 선택 */

/** 선택 표시 클래스. index.css 와의 계약이다 */
const SELECTED_CLASS = 'bm-selected';

/**
 * Ctrl+클릭으로 골라 둔 항목 id 들 (사용자 지정 2026-09-02).
 *
 * 메인 그리드와 폴더 안 항목이 섞이지 않는다 — 폴더를 열고 닫을 때 선택을 풀기 때문이다.
 * 삭제는 id 로 하므로(`main.ts` `removeEntries`) 어느 배열의 것이든 처리에는 차이가 없다.
 *
 * 다시 그리면(`renderGrid`) DOM 이 통째로 새로 만들어지므로 그때도 비운다.
 * 선택을 재렌더 너머로 살리려면 렌더 뒤에 클래스를 다시 붙여야 하는데, 지금 그 요구는 없다.
 */
const selected = new Set<string>();

/* ------------------------------------------------------------------ 유틸 */

/**
 * preload 가 노출한 API. 모듈 로드 시점에 캐시하지 않고 매번 읽는다
 * (contextBridge 주입 시점과 모듈 평가 순서를 가정하지 않기 위함).
 */
function bm(): BluemingApi {
  return (window as unknown as { bm: BluemingApi }).bm;
}

function emitRendered(): void {
  window.dispatchEvent(new CustomEvent(RENDERED_EVENT));
}

/**
 * 화면에 보일 이름.
 * 폴더 이름이 비어 있으면 리소스의 기본 폴더명을 쓴다 (데이터에는 쓰지 않는다).
 */
function displayName(entry: GridEntry): string {
  const name = entry.name.trim();
  if (name) return name;
  // 앱 이름이 비는 경우는 데이터 이상이다. 임의 문구를 지어내지 않고 빈 문자열로 둔다.
  return entry.kind === 'folder' ? t('folder.defaultName') : '';
}

/**
 * 아이콘 `<img>`.
 * 아이콘이 없으면 `src` 를 아예 넣지 않고 `missingClass` 만 붙인다 — 표시는 CSS 몫이다.
 * (`src=""` 는 페이지 URL 을 다시 로드하므로 넣지 않는다.)
 */
function createIconImg(icon: string | null, baseClass: string, missingClass: string): HTMLImageElement {
  const img = document.createElement('img');
  img.className = baseClass;
  img.alt = '';
  if (icon) {
    img.src = icon;
  } else {
    img.classList.add(missingClass);
  }
  return img;
}

function createLabel(text: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'bm-label';
  span.textContent = text;
  return span;
}

/** 셀·그리드 컨테이너에 소속 표식을 붙인다 (파일 첫머리 DOM 계약 표) */
function markScope(el: HTMLElement, scope: CellScope): void {
  el.dataset.scope = scope.kind;
  if (scope.kind === 'folder') el.dataset.parent = scope.folderId;
}

/**
 * 우클릭 → 네이티브 컨텍스트 메뉴.
 *
 * 메뉴 구성(앱: 관리자 실행/파일 위치/삭제, 폴더: 해체/삭제)과 실제 동작은 **메인**이 한다
 * (`CH.ITEM_MENU`). 선택 결과로 데이터가 바뀌면 메인이 `EV.GRID_UPDATE` 를 쏘고 renderer.ts
 * 가 다시 그리므로, 여기서 응답을 기다려 할 일은 없다.
 */
function bindContextMenu(el: HTMLElement, id: string): void {
  el.addEventListener('contextmenu', (e) => {
    // 브라우저 기본 메뉴를 막는다. 네이티브 메뉴는 메인이 띄운다.
    e.preventDefault();

    /*
     * 선택된 항목 위에서의 우클릭 → 선택 **전체**를 넘긴다 (다중 삭제 메뉴).
     * 선택 밖의 항목 위에서의 우클릭 → 탐색기처럼 선택을 풀고 그 항목만 다룬다.
     * 선택이 하나뿐이면 단일 메뉴가 더 쓸모 있으므로(관리자 실행·파일 위치) 그쪽으로 보낸다.
     */
    if (selected.has(id) && selected.size >= 2) {
      void bm().itemMenu(Array.from(selected));
      return;
    }
    clearSelection();
    void bm().itemMenu(id);
  });
}

/** 선택을 켜거나 끈다. 클래스와 Set 을 함께 맞춘다 */
function toggleSelect(cell: HTMLElement, id: string): void {
  if (selected.has(id)) {
    selected.delete(id);
    cell.classList.remove(SELECTED_CLASS);
  } else {
    selected.add(id);
    cell.classList.add(SELECTED_CLASS);
  }
}

/**
 * 선택을 전부 푼다. 패널이 닫힐 때(renderer.ts)·폴더를 열고 닫을 때·Esc 에서 불린다.
 * 선택이 없으면 DOM 을 뒤지지 않고 바로 돌아온다.
 */
export function clearSelection(): void {
  if (selected.size === 0) return;
  selected.clear();
  rootEl
    ?.querySelectorAll(`.${SELECTED_CLASS}`)
    .forEach((el) => el.classList.remove(SELECTED_CLASS));
}

/** 셀 공통 뼈대 */
function createCellButton(entry: GridEntry, index: number, scope: CellScope): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'bm-cell';
  btn.dataset.id = entry.id;
  btn.dataset.kind = entry.kind;
  btn.dataset.index = String(index);
  markScope(btn, scope);
  // 라벨이 잘려도 전체 이름을 볼 수 있게. 항목 이름 그대로라 번역 대상이 아니다.
  btn.title = displayName(entry);
  // 메인 그리드든 폴더 안이든 항목 셀이면 전부 걸린다 (폴더 안 항목도 삭제·파일 위치가 되어야 한다).
  bindContextMenu(btn, entry.id);
  return btn;
}

function createAppCell(entry: AppEntry, index: number, scope: CellScope): HTMLButtonElement {
  const btn = createCellButton(entry, index, scope);
  btn.append(
    createIconImg(entry.icon, 'bm-icon', 'bm-icon-missing'),
    createLabel(displayName(entry)),
  );
  // 실행 후 패널을 닫는 것은 메인이 한다.
  btn.addEventListener('click', (e) => {
    // Ctrl+클릭은 실행이 아니라 **선택 토글**이다 (사용자 지정 2026-09-02).
    if (e.ctrlKey) {
      toggleSelect(btn, entry.id);
      return;
    }
    clearSelection();
    void bm().launch(entry.id);
  });
  return btn;
}

function createFolderCell(entry: FolderEntry, index: number, scope: CellScope): HTMLButtonElement {
  const btn = createCellButton(entry, index, scope);

  const preview = document.createElement('span');
  preview.className = 'bm-folder-preview';
  for (const child of entry.children.slice(0, FOLDER_PREVIEW_MAX)) {
    preview.appendChild(createIconImg(child.icon, 'bm-mini', 'bm-mini-missing'));
  }

  btn.append(preview, createLabel(displayName(entry)));
  btn.addEventListener('click', (e) => {
    // 폴더도 Ctrl+클릭이면 열지 않고 선택한다 — 폴더째 삭제 대상이 될 수 있다.
    if (e.ctrlKey) {
      toggleSelect(btn, entry.id);
      return;
    }
    clearSelection();
    openFolder(entry.id);
  });
  return btn;
}

/**
 * 빈 칸. 그리드 모양을 유지하고 드롭 대상이 된다.
 * 항목이 아니므로 `data-id` 는 없고 컨텍스트 메뉴도 걸지 않는다.
 * 소속은 붙인다 — 폴더 안의 빈 칸과 메인 그리드의 빈 칸은 뜻하는 배열이 다르다.
 */
function createEmptyCell(index: number, scope: CellScope): HTMLDivElement {
  const cell = document.createElement('div');
  cell.className = 'bm-cell bm-cell-empty';
  cell.dataset.index = String(index);
  markScope(cell, scope);
  return cell;
}

function createCell(entry: GridEntry, index: number, scope: CellScope): HTMLElement {
  return entry.kind === 'folder'
    ? createFolderCell(entry, index, scope)
    : createAppCell(entry, index, scope);
}

/**
 * 실제로 그릴 행 수.
 * 최소 `rows` 는 유지하고, 항목이 넘치면 마지막 줄이 잘리지 않도록 행 단위로 늘린다.
 * (넘칠 때의 처리 방식 — 페이지네이션 여부 — 은 미결정이라 여기서 정하지 않는다.
 *  늘어난 만큼 그리드가 패널보다 길어지고 세로 스크롤이 생긴다.)
 */
function rowCount(itemCount: number, cols: number, rows: number): number {
  return Math.max(rows, Math.ceil(itemCount / cols));
}

/**
 * `.bm-grid` 한 판을 만든다.
 * `--cols` / `--rows` 는 인라인 스타일로 준다. 칸 수는 항상 `cols * 실제행수` 로 꽉 채운다.
 *
 * 폴더용으로 만들 때는 `.bm-folder-grid` 클래스와 `data-folder` 가 함께 붙는다 —
 * 소속 표식이 한 곳에서만 정해지도록 여기로 모았다.
 */
function buildGrid(
  items: GridEntry[],
  cols: number,
  rows: number,
  scope: CellScope,
): HTMLElement {
  const grid = document.createElement('div');
  grid.className = 'bm-grid';
  markScope(grid, scope);
  if (scope.kind === 'folder') {
    grid.classList.add('bm-folder-grid');
    // 어느 폴더의 그리드인지 (컨테이너 쪽 기존 계약 이름 — 유지한다)
    grid.dataset.folder = scope.folderId;
  }

  const actualRows = rowCount(items.length, cols, rows);
  grid.style.setProperty('--cols', String(cols));
  grid.style.setProperty('--rows', String(actualRows));

  const total = cols * actualRows;
  for (let i = 0; i < total; i += 1) {
    const entry = items[i];
    grid.appendChild(entry ? createCell(entry, i, scope) : createEmptyCell(i, scope));
  }
  return grid;
}

/* ------------------------------------------------------------------ 렌더 */

/**
 * 그리드 전체를 다시 그린다.
 * 열려 있던 폴더는 DOM 이 통째로 새로 만들어지므로 닫힌다.
 */
export function renderGrid(root: HTMLElement, payload: GridPayload): void {
  rootEl = root;
  currentItems = payload.items;
  currentCols = Math.max(1, payload.cols);
  currentRows = Math.max(1, payload.rows);

  removeOverlay();
  // DOM 이 통째로 새로 만들어진다. 옛 DOM 의 클래스는 지울 필요가 없고 Set 만 비운다.
  selected.clear();

  // 셀 치수는 CSS 변수로 넘긴다 (config.ts 실측값이 단일 진실원이다)
  root.style.setProperty('--cell-w', `${CELL_WIDTH}px`);
  root.style.setProperty('--cell-h', `${CELL_HEIGHT}px`);
  root.style.setProperty('--icon', `${ICON_SIZE}px`);
  root.style.setProperty('--pad', `${PANEL_PADDING}px`);

  root.replaceChildren();

  const panel = document.createElement('div');
  panel.className = 'bm-panel';
  panel.appendChild(buildGrid(currentItems, currentCols, currentRows, GRID_SCOPE));

  // 안내 문구는 `.bm-grid` **다음**에 오는 `.bm-panel` 의 자식이다 — index.css 4장이 그 전제로
  // 절대 배치(`inset: var(--pad)`)를 걸어 두었다. 패널이 스크롤 컨테이너가 돼도 이 문구가 뜨는
  // 경우(항목 0개)에는 그리드가 rows 만큼만 차지해 넘칠 내용이 없으므로 어긋나지 않는다.
  if (currentItems.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'bm-empty';
    empty.textContent = t('grid.empty');
    panel.appendChild(empty);
  }

  root.appendChild(panel);

  bindGlobalListeners();
  emitRendered();
}

/** DnD 가 읽는다. 복사본이 아니라 마지막으로 렌더한 배열 **참조** 그대로다 */
export function getCurrentItems(): GridEntry[] {
  return currentItems;
}

/* ------------------------------------------------------------------ 폴더 */

/** 메인 그리드의 폴더 라벨을 전체 재렌더 없이 갱신한다 */
function syncFolderLabel(folder: FolderEntry): void {
  const cells = rootEl?.querySelectorAll<HTMLElement>('.bm-panel .bm-cell');
  if (!cells) return;
  for (const cell of Array.from(cells)) {
    if (cell.dataset.id !== folder.id) continue;
    cell.title = displayName(folder);
    const label = cell.querySelector('.bm-label');
    if (label) label.textContent = displayName(folder);
    return;
  }
}

/** 폴더 이름 입력칸. `change` · `blur` 에서 반영하고 저장한다 */
function createFolderNameInput(folder: FolderEntry): HTMLInputElement {
  const input = document.createElement('input');
  input.className = 'bm-folder-name';
  // 값은 저장된 원본 그대로 둔다. 비어 있으면 기본 폴더명을 placeholder 로만 보여준다
  // (번역된 문자열이 데이터에 저장되면 언어를 바꿨을 때 남는다).
  input.value = folder.name;
  input.placeholder = t('folder.defaultName');

  const commit = () => {
    const next = input.value.trim();
    if (next === folder.name) return;
    folder.name = next;
    syncFolderLabel(folder);
    void bm().grid.save(currentItems);
  };

  input.addEventListener('change', commit);
  input.addEventListener('blur', commit);
  return input;
}

/**
 * 폴더를 연다. 오버레이는 `.bm-panel` 의 형제로 루트에 붙는다.
 *
 * 폴더 그리드의 열 수는 새 값을 지어내지 않고 기존 값에서 끌어온다 —
 * 메인 그리드 열 수를 넘지 않으면서 자식 수만큼만 쓴다.
 */
export function openFolder(id: string): void {
  if (!rootEl) return;
  if (openFolderId === id) return;

  const folder = currentItems.find(
    (it): it is FolderEntry => it.kind === 'folder' && it.id === id,
  );
  if (!folder) return;

  removeOverlay();
  // 폴더를 열면 메인 그리드의 선택은 뜻을 잃는다 — 폴더 안팎이 섞인 선택을 만들지 않는다.
  clearSelection();

  const overlay = document.createElement('div');
  overlay.className = 'bm-folder-overlay';

  const panel = document.createElement('div');
  panel.className = 'bm-folder-panel';

  const cols = Math.max(1, Math.min(currentCols, folder.children.length));
  const rows = Math.max(1, Math.ceil(folder.children.length / cols));

  // 폴더 스코프로 만든다 — 셀의 `data-index` 가 `items` 가 아니라 `folder.children` 인덱스가 되고,
  // 셀마다 `data-scope="folder"` · `data-parent=<폴더id>` 가 붙는다 (파일 첫머리 DOM 계약).
  const grid = buildGrid(folder.children, cols, rows, { kind: 'folder', folderId: folder.id });

  panel.append(createFolderNameInput(folder), grid);
  overlay.appendChild(panel);

  // 오버레이 바깥(= 배경) 클릭이면 닫는다.
  // mousedown 이 아니라 click 인 이유: mousedown 에서 닫으면 이어지는 click 이
  // 아래의 셀에 떨어져 앱이 실행돼 버린다.
  overlay.addEventListener('click', (e) => {
    if (e.target !== overlay) return;
    e.stopPropagation();
    closeFolder();
  });

  rootEl.appendChild(overlay);
  overlayEl = overlay;
  openFolderId = folder.id;

  emitRendered();
}

/**
 * 지금 열려 있는 폴더의 id. 닫혀 있으면 null.
 *
 * 재렌더(`renderGrid`)는 오버레이를 걷어내므로, 폴더 안에서 무언가를 바꾼 뒤 같은 폴더를 다시
 * 열고 싶으면 **바꾸기 전에** 이 값을 읽어 두었다가 `openFolder(id)` 를 부르면 된다.
 * 다시 열지 말지는 여기서 정하지 않는다 — 호출자 몫이다.
 */
export function getOpenFolderId(): string | null {
  return openFolderId;
}

/** 오버레이만 걷어낸다 (이벤트를 쏘지 않는다) */
function removeOverlay(): void {
  overlayEl?.remove();
  overlayEl = null;
  openFolderId = null;
}

/** 폴더를 닫는다. 열려 있지 않으면 아무것도 하지 않는다 */
export function closeFolder(): void {
  if (!overlayEl) return;
  // 폴더 안에서 골라 둔 것이 있으면 푼다. 오버레이를 걷기 전에 해야 클래스를 지울 수 있다.
  clearSelection();
  removeOverlay();
  emitRendered();
}

/* ------------------------------------------------------------- 전역 리스너 */

function bindGlobalListeners(): void {
  if (globalListenersBound) return;
  globalListenersBound = true;

  // 폴더가 열려 있을 때의 Esc 는 **폴더만** 닫는다. 패널까지 닫으면 안 된다.
  // window 캡처 단계가 이벤트가 가장 먼저 도는 지점이라 여기서 잡고 전파를 끊는다.
  // 폴더가 닫혀 있을 때는 손대지 않으므로 패널 닫기 Esc 는 그대로 흘러간다.
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape') return;

      // 선택이 있으면 Esc 는 **선택만** 푼다. 폴더도 패널도 닫지 않는다 (탐색기와 같다).
      if (selected.size > 0) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        clearSelection();
        return;
      }

      if (!overlayEl) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      closeFolder();
    },
    true,
  );
}

// 같은 타깃·같은 단계의 리스너는 **등록 순서대로** 실행된다.
// 첫 렌더까지 기다리면 다른 모듈이 먼저 Esc 를 가져갈 수 있으므로 모듈 로드 시점에 건다.
bindGlobalListeners();
