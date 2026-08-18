/**
 * dnd.ts — 그리드 드래그. **렌더러 프로세스 전용**.
 *
 * 다루는 것 4가지
 *   1. 메인 그리드 안에서 위치 변경
 *   2. 아이콘 위에 아이콘을 겹쳐 폴더 만들기 / 기존 폴더에 넣기
 *   3. **폴더 안에서 순서 변경** (2026-08-18 추가)
 *   4. **폴더 안 항목을 폴더 밖(메인 그리드)으로 빼내기** (2026-08-18 추가)
 *
 * 사용자 요구 (2026-08-18)
 *   "드래그로 한 개의 아이콘에 다른 한 개를 가져다 놓으면 즉시 폴더 구성이 되어야 함.
 *    별도로 폴더를 만들지 않는 구조임. 그리고 드래그로 위치 변경이 되어야 함.
 *    즉, 윈도우 시작 메뉴 작동과 동일해야 함."
 *   "폴더를 구성하고 빼올 방법이 없음" → 3·4 번이 이 지적에 대한 대응이다.
 *
 * ⚠️ 이 파일에서 `electron` 을 import 하지 마라. 렌더러에서 돈다.
 * ⚠️ `bm-*` 클래스 이름은 grid.ts · index.css 와의 계약이다. 바꾸면 스타일이 깨진다.
 *
 * ## HTML5 DnD 가 아니라 Pointer Events 를 골랐다
 *
 * 1. 이 창은 프레임리스 + `transparent:true` 다. HTML5 DnD 의 기본 고스트 이미지는
 *    투명 창에서 배경이 검게 남거나 잘려 보인다. 끄는 표준 방법도 없다
 *    (`setDragImage` 로 빈 이미지를 넣는 우회는 브라우저마다 결과가 다르다).
 * 2. `dragover` 좌표는 DPI 스케일이 걸린 환경에서 어긋나는 사례가 보고돼 있다.
 *    이 PC 는 배율 1.3959 다 (config.ts 실측). 좌표가 틀리면 폴더화 판정이 통째로 틀어진다.
 * 3. `setPointerCapture` 는 포인터가 창 밖으로 나가도 추적을 유지한다. 패널은 화면 가장자리에
 *    붙어 뜨므로 드래그가 창 밖으로 나가는 일이 흔하다.
 * 4. 클릭/드래그 구분을 직접 잡아야 한다. grid.ts 가 셀마다 `click` 으로 실행을 걸어 두었기
 *    때문에, 드래그였을 때만 그 클릭을 삼키는 제어가 필요하다. HTML5 DnD 로는 이 경계를
 *    다루기 어렵다.
 *
 * (DIRECTION.md 3.1 표에는 "드래그&드롭 | HTML5 DnD" 로 적혀 있지만, 그건 스택 선정 단계의
 *  기술 조사 메모다. 실제 구현 방식까지 확정한 항목은 아니다.)
 *
 * ## 셀이 어느 배열의 것인지 — `data-scope` 하나로 가른다
 *
 * grid.ts 는 메인 그리드 셀과 폴더 안 셀에 똑같이 `.bm-cell` · `data-index` 를 붙이지만
 * 앞의 `data-index` 는 `items` 인덱스, 뒤의 것은 그 폴더 `children` 인덱스다.
 * **값이 같아도 뜻이 다르다.** 섞이면 엉뚱한 항목이 사라진다.
 *
 *   `data-scope="grid"`      → `items`
 *   `data-scope="folder"`    → `data-parent` 가 가리키는 폴더의 `children`
 *
 * 이 두 속성은 항목 셀뿐 아니라 **빈 칸(`.bm-cell-empty`)에도 붙는다** (grid.ts DOM 계약).
 *
 * 그 위에 이 파일은 `data-index` 를 **읽지 않는다.** 인덱스는 `data-id` 로 배열에서 다시
 * 찾고, 빈 칸은 "그 배열의 끝"으로만 해석한다 (두 배열 모두 조밀해서 빈 칸은 언제나
 * 마지막 항목 뒤다 — grid.ts `buildGrid`). 드래그 도중 데이터가 갈려도 인덱스가 어긋나지
 * 않고, 배열을 잘못 짚는 사고 자체가 구조적으로 막힌다.
 *
 * ## 시각 피드백
 *
 * 클래스 4종(`bm-dragging` / `bm-merge-target` / `bm-insert-before` / `bm-insert-after`)만
 * 붙인다. 커서를 따라다니는 고스트 엘리먼트는 **만들지 않는다** — 계약에 없는 엘리먼트를
 * 끼워 넣으면 CSS 담당이 모르는 채로 스타일 없이 렌더된다.
 * 대신 드래그 중인 셀에 포인터 이동량을 CSS 변수로 실어 둔다 (`--bm-drag-dx/dy`).
 *
 * 여기에 더해 **폴더 안 항목을 끌고 있는 동안에만** 루트에 `bm-drag-from-folder` 를 붙인다.
 * 폴더 패널은 `overflow: hidden`, 폴더 그리드는 `overflow-y: auto` 라서 끌고 나가는 셀이
 * 폴더 밖으로 나가는 순간 **잘려 보인다**. CSS 가 이 클래스를 잡아 대응할 수 있게 두는 고리이며,
 * 스타일이 없으면 아무 일도 일어나지 않는다.
 */

