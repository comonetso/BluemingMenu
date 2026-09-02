/**
 * 탐색기 셸 확장(`native/shell-ext`)과 이어지는 named pipe 서버.
 *
 * ## 왜 named pipe 인가
 * Windows 11 의 **1급** 컨텍스트 메뉴에 항목을 넣으려면 `IExplorerCommand` COM 핸들러가
 * 필요하고, 그 DLL 은 `explorer.exe` 가 직접 로드한다. 우리 Electron 앱은 그 자리에 없다.
 * 그래서 DLL 이 우리에게 물어볼 통로가 필요하다.
 *
 * lock 파일이나 레지스트리 플래그가 아니라 파이프를 쓰는 이유는 **수명이 정확**하기 때문이다.
 * 프로세스가 죽으면 파이프도 함께 사라진다. 비정상 종료 뒤에도 "앱이 켜져 있다"고
 * 잘못 말하는 찌꺼기가 남지 않는다. 사용자 요구가 "앱이 켜져 있을 때만" 이므로 이게 중요하다.
 *
 * ## 프로토콜 — 한 줄 요청, 한 줄 응답
 * ```
 *   QUERY\t<lnk 경로>   →  ADDED | ABSENT
 *   TOGGLE\t<lnk 경로>  →  ADDED | REMOVED | ERROR
 *   HOTKEY\tTOGGLE      →  OK        (native/hotkey 가 보낸다)
 *   MOUSE\tDOWN | UP     →  OK        (native/hotkey 가 보낸다. 왼쪽 버튼)
 * ```
 * ⚠️ 탐색기는 메뉴를 그리는 동안 `GetTitle()` 을 **동기로** 기다린다. 여기서 오래 끌면
 *    우클릭 메뉴 자체가 멈춘다. 응답은 파일 I/O 없이 메모리 조회만으로 끝나야 한다.
 *    (등록 여부 판정은 이미 메모리에 있는 `items` 를 훑는 것뿐이다)
 */

import net from 'node:net';

/**
 * 파이프 이름. **DLL 쪽과 반드시 같아야 한다** (`native/shell-ext/src/lib.rs`).
 * 한쪽만 바꾸면 메뉴가 조용히 사라진다.
 */
export const PIPE_PATH = '\\\\.\\pipe\\blueming-menu';

export interface PipeHandlers {
  /** 이 `.lnk` 가 이미 메뉴에 있는가 */
  isRegistered(lnkPath: string): boolean;
  /** 있으면 빼고 없으면 넣는다. 결과를 돌려준다 */
  toggle(lnkPath: string): Promise<'added' | 'removed' | 'error'>;
  /** 전역 단축키가 눌렸다 (`native/hotkey` 프로세스가 보낸다) */
  hotkey(action: string): void;
  /**
   * 마우스 왼쪽 버튼이 눌렸거나(`true`) 떼어졌다(`false`). `native/hotkey` 가 보낸다.
   * 패널이 "포커스를 잃었을 때 그게 드래그 시작인지" 를 가리는 데 쓴다 (`windows/panel.ts`).
   */
  mouse(down: boolean): void;
}

let server: net.Server | null = null;

function handleLine(line: string, handlers: PipeHandlers): Promise<string> {
  const tab = line.indexOf('\t');
  const command = (tab === -1 ? line : line.slice(0, tab)).trim().toUpperCase();
  const lnkPath = tab === -1 ? '' : line.slice(tab + 1).trim();

  if (lnkPath === '') return Promise.resolve('ERROR');

  switch (command) {
    case 'QUERY':
      return Promise.resolve(handlers.isRegistered(lnkPath) ? 'ADDED' : 'ABSENT');

    case 'TOGGLE':
      return handlers.toggle(lnkPath).then((result) => {
        if (result === 'added') return 'ADDED';
        if (result === 'removed') return 'REMOVED';
        return 'ERROR';
      });

    // 단축키 프로세스가 보내는 신호. 두 번째 필드는 동작 이름이다 (지금은 TOGGLE 뿐).
    case 'HOTKEY':
      handlers.hotkey(lnkPath.toUpperCase());
      return Promise.resolve('OK');

    // 마우스 왼쪽 버튼 상태. 두 번째 필드는 DOWN 또는 UP 이다.
    case 'MOUSE':
      handlers.mouse(lnkPath.toUpperCase() === 'DOWN');
      return Promise.resolve('OK');

    default:
      console.warn(`[pipe] 모르는 명령: ${command}`);
      return Promise.resolve('ERROR');
  }
}

export function startPipeServer(handlers: PipeHandlers): void {
  if (server) return;

  server = net.createServer((socket) => {
    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');

      // 여러 줄이 한 번에 올 수 있다. 줄 단위로 끊어 처리한다.
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);

        void handleLine(line, handlers).then((reply) => {
          if (!socket.destroyed) socket.write(`${reply}\n`);
        });

        newline = buffer.indexOf('\n');
      }
    });

    // 셸 확장은 짧게 붙었다 끊는다. 끊김은 정상이므로 조용히 넘긴다.
    socket.on('error', () => undefined);
  });

  server.on('error', (err) => {
    console.error(`[pipe] 서버 오류 — ${PIPE_PATH}\n${err}`);

    /*
     * ⚠️ 실패했으면 **참조를 비운다.**
     * 그러지 않으면 `startPipeServer()` 가 위의 `if (server) return` 에 걸려 즉시 돌아가고,
     * 점유자가 사라진 뒤에도 다시 열 길이 없다. 그 세션 내내 셸 메뉴와 단축키가 죽는다.
     * (Codex 리뷰 2026-08-18 지적)
     *
     * 자동 재시도는 넣지 않는다 — 재시도 간격에 근거가 없다. 대신 다시 열 수 있는 상태로만
     * 되돌려 두고, 호출자가 원하면 `startPipeServer()` 를 다시 부를 수 있게 한다.
     */
    server = null;
  });

  server.listen(PIPE_PATH, () => {
    console.log(`[pipe] 열림 — ${PIPE_PATH}`);
  });
}

export function stopPipeServer(): void {
  if (!server) return;
  server.close();
  server = null;
  console.log('[pipe] 닫힘');
}
