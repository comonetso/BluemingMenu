/**
 * 전역 단축키 — `native/hotkey` 프로세스를 띄우고 내린다.
 *
 * ## 왜 별도 프로세스인가
 * Electron 의 `globalShortcut` 은 **수식키만으로 이뤄진 조합을 등록할 수 없다.**
 * `Win+Alt` 같은 조합은 저수준 키보드 훅(`WH_KEYBOARD_LL`)으로만 잡힌다.
 *
 * 훅 콜백이 `LowLevelHooksTimeout` 을 넘기면 Windows 가 훅을 조용히 해제해 버리므로,
 * 훅은 **아무 일도 하지 않는 작은 네이티브 프로세스**에 둔다. 그쪽은 키를 삼키지 않고
 * 조건이 맞을 때 named pipe 로 한 줄 보내기만 한다 (`native/hotkey/src/main.rs` 참조).
 *
 * ## 수명
 * 앱이 살아 있는 동안만 돈다. 앱을 끄면 함께 죽으므로 훅이 남아 떠도는 일이 없다.
 */

import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 단축키를 쓰지 않음을 뜻하는 값 */
export const HOTKEY_NONE = 'none';

let child: ChildProcess | null = null;

/**
 * 훅 실행 파일 경로.
 *
 * 개발 중에는 cargo 산출물을 그대로 쓰고, 패키징 후에는 `resources` 에 동봉된 것을 쓴다.
 * ⚠️ 패키징 시 `forge.config.ts` 의 `extraResource` 에 이 exe 를 넣어야 한다.
 */
function hotkeyExePath(): string | null {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'blueming-hotkey.exe')]
    : [
        path.join(
          app.getAppPath(),
          'native',
          'hotkey',
          'target',
          'release',
          'blueming-hotkey.exe',
        ),
      ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  console.warn(`[hotkey] 실행 파일을 찾지 못했다 — ${candidates.join(' / ')}`);
  return null;
}

/** 지금 돌고 있는 훅을 내린다 */
export function stopHotkey(): void {
  if (!child) return;

  // ⚠️ 참조를 먼저 떼어낸 뒤 kill 한다.
  //    kill 이 만드는 `exit` 콜백은 **비동기**로 나중에 불린다. 그 사이에 새 훅이
  //    `child` 에 들어가 있으면, 늦게 도착한 옛 콜백이 그 **새 값**을 지워 버린다.
  //    그러면 새 훅은 추적되지 않아 앱을 꺼도 살아남고, 재시작 시 옛 훅과 새 훅이
  //    같은 파이프에 신호를 보내 패널이 두 번 토글된다.
  //    (Codex 리뷰 2026-08-18 지적. 콜백 쪽에서도 `p === child` 로 한 번 더 막는다)
  const doomed = child;
  child = null;
  doomed.kill();

  console.log('[hotkey] 중지');
}

/**
 * 단축키 감시를 시작한다. 이미 돌고 있으면 먼저 내린다.
 *
 * `combo` 는 `'win+alt'` 같은 형식이다. `HOTKEY_NONE` 이면 아무것도 띄우지 않는다.
 */
export function startHotkey(combo: string): void {
  stopHotkey();

  if (combo === HOTKEY_NONE || combo.trim() === '') {
    console.log('[hotkey] 사용 안 함');
    return;
  }

  const exe = hotkeyExePath();
  if (!exe) return;

  /*
   * `--parent-pid` 로 우리 PID 를 넘긴다.
   *
   * ⚠️ Windows 에서 `detached: false` 는 **부모가 크래시하면 자식을 죽이지 않는다.**
   *    그대로 두면 훅 프로세스가 고아로 남아 키보드 훅을 계속 물고 있고, 앱을 다시 켜면
   *    옛 훅과 새 훅이 같은 파이프에 신호를 보내 패널이 두 번 토글된다.
   *    (Codex 리뷰 2026-08-18 지적)
   *    그래서 훅 쪽이 부모를 감시하다 사라지면 스스로 끝낸다.
   */
  const spawned = spawn(exe, [combo, '--parent-pid', String(process.pid)], {
    windowsHide: true,
    stdio: 'ignore',
    detached: false,
  });
  child = spawned;

  spawned.on('error', (err) => {
    console.error(`[hotkey] 실행 실패 — ${exe}\n${err}`);
    // 이 콜백이 늦게 와도 그 사이 교체된 새 훅을 지우지 않는다.
    if (child === spawned) child = null;
  });

  spawned.on('exit', (code) => {
    // 우리가 kill 한 경우에도 불린다. 그때는 `stopHotkey()` 가 이미 참조를 떼어 놓았다.
    if (child !== spawned) return;

    console.warn(`[hotkey] 프로세스가 스스로 종료됨 (code ${code})`);
    child = null;
  });

  console.log(`[hotkey] 시작 — ${combo}`);
}