import type { AppEntry, FolderEntry, GridEntry } from '../types';
// grid.ts 의 공개 함수다. 순환 참조가 아니다 (grid.ts 는 dnd.ts 를 모른다).
// 폴더 안에서 순서만 바꿨을 때 재렌더로 닫힌 폴더를 즉시 다시 열기 위해 쓴다.
import { openFolder } from './grid';

/* ------------------------------------------------------------------ 임의값 */

/**
 * 클릭과 드래그를 가르는 이동 거리 (CSS 픽셀).
 * **임의값** — 사용자가 정한 바 없다. 이 값 미만이면 드래그를 시작하지 않고
 * grid.ts 의 클릭(앱 실행 / 폴더 열기)이 그대로 산다.
 */
const DRAG_THRESHOLD_PX = 6;

/**
 * 대상 셀에서 "중심부"로 볼 비율. 0.5 = 가로·세로 각각 가운데 50% 영역.
 * **임의값** — 사용자가 정한 바 없다. 중심부에 놓으면 폴더화, 가장자리면 순서 변경이다.
 * 키우면 폴더가 잘 만들어지고 순서 변경이 까다로워진다. 반대도 같다.
 */
const MERGE_ZONE_RATIO = 0.5;

/**
 * ★★ 결정 필요 — 마지막 항목까지 빼내 **빈 폴더**가 됐을 때 그 폴더를 지울 것인가.
 *
 * `true` 로 두었다. 근거는 세 가지다.
 *   1. 이 앱에는 "폴더 만들기" UI 가 없다 (DIRECTION.md 5.2: "폴더는 겹침으로만 만들어진다").
 *      즉 **빈 폴더를 의도적으로 만들 수단 자체가 없으므로**, 빈 폴더는 언제나 사고의 산물이다
 *   2. 빈 폴더는 눌러도 아무것도 없는 오버레이만 열린다. 지울 방법도 컨텍스트 메뉴뿐이라
 *      "빼냈더니 못 지우는 껍데기가 남는" 상태가 된다
 *   3. "윈도우 시작 메뉴 작동과 동일해야 함"(사용자 지정) — 시작 메뉴도 빈 폴더를 남기지 않는다
 *
 * 남기는 쪽이 맞다면 이 값만 `false` 로 바꾸면 된다. 다른 코드는 손댈 것이 없다.
 *
 * ⚠️ 자식이 **1개** 남은 폴더는 손대지 않는다. 시작 메뉴는 그것도 자동 해체하지만
 *    그건 별개 정책이라 임의로 넣지 않았다. 원하면 지시해 달라.
 */
const REMOVE_EMPTY_FOLDER = true;

/* ------------------------------------------------------- DOM 계약 (grid.ts) */

/** grid.ts 가 렌더를 마치면 window 에 쏘는 이벤트 */
const RENDERED_EVENT = 'bm:grid:rendered';

const CELL_SEL = '.bm-cell';
const EMPTY_CLASS = 'bm-cell-empty';
/** 오버레이 안의 실제 폴더 상자. 여기 안쪽이면 "폴더 영역" 이다 */
const FOLDER_PANEL_SEL = '.bm-folder-panel';

/** `data-scope` 가 가질 수 있는 값 (grid.ts DOM 계약) */
const SCOPE_GRID = 'grid';
const SCOPE_FOLDER = 'folder';

const CLS_DRAGGING = 'bm-dragging';
const CLS_MERGE = 'bm-merge-target';
const CLS_BEFORE = 'bm-insert-before';
const CLS_AFTER = 'bm-insert-after';
/** 폴더 안 항목을 끌고 있는 동안 루트에 붙는다 (CSS 용 고리, 없어도 동작한다) */
const CLS_FROM_FOLDER = 'bm-drag-from-folder';

