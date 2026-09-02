/**
 * drop.ts — **탐색기에서 끌어다 놓은 파일**을 받는다. 렌더러 프로세스 전용.
 *
 * `dnd.ts` 와 혼동하지 마라. 저쪽은 **그리드 안의 아이콘을 옮기는** 드래그이고
 * Pointer Events 로 직접 구현돼 있다. 이 파일은 **바깥에서 들어오는** 파일을 받는 쪽이라
 * 브라우저의 HTML5 드래그 이벤트(`dragover` / `drop`)를 쓴다. 둘은 서로 간섭하지 않는다.
 *
 * ⚠️ 이 파일에서 `electron` 을 import 하지 마라. 메인과의 통신은 `window.bm` 만 쓴다.
 *
 * ## 반드시 `preventDefault()` 를 해야 하는 이유
 * 브라우저의 기본 동작은 **떨어뜨린 파일로 페이지를 이동하는 것**이다. 그대로 두면 그리드가
 * 사라지고 그 파일이 창에 열린다. `dragover` 와 `drop` 양쪽 모두에서 막아야 하며,
 * `dragover` 에서 막지 않으면 `drop` 이 아예 발생하지 않는다.
 *
 * 그래서 리스너를 `document` 에 건다. 패널 안이든 밖이든 이 창에 떨어진 것은 전부 막아야
 * 화면이 날아가지 않는다.
 *
 * ## 경로는 preload 를 거쳐서만 얻는다
 * Electron 32 부터 `File.path` 가 제거됐다(이 앱은 43). 실제 경로는 preload 가 노출한
 * `window.bm.pathForFile()` 로만 얻을 수 있다.
 *
 * ## 여기서 정하지 않는 것
 * - **어떤 확장자를 받을지** — 메인이 정한다(`.lnk` 만). 여기서 미리 거르면 규칙이 두 곳으로 갈린다
 * - **폴더가 열려 있을 때 그 폴더 안에 넣을지** — 결정된 바 없어 언제나 메인 그리드에 넣는다
 */

import type { BluemingApi } from '../preload';

/** 드래그가 창 위에 있는 동안 루트에 붙는 클래스. index.css 와의 계약이다 */
const ACTIVE_CLASS = 'bm-drop-active';

function bm(): BluemingApi {
  return (window as unknown as { bm: BluemingApi }).bm;
}

/** 이 드래그가 **파일**인가. 그리드 안의 아이콘 드래그와 섞이지 않게 가른다 */
function hasFiles(e: DragEvent): boolean {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  // `types` 는 브라우저에 따라 DOMStringList 이거나 배열이다. 둘 다 되는 방식으로 본다.
  return Array.from(types).includes('Files');
}

let bound = false;

/**
 * 파일 드롭을 받기 시작한다. 여러 번 불러도 한 번만 건다.
 *
 * `root` 는 드래그 중 강조 표시를 붙일 요소다. 실제 수신은 `document` 전체에서 한다 —
 * 패널 밖에 떨어진 것도 막지 않으면 페이지가 이동해 버리기 때문이다.
 */
export function initFileDrop(root: HTMLElement): void {
  if (bound) return;
  bound = true;

  /*
   * 드래그가 자식 요소 경계를 지날 때마다 `dragenter` / `dragleave` 가 **쌍으로** 뜬다.
   * 그래서 `dragleave` 하나만 보고 지우면 셀 사이를 지나는 동안 강조가 깜빡인다.
   * 들어온 횟수를 세어 0 이 될 때만 지운다.
   */
  let depth = 0;

  const clear = (): void => {
    depth = 0;
    root.classList.remove(ACTIVE_CLASS);
  };

  document.addEventListener('dragenter', (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth += 1;
    root.classList.add(ACTIVE_CLASS);
  });

  document.addEventListener('dragover', (e: DragEvent) => {
    if (!hasFiles(e)) return;
    // 이걸 빼면 `drop` 이 아예 오지 않는다. 기본 동작(파일로 페이지 이동)도 여기서 막힌다.
    e.preventDefault();
    if (e.dataTransfer) {
      // 원본을 옮기는 것이 아니라 등록만 한다는 뜻. 커서 모양이 여기서 갈린다.
      e.dataTransfer.dropEffect = 'copy';
    }
  });

  document.addEventListener('dragleave', (e: DragEvent) => {
    if (!hasFiles(e)) return;
    depth -= 1;
    if (depth <= 0) clear();
  });

  document.addEventListener('drop', (e: DragEvent) => {
    if (!hasFiles(e)) {
      // 파일이 아니어도 기본 동작은 막는다 — 텍스트를 떨궈도 페이지가 이동한다.
      e.preventDefault();
      return;
    }
    e.preventDefault();
    clear();

    const files = Array.from(e.dataTransfer?.files ?? []);
    // 경로를 못 얻은 것은 버린다. 빈 문자열을 넘기면 메인이 걸러내긴 하지만 여기서 줄이는 게 낫다.
    const paths = files.map((f) => bm().pathForFile(f)).filter((p) => p !== '');

    if (paths.length === 0) return;

    // 등록 결과는 메인이 `GRID_UPDATE` 로 되돌려 주므로 여기서 다시 그리지 않는다.
    void bm().grid.addFiles(paths);
  });

  // 드래그 도중 창 밖으로 나가거나 Esc 로 취소되면 강조만 남는다. 그 자국을 지운다.
  window.addEventListener('blur', clear);
}
