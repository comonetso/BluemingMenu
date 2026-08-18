// electron-vite dev/preview 실행 래퍼.
//
// ## 왜 필요한가
// 일부 환경(예: Claude Code 셸)이 `ELECTRON_RUN_AS_NODE=1` 을 상속시킨다. 그러면 Electron 이
// **순수 Node 로 떠서** `require('electron').app` 이 undefined 가 되고 즉시 크래시한다.
//
// ```
//   TypeError: Cannot read properties of undefined (reading 'requestSingleInstanceLock')
// ```
//
// Electron Forge 는 내부에서 이 변수를 지워 줬지만 electron-vite 는 그대로 상속한다.
// 빌드 도구를 옮기면서 드러난 문제다 (2026-08-18).
//
// ⚠️ `cross-env "ELECTRON_RUN_AS_NODE="` 처럼 **빈 값을 넣는 방식으로는 안 된다.**
//    Electron 은 변수의 '존재' 만으로 Node 모드로 판단한다. 반드시 완전히 delete 해야 한다.
//    그래서 이 래퍼에서 지운 뒤 자식 프로세스로 넘긴다.
//
// (같은 워크스페이스의 BluemingWiki 가 같은 문제를 이 방식으로 해결하고 있다)

import { spawn } from 'node:child_process';

delete process.env.ELECTRON_RUN_AS_NODE;

const mode = process.argv[2] ?? 'dev';
const child = spawn('electron-vite', [mode], {
  stdio: 'inherit',
  shell: true,
  env: process.env,
});

child.on('exit', (code) => process.exit(code ?? 0));