/** CSS 가 원하면 쓸 수 있는 포인터 이동량 (px 단위 문자열) */
const VAR_DRAG_DX = '--bm-drag-dx';
const VAR_DRAG_DY = '--bm-drag-dy';

/**
 * 새로 만드는 폴더 id 의 접두사.
 * 앱 id 는 `sha1(lnkPath)` 앞 12자리 **16진수**다 (scanner.ts). 접두사에 `-` 가 들어가므로
 * 앱 id 와는 형식상 절대 겹치지 않는다. 그 위에 현재 배열의 id 와도 겹치지 않는지 확인한다.
 */
const FOLDER_ID_PREFIX = 'folder-';

/* -------------------------------------------------------------------- 타입 */

export interface DndOptions {
  root: HTMLElement;
  getItems(): GridEntry[];
  /** 저장 + 재렌더까지 호출자가 책임진다 */
  setItems(items: GridEntry[]): void;
}

/**
 * 셀이 속한 컨테이너.
 *   `null`      = 메인 그리드 (`items`)
 *   `'<폴더id>'` = 그 폴더의 `children`
 * 판정에 실패하면 `undefined` 를 쓴다 — **추측하지 않고 드래그를 포기한다.**
 */
type Container = string | null;

/** 'merge' = 폴더화, 'before'/'after' = 대상 셀 앞/뒤로 순서 변경 */
type DropMode = 'merge' | 'before' | 'after';

interface DropTarget {
  cell: HTMLElement;
  /** 어느 배열에 떨어지는가 */
  container: Container;
  /** 그 배열 안의 인덱스. 빈 칸에 놓았을 때는 배열 길이(= 맨 뒤) */
  index: number;
  mode: DropMode;
}

/* -------------------------------------------------------------- 순수 계산부 */

/** 셀 중심부(= 폴더화 영역) 안인가 */
function inMergeZone(x: number, y: number, rect: DOMRect): boolean {
  const halfW = (rect.width * MERGE_ZONE_RATIO) / 2;
  const halfH = (rect.height * MERGE_ZONE_RATIO) / 2;
  return (
    Math.abs(x - (rect.left + rect.width / 2)) <= halfW &&
    Math.abs(y - (rect.top + rect.height / 2)) <= halfH
  );
}

/**
 * 이 조합을 폴더로 합칠 수 있는가.
 *
 * - app + app       → 새 폴더
 * - app + folder    → 그 폴더에 앱을 넣는다 (어느 쪽을 끌었든)
 * - folder + folder → **합치지 않는다.** 중첩 폴더는 결정된 바 없고 `FolderEntry.children` 도
 *                     `AppEntry[]` 라 담을 수 없다. 순서 변경으로 처리한다
 */
function canMerge(src: GridEntry, tgt: GridEntry): boolean {
  return !(src.kind === 'folder' && tgt.kind === 'folder');
}

/**
 * 폴더 id 를 만든다.
 *
 * 시각·난수만으로도 사실상 안 겹치지만, "충돌하지 않게"가 요구사항이므로 현재 배열
 * (자식까지 포함)의 id 를 모아 확인하고 겹치면 다시 뽑는다. 확률이 아니라 확인으로 보장한다.
 */
function makeFolderId(items: GridEntry[]): string {
  const used = new Set<string>();
  for (const item of items) {
    used.add(item.id);
    if (item.kind === 'folder') {
      for (const child of item.children) used.add(child.id);
    }
  }

  let id = '';
  do {
    // 36진수 시각 + 난수. 난수 길이는 충돌 확인 루프가 있으니 형식상의 값이다.
    id = `${FOLDER_ID_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  } while (used.has(id));
  return id;
}

/**
 * 순서 변경. `to` 는 **제거 전** 배열 기준의 삽입 지점이다.
 * 결과가 원래 위치와 같으면 null 을 돌려 저장·재렌더를 건너뛰게 한다.
 *
 * `items` 와 `children` 양쪽에 쓰이므로 제네릭이다.
 */
function moveTo<T>(list: readonly T[], from: number, to: number): T[] | null {
  const clamped = Math.max(0, Math.min(to, list.length));
  const insertAt = from < clamped ? clamped - 1 : clamped;
  if (insertAt === from) return null;

  const next = list.slice();
  const [moved] = next.splice(from, 1);
  next.splice(insertAt, 0, moved);
  return next;
}

/** `items` 안에서 폴더를 찾는다. 없으면 -1 */
function findFolderIndex(items: GridEntry[], folderId: string): number {
  return items.findIndex((it) => it.kind === 'folder' && it.id === folderId);
}

/**
 * 컨테이너가 가리키는 배열.
 * 폴더가 사라졌으면 null — 드래그 도중 데이터가 갈렸다는 뜻이므로 아무것도 하지 않는다.
 */
function entriesOf(items: GridEntry[], container: Container): readonly GridEntry[] | null {
  if (container === null) return items;
  const index = findFolderIndex(items, container);
  return index < 0 ? null : (items[index] as FolderEntry).children;
}

/**
 * 폴더화. 결과 폴더는 **놓은 자리(대상 인덱스)** 에 들어간다 — 끈 것이 놓인 곳에 자리잡는 게
 * 시작 메뉴의 거동이다. 메인 그리드 안에서만 일어난다 (아래 `resolveTarget` 참조).
 *
 * 폴더를 앱 위에 끈 경우(src=folder, tgt=app)도 같은 규칙으로 폴더가 대상 자리로 옮겨온다.
 * "app + folder → 그 폴더의 children 에 추가"를 **순서 없는 조합**으로 읽은 결과다.
 */
function mergeInto(items: GridEntry[], from: number, targetIndex: number): GridEntry[] | null {
  const src = items[from];
  const tgt = items[targetIndex];
  if (!src || !tgt || from === targetIndex) return null;

  let merged: FolderEntry;
  if (src.kind === 'app' && tgt.kind === 'app') {
    merged = {
      kind: 'folder',
      id: makeFolderId(items),
      // 이름은 빈 문자열로 둔다. grid.ts 가 빈 이름을 `t('folder.defaultName')` 으로 그리고
      // 이름 입력칸의 placeholder 로도 쓴다 (grid.ts `displayName` · `createFolderNameInput`).
      // 번역된 문자열을 데이터에 박으면 언어를 바꿔도 옛 언어 이름이 남는다.
      name: '',
      // 자리를 지키고 있던 쪽이 먼저, 끌어온 쪽이 뒤.
      children: [tgt, src],
    };
  } else if (src.kind === 'app' && tgt.kind === 'folder') {
    merged = { ...tgt, children: [...tgt.children, src] };
  } else if (src.kind === 'folder' && tgt.kind === 'app') {
    merged = { ...src, children: [...src.children, tgt] };
  } else {
    // folder + folder — canMerge 에서 이미 걸러진다
    return null;
  }

  const next = items.slice();
  next[targetIndex] = merged;
  next.splice(from, 1);
  return next;
}

/**
 * 폴더 **안에서만** 순서를 바꾼다. `children` 은 `AppEntry[]` 라 여기서는 폴더화가 일어날 수
 * 없다 (중첩 폴더를 담을 자리가 타입에 없다). 그래서 순서 변경만 있다.
 */
function reorderInFolder(
  items: GridEntry[],
  folderId: string,
  childId: string,
  insertAt: number,
): GridEntry[] | null {
  const folderIndex = findFolderIndex(items, folderId);
  if (folderIndex < 0) return null;

  const folder = items[folderIndex] as FolderEntry;
  const from = folder.children.findIndex((c) => c.id === childId);
  if (from < 0) return null;

  const nextChildren = moveTo(folder.children, from, insertAt);
  if (!nextChildren) return null;

  const next = items.slice();
  next[folderIndex] = { ...folder, children: nextChildren };
  return next;
}

/**
 * 폴더 안 항목을 **메인 그리드로 빼낸다.** 사용자 지적("빼올 방법이 없음")의 핵심 동작이다.
 *
 * `insertAt` 은 **폴더에서 빼내기 전** `items` 기준의 삽입 지점이다. 두 배열이 서로 다르므로
 * 자식을 빼도 `items` 인덱스는 밀리지 않는다 — 보정이 필요한 경우는 **빈 폴더를 지워서
 * `items` 가 한 칸 줄었을 때** 하나뿐이고, 그것만 아래에서 따로 처리한다.
 */
function extractFromFolder(
  items: GridEntry[],
  folderId: string,
  childId: string,
  insertAt: number,
): GridEntry[] | null {
  const folderIndex = findFolderIndex(items, folderId);
  if (folderIndex < 0) return null;

  const folder = items[folderIndex] as FolderEntry;
  const childIndex = folder.children.findIndex((c) => c.id === childId);
  if (childIndex < 0) return null;

  const child: AppEntry = folder.children[childIndex];
  const rest = folder.children.filter((_, i) => i !== childIndex);

  const next = items.slice();
  let at = Math.max(0, Math.min(insertAt, items.length));

  if (rest.length === 0 && REMOVE_EMPTY_FOLDER) {
    next.splice(folderIndex, 1);
    // 폴더가 빠져 뒤쪽 인덱스가 한 칸 당겨졌다
    if (at > folderIndex) at -= 1;
  } else {
    next[folderIndex] = { ...folder, children: rest };
  }

  next.splice(Math.min(at, next.length), 0, child);
  return next;
}

/* -------------------------------------------------------------------- 본체 */

/** 같은 root 에 두 번 거는 것을 막는다 */
const bound = new WeakSet<HTMLElement>();

export function initDnd(opts: DndOptions): void {
  if (bound.has(opts.root)) return;
  bound.add(opts.root);

  /** 눌린 포인터. 놓여 있지 않으면 -1 */
  let pointerId = -1;
  let startX = 0;
  let startY = 0;
  let sourceCell: HTMLElement | null = null;
  /** 끌고 있는 항목의 id. 재렌더로 sourceCell 이 죽어도 이 값으로 배열에서 다시 찾는다 */
  let sourceId: string | null = null;
  /** 끌고 있는 항목이 원래 있던 컨테이너 */
  let sourceContainer: Container = null;
  /** 임계값을 넘겨 실제 드래그로 들어갔는가 */
  let dragging = false;
  let target: DropTarget | null = null;
  /** 드래그였으므로 뒤따르는 click 을 삼켜야 하는가 */
  let suppressClick = false;

  /* --------------------------------------------------------------- 조회 */

  function cellFrom(el: Element | null): HTMLElement | null {
    if (!el) return null;
    const cell = el.closest<HTMLElement>(CELL_SEL);
    if (!cell || !opts.root.contains(cell)) return null;
    return cell;
  }

  /**
   * 이 셀이 속한 컨테이너. 판정 못 하면 `undefined`.
   *
   * 폴더 안/밖 구분은 **오직 셀 자신의 `data-scope`** 로 한다 (grid.ts DOM 계약).
   * 조상을 뒤지지 않으므로 오버레이 구조가 바뀌어도 흔들리지 않는다.
   *
   * 표식이 없거나 아는 값이 아니면 **추측하지 않고 포기한다.** 여기서 "메인 그리드겠지" 로
   * 넘어가면 폴더 안 셀의 인덱스를 `items` 에 대입하게 되고, 엉뚱한 항목이 사라진다.
   */
  function containerOf(cell: HTMLElement): Container | undefined {
    const scope = cell.dataset.scope;
    if (scope === SCOPE_GRID) return null;
    if (scope === SCOPE_FOLDER) return cell.dataset.parent || undefined;
    return undefined;
  }

  /**
   * 좌표 아래의 셀. **복수형 히트테스트**를 쓴다.
   *
   * 폴더 오버레이는 `position: fixed; inset: 0` 으로 화면 전체를 덮는다(index.css 8장).
   * 그래서 `elementFromPoint` 는 폴더 상자 바깥에서도 오버레이 자신만 돌려주고, 그 아래
   * 메인 그리드 셀에는 영영 닿지 못한다 — 그러면 "폴더 밖으로 빼내기" 가 불가능하다.
   * `elementsFromPoint` 는 겹쳐 있는 것을 위에서부터 전부 주므로 오버레이를 지나 아래를 본다.
   *
   * 단, 폴더 상자(`.bm-folder-panel`) 안쪽의 빈 여백에서는 **아래를 보지 않는다.**
   * 커서가 폴더 안에 있는데 밑에 깔린 메인 그리드 셀에 삽입 표시가 뜨면 거짓말이 된다.
   */
  function cellAtPoint(x: number, y: number): HTMLElement | null {
    for (const el of document.elementsFromPoint(x, y)) {
      const cell = cellFrom(el);
      if (cell) return cell;
      // 셀이 아닌 폴더 상자 내부(패딩·이름 입력칸 줄)에 닿았다 — 여기서 탐색을 끊는다
      if (el.closest(FOLDER_PANEL_SEL)) return null;
    }
    return null;
  }

  /** 지금 포인터 아래의 드롭 지점 */
  function resolveTarget(x: number, y: number): DropTarget | null {
    if (!sourceCell || !sourceId) return null;

    const cell = cellAtPoint(x, y);
    if (!cell || cell === sourceCell) return null;

    const rect = cell.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;

    const container = containerOf(cell);
    if (container === undefined) return null;

    const items = opts.getItems();
    const list = entriesOf(items, container);
    const srcList = entriesOf(items, sourceContainer);
    if (!list || !srcList) return null;

    const sourceIndex = srcList.findIndex((it) => it.id === sourceId);
    if (sourceIndex < 0) return null;

    const sameContainer = container === sourceContainer;

    // 빈 칸 — 그 컨테이너 배열의 맨 뒤. 폴더화는 일어나지 않는다.
    // (items · children 모두 조밀 배열이라 빈 칸은 항상 마지막 항목 뒤다 — grid.ts `buildGrid`)
    if (cell.classList.contains(EMPTY_CLASS)) {
      return { cell, container, index: list.length, mode: 'before' };
    }

    const id = cell.dataset.id;
    const index = id ? list.findIndex((it) => it.id === id) : -1;
    if (index < 0) return null;
    if (sameContainer && index === sourceIndex) return null;

    // 폴더화는 **메인 그리드 안에서 서로 겹쳤을 때만** 일어난다. 이유 두 가지.
    //   · 폴더 안(children)은 `AppEntry[]` 라 중첩 폴더를 담을 자리가 타입에 없다
    //   · 폴더 밖으로 빼내는 동작에서 폴더화가 같이 열려 있으면, 이웃 아이콘 가운데에 살짝
    //     걸치는 것만으로 **새 폴더가 생겨** 빼내려던 의도가 정확히 뒤집힌다.
    //     중심부 판정 영역이 셀의 50%(MERGE_ZONE_RATIO)라 실수할 여지가 크다
    // → "폴더화는 같은 컨테이너 안에서만" 이라는 한 줄 규칙으로 통일했다.
    if (
      sameContainer &&
      container === null &&
      inMergeZone(x, y, rect) &&
      canMerge(srcList[sourceIndex], list[index])
    ) {
      return { cell, container, index, mode: 'merge' };
    }
    // 가장자리 — 좌우 어느 쪽에 걸렸는지로 앞/뒤를 정한다
    return {
      cell,
      container,
      index,
      mode: x < rect.left + rect.width / 2 ? 'before' : 'after',
    };
  }

  /* --------------------------------------------------------- 시각 피드백 */

  function clearTargetClasses(): void {
    target?.cell.classList.remove(CLS_MERGE, CLS_BEFORE, CLS_AFTER);
  }

  function setTarget(next: DropTarget | null): void {
    if (target?.cell === next?.cell && target?.mode === next?.mode) return;
    clearTargetClasses();
    target = next;
    if (!next) return;

    if (next.mode === 'merge') next.cell.classList.add(CLS_MERGE);
    else if (next.mode === 'before') next.cell.classList.add(CLS_BEFORE);
    else next.cell.classList.add(CLS_AFTER);
  }

  /* ------------------------------------------------------------- 생명주기 */

  function beginDrag(): void {
    if (!sourceCell) return;
    dragging = true;
    // 여기서부터는 클릭이 아니다. grid.ts 의 실행/열기 핸들러로 가면 안 된다.
    suppressClick = true;
    sourceCell.classList.add(CLS_DRAGGING);
    // 끌고 있는 셀은 히트테스트에서 빠져야 한다. CSS 가 `--bm-drag-dx` 로 이 셀을 커서에
    // 따라 움직이게 만들면, 이게 없을 때 `elementsFromPoint` 가 늘 자기 자신을 먼저 집어
    // 드롭 대상이 영영 안 잡힌다.
    sourceCell.style.pointerEvents = 'none';
    // 폴더 안에서 끌어내는 중이라는 표시 (CSS 용 고리. 스타일이 없으면 아무 일도 없다)
    if (sourceContainer !== null) opts.root.classList.add(CLS_FROM_FOLDER);

    // 포인터가 창 밖으로 나가도 추적을 유지한다. root 는 재렌더에도 살아남는 유일한 엘리먼트다
    // (grid.ts 는 root 의 자식만 갈아엎는다).
    try {
      opts.root.setPointerCapture(pointerId);
    } catch {
      // 캡처가 안 걸려도 window 리스너로 창 안에서는 추적된다
    }

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('selectstart', onSelectStart);
  }

  /** 화면 상태만 원위치. 데이터는 건드리지 않는다 */
  function cleanup(): void {
    clearTargetClasses();
    target = null;

    if (dragging) {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('selectstart', onSelectStart);
      try {
        if (opts.root.hasPointerCapture(pointerId)) opts.root.releasePointerCapture(pointerId);
      } catch {
        // 이미 풀렸으면 그만이다
      }
    }

    opts.root.classList.remove(CLS_FROM_FOLDER);

    if (sourceCell) {
      sourceCell.classList.remove(CLS_DRAGGING);
      sourceCell.style.removeProperty('pointer-events');
      sourceCell.style.removeProperty(VAR_DRAG_DX);
      sourceCell.style.removeProperty(VAR_DRAG_DY);
    }

    sourceCell = null;
    sourceId = null;
    sourceContainer = null;
    dragging = false;
    pointerId = -1;

    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
  }

  /**
   * 배열을 실제로 바꾼다. 저장·재렌더는 호출자(setItems) 몫이다.
   *
   * 재렌더가 열려 있던 폴더를 닫아 버리므로(grid.ts `renderGrid` → `removeOverlay`),
   * **폴더 안에서 순서만 바꾼 경우에는 곧바로 다시 연다.** 밖으로 빼낸 경우에는 다시 열지
   * 않는다 — 방금 어디에 놓였는지를 봐야 하는데 오버레이가 그 자리를 가리기 때문이다.
   *
   * 다시 열 폴더 id 는 grid.ts 의 `getOpenFolderId()` 대신 **드래그를 시작한 셀의 소속**
   * (`from`)에서 가져온다. 폴더 안 셀을 끌고 있다는 것 자체가 그 폴더가 열려 있다는 뜻이라
   * 값이 같고, 화면 상태가 아니라 이 드래그가 실제로 건드린 배열을 근거로 삼는 쪽이 안전하다.
   */
  function commit(id: string, from: Container, drop: DropTarget): void {
    const items = opts.getItems();
    // 'after' 면 대상 뒤. 'merge' 는 이 값을 쓰지 않는다.
    const insertAt = drop.mode === 'after' ? drop.index + 1 : drop.index;

    let next: GridEntry[] | null = null;
    /** 커밋 후 다시 열어야 할 폴더 */
    let reopen: string | null = null;

    if (from === null && drop.container === null) {
      // 메인 → 메인. 기존 동작 그대로다
      const fromIndex = items.findIndex((it) => it.id === id);
      // 드래그 도중 데이터가 갈렸다면 아무것도 하지 않는다. 엉뚱한 자리를 건드리는 것보다 낫다.
      if (fromIndex < 0) return;
      next =
        drop.mode === 'merge'
          ? mergeInto(items, fromIndex, drop.index)
          : moveTo(items, fromIndex, insertAt);
    } else if (from !== null && drop.container === from) {
      // 폴더 안 → 같은 폴더 안. 순서만 바뀐다
      next = reorderInFolder(items, from, id, insertAt);
      reopen = from;
    } else if (from !== null && drop.container === null) {
      // 폴더 안 → 메인 그리드. "빼내기"
      next = extractFromFolder(items, from, id, insertAt);
    } else {
      // 남은 조합은 "메인 → 폴더 안" 과 "폴더 A → 폴더 B" 뿐이다.
      // 오버레이가 화면 전체를 덮어 폴더가 열려 있는 동안에는 메인 그리드 셀에서 드래그를
      // **시작할 수 없고**, 오버레이는 한 번에 하나뿐이라 두 경우 모두 현재 DOM 에서는
      // 도달할 수 없다. 정해진 정책이 없으므로 지어내지 않고 아무것도 하지 않는다.
      // (메인 항목을 폴더에 넣는 길은 이미 있다 — 폴더 셀 중심에 겹쳐 놓으면 된다)
      return;
    }

    if (!next) return;
    opts.setItems(next);
    // setItems 는 동기로 재렌더까지 마친다 (renderer.ts `paint`). 그 뒤에 다시 연다.
    if (reopen) openFolder(reopen);
  }

  /* ------------------------------------------------------------- 이벤트 */

  function onPointerDown(ev: PointerEvent): void {
    // 드래그 도중 다른 버튼이 눌린 것이면 무시한다 (억제 상태도 건드리지 않는다)
    if (dragging || pointerId !== -1) return;
    // 이전 드래그의 잔여 억제를 새 입력이 들어온 시점에 푼다
    suppressClick = false;
    if (ev.button !== 0) return; // 좌클릭만

    const cell = cellFrom(ev.target as Element | null);
    if (!cell || cell.classList.contains(EMPTY_CLASS)) return;

    const id = cell.dataset.id;
    if (!id) return;

    const container = containerOf(cell);
    // 어느 배열의 항목인지 모르면 시작하지 않는다 (위 `containerOf` 주석 참조)
    if (container === undefined) return;

    pointerId = ev.pointerId;
    startX = ev.clientX;
    startY = ev.clientY;
    sourceCell = cell;
    sourceId = id;
    sourceContainer = container;

    // 아직 드래그가 아니다. 여기서 preventDefault 를 부르면 뒤따르는 click 이 죽어
    // grid.ts 의 실행 핸들러가 못 산다 — 부르지 않는다.
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  }

  function onPointerMove(ev: PointerEvent): void {
    if (ev.pointerId !== pointerId || !sourceCell) return;

    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;

    if (!dragging) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      beginDrag();
    }

    sourceCell.style.setProperty(VAR_DRAG_DX, `${dx}px`);
    sourceCell.style.setProperty(VAR_DRAG_DY, `${dy}px`);
    setTarget(resolveTarget(ev.clientX, ev.clientY));
  }

  function onPointerUp(ev: PointerEvent): void {
    if (ev.pointerId !== pointerId) return;

    const drop = dragging ? target : null;
    const id = sourceId;
    const from = sourceContainer;

    // 화면을 먼저 원상복구한 뒤 데이터를 바꾼다. commit 이 재렌더를 부르면
    // 여기서 잡고 있던 엘리먼트는 이미 사라진 뒤다.
    cleanup();

    if (drop && id) commit(id, from, drop);
  }

  function onPointerCancel(ev: PointerEvent): void {
    if (ev.pointerId !== pointerId) return;
    cleanup();
  }

  /**
   * Esc — 드래그 취소. 배열은 그대로 두고 화면만 되돌린다.
   *
   * ⚠️ **폴더가 열려 있을 때는 이 핸들러까지 오지 않는다.** grid.ts 가 모듈 로드 시점에
   *    window 캡처 단계로 Esc 를 먼저 등록해 두었고(`bindGlobalListeners`), 거기서
   *    `stopImmediatePropagation` 으로 끊는다. 결과적으로 폴더 안 드래그 중 Esc 는
   *    "폴더 닫기" 가 되고, 그 닫기가 쏘는 재렌더 이벤트를 아래에서 받아 드래그도 함께
   *    취소된다. 데이터는 어차피 건드리지 않으므로 취소라는 결과는 같다.
   */
  function onKeyDown(ev: KeyboardEvent): void {
    if (ev.key !== 'Escape' || !dragging) return;
    ev.preventDefault();
    ev.stopPropagation();
    // 패널 닫기·폴더 닫기 핸들러까지 가면 안 된다. 취소는 드래그에서 끝난다.
    ev.stopImmediatePropagation();
    // suppressClick 은 켠 채로 둔다 — 취소해도 뒤따르는 click 으로 앱이 실행되면 안 된다
    cleanup();
  }

  /** 드래그 중 텍스트 선택 방지. pointerdown 을 막지 않고 이쪽만 막는다 */
  function onSelectStart(ev: Event): void {
    ev.preventDefault();
  }

  /**
   * 드래그였다면 뒤따르는 click 한 번을 삼킨다 (capture 단계라 셀 핸들러보다 먼저 돈다).
   * 오버레이 배경 위에서 손을 뗐을 때 grid.ts 의 "배경 클릭 → 폴더 닫기" 가 도는 것도
   * 여기서 함께 막힌다 — 빼내기 직후에 폴더가 한 번 더 깜빡이지 않는다.
   */
  function onClickCapture(ev: MouseEvent): void {
    if (!suppressClick) return;
    suppressClick = false;
    ev.preventDefault();
    ev.stopPropagation();
  }

  /**
   * 셀 안의 `<img>` 는 기본적으로 네이티브 드래그가 걸린다. 그게 시작되면 포인터 추적이
   * pointercancel 로 끊긴다. 런처 안에서 이미지 드래그는 어차피 쓸 일이 없다.
   */
  function onDragStart(ev: Event): void {
    ev.preventDefault();
  }

  /* --------------------------------------------------------------- 결선 */

  function attach(): void {
    // grid.ts 는 root 자체가 아니라 자식을 갈아엎으므로 위임으로 충분하지만,
    // 재렌더 후 확실히 살아 있도록 다시 건다. 같은 함수 참조라 중복 등록되지 않는다.
    // (폴더 오버레이도 root 의 자식이라 같은 위임으로 폴더 안 셀까지 잡힌다.)
    opts.root.removeEventListener('pointerdown', onPointerDown);
    opts.root.addEventListener('pointerdown', onPointerDown);
    opts.root.removeEventListener('dragstart', onDragStart);
    opts.root.addEventListener('dragstart', onDragStart);
  }

  attach();
  window.addEventListener('click', onClickCapture, true);

  window.addEventListener(RENDERED_EVENT, () => {
    // 재렌더로 DOM 이 바뀌었다. 진행 중이던 드래그는 대상이 사라졌으므로 접는다.
    // (폴더 열기·닫기도 이 이벤트를 쏜다 — grid.ts `openFolder` · `closeFolder`)
    cleanup();
    attach();
  });
}
