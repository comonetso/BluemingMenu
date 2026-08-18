/**
 * 아이콘 추출 — PowerShell + Win32 `ExtractIconEx`.
 *
 * ## 왜 Electron 의 `app.getFileIcon` 을 안 쓰는가 (2026-08-18 실측)
 * 일부 exe 에서 아이콘 리소스를 못 읽고 **Windows 기본 문서 아이콘을 조용히 돌려준다.**
 * 실패해도 `isEmpty()` 가 false 라 코드 쪽에서 감지할 수도 없다.
 *
 * ```
 *                    getFileIcon   ExtractAssociatedIcon
 *   POWERPNT.EXE        1346 ✗            3556 ✓
 *   WINWORD.EXE         1346 ✗            3132 ✓
 *   Orca.exe            1346 ✗            1952 ✓
 * ```
 * 1346 이 세 번 똑같이 나온 것이 곧 "같은 기본 아이콘" 이라는 증거다.
 * `.lnk` 경로로 뽑는 것도 시도했으나 그때는 **전부** 바로가기 기본 아이콘(1586)이 나왔다.
 *
 * ## 왜 `.lnk` 의 `icon` + `iconIndex` 를 봐야 하는가 (2026-08-18 실측)
 * 바로가기는 자기 아이콘을 따로 지정할 수 있고 **탐색기는 그것을 먼저 본다.**
 * target 만 보면 탐색기와 다른 그림이 나온다.
 *
 * ```
 *   절전모드    target=rundll32.exe    icon=%SystemRoot%\System32\SHELL32.dll, index=?
 *   우분투시작  target=…start-wsl.bat  icon=%SystemRoot%\System32\SHELL32.dll, index=?
 * ```
 * 둘 다 target 으로 뽑으면 각각 rundll32 / bat 기본 아이콘이 되어 **서로 무관한 앱들이
 * 같은 그림**이 된다. 실제 구분은 `SHELL32.dll` 안의 **인덱스**로 이뤄진다.
 *
 * 그래서 두 가지가 반드시 필요하다.
 *   1. **환경변수 확장** — `icon` 필드에 `%SystemRoot%` / `%ProgramFiles(x86)%` 가 그대로 들어 있다.
 *      확장하지 않으면 `Test-Path` 가 false 라 아이콘이 통째로 사라진다 (IObit 사례)
 *   2. **`ExtractIconEx`** — `ExtractAssociatedIcon` 은 인덱스를 지원하지 않아 DLL 안의
 *      몇 번째 아이콘인지 고를 수 없다
 *
 * ## 왜 한 번에 몰아서 처리하는가
 * PowerShell 은 프로세스를 띄우는 비용이 크다. 항목마다 호출하면 200개에 수십 초가 걸린다.
 * 목록을 파일로 넘기고 한 번만 실행해 base64 를 줄 단위로 받는다.
 *
 * ⚠️ 경로에 공백·한글·특수문자가 흔하다. 명령행으로 넘기지 않고 **파일로 주고받는다.**
 */

import { app } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

/** 아이콘을 찾을 단서. 앞에서부터 시도한다 */
export interface IconRequest {
  /** `.lnk` 가 지정한 아이콘 경로. 환경변수가 들어 있을 수 있다 */
  iconPath: string;
  /** 위 경로 안에서 몇 번째 아이콘인가 */
  iconIndex: number;
  /** 실행 대상 */
  target: string;
  /** 바로가기 자신 */
  lnkPath: string;
}

/** 요청 순서와 같은 인덱스에 data URL 이 담긴다. 못 뽑았으면 `undefined` */
export type IconResult = (string | undefined)[];

/**
 * PowerShell 스크립트.
 *
 * 입력  : 한 줄에 `iconPath \t iconIndex \t target \t lnkPath`
 * 출력  : `<줄번호> \t <base64>` — 실패한 줄은 아예 출력하지 않는다
 *
 * 시도 순서는 탐색기가 아이콘을 고르는 순서와 같다.
 *   1. `.lnk` 가 지정한 아이콘 (인덱스까지)
 *   2. 실행 대상의 첫 아이콘
 *   3. 실행 대상의 연결 아이콘 (확장자 기반 폴백 포함)
 *   4. 바로가기 자신
 */
const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class IconApi {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    public static extern uint ExtractIconExW(string lpszFile, int nIconIndex, IntPtr[] phiconLarge, IntPtr[] phiconSmall, uint nIcons);
    [DllImport("user32.dll")]
    public static extern bool DestroyIcon(IntPtr hIcon);
}
"@

function ToPng($icon) {
    if ($null -eq $icon) { return $null }
    $bmp = $icon.ToBitmap()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $b64 = [Convert]::ToBase64String($ms.ToArray())
    $ms.Dispose(); $bmp.Dispose()
    return $b64
}

# 지정한 인덱스의 아이콘을 뽑는다. 32x32(large) 를 쓴다 — config.ts 의 ICON_SIZE 실측값과 같다.
function FromIndex([string]$file, [int]$index) {
    if ([string]::IsNullOrWhiteSpace($file)) { return $null }
    # ⚠️ %SystemRoot% 같은 환경변수가 그대로 들어 있다. 확장하지 않으면 파일을 못 찾는다.
    $p = [Environment]::ExpandEnvironmentVariables($file)
    if (-not (Test-Path -LiteralPath $p)) { return $null }

    $large = New-Object IntPtr[] 1
    $small = New-Object IntPtr[] 1
    $n = [IconApi]::ExtractIconExW($p, $index, $large, $small, 1)
    if ($n -eq 0 -or $large[0] -eq [IntPtr]::Zero) { return $null }

    try {
        $ico = [System.Drawing.Icon]::FromHandle($large[0])
        $b64 = ToPng $ico
        $ico.Dispose()
        return $b64
    } finally {
        [void][IconApi]::DestroyIcon($large[0])
        if ($small[0] -ne [IntPtr]::Zero) { [void][IconApi]::DestroyIcon($small[0]) }
    }
}

function FromAssociated([string]$file) {
    if ([string]::IsNullOrWhiteSpace($file)) { return $null }
    $p = [Environment]::ExpandEnvironmentVariables($file)
    if (-not (Test-Path -LiteralPath $p)) { return $null }
    try {
        $ico = [System.Drawing.Icon]::ExtractAssociatedIcon($p)
        $b64 = ToPng $ico
        if ($null -ne $ico) { $ico.Dispose() }
        return $b64
    } catch { return $null }
}

# ⚠️ @(...) 로 **반드시** 배열화한다. Get-Content 는 줄이 하나뿐이면 배열이 아니라
#    [string] 을 돌려주고, 그러면 $lines[0] 이 첫 줄이 아니라 **첫 글자**가 된다.
#    필드 분리가 깨져(필드 1개) 그 줄이 통째로 버려진다.
#    → 여러 항목을 한꺼번에 스캔할 때는 멀쩡한데 **단건 등록(탐색기 우클릭)만 항상 실패**했다.
#      실측으로 확인한 원인이다 (2026-08-18). 이 괄호를 지우지 마라.
#    (이 주석에 백틱을 쓰지 마라 — 이 스크립트는 TS 템플릿 리터럴 안에 들어 있다)
$lines = @(Get-Content -LiteralPath $args[0] -Encoding UTF8)
$out = New-Object System.Collections.Generic.List[string]

# ⚠️ 탭을 백틱 이스케이프(`+'`'+`t)로 쓰지 마라. 이 스크립트는 TS 템플릿 리터럴 안에 들어 있어
#    백틱이 리터럴을 끊어 버린다. [char]9 로 쓴다.
$TAB = [char]9

for ($i = 0; $i -lt $lines.Count; $i++) {
    $f = $lines[$i] -split $TAB
    if ($f.Count -lt 4) { continue }

    $iconPath = $f[0]
    $iconIndex = 0
    [void][int]::TryParse($f[1], [ref]$iconIndex)
    $target = $f[2]
    $lnk = $f[3]

    $b64 = FromIndex $iconPath $iconIndex
    if (-not $b64) { $b64 = FromIndex $target 0 }
    if (-not $b64) { $b64 = FromAssociated $target }
    if (-not $b64) { $b64 = FromAssociated $lnk }

    if ($b64) { $out.Add([string]$i + $TAB + $b64) }
}

Set-Content -LiteralPath $args[1] -Value $out -Encoding UTF8
`;

/**
 * PowerShell 이 멎었을 때 포기하는 시간.
 *
 * ⚠️ **임의값이다.** 응답하지 않는 UNC 경로 같은 것을 가리키면 PowerShell 이 영영 안 끝나고,
 *    그러면 최초 임포트나 탐색기 등록 요청이 통째로 멈춘다 (Codex 리뷰 2026-08-18 지적).
 *    항목 수에 비례해 늘어나야 하므로 아래 `timeoutFor()` 로 계산한다.
 */
const ICON_TIMEOUT_BASE_MS = 15_000;
/** 항목당 추가 여유. 역시 임의값이다 */
const ICON_TIMEOUT_PER_ITEM_MS = 100;

function timeoutFor(count: number): number {
  return ICON_TIMEOUT_BASE_MS + count * ICON_TIMEOUT_PER_ITEM_MS;
}

/**
 * 호출마다 **다른** 임시 파일 이름을 만든다.
 *
 * ⚠️ 고정 이름을 쓰면 안 된다. 파이프 서버는 `TOGGLE` 을 병렬로 받고 최초 임포트와도 겹칠 수
 *    있는데, 그때 두 호출이 서로의 입력·출력 파일을 덮어쓰거나 지운다. 한 앱에 다른 앱 아이콘이
 *    붙거나 양쪽이 다 실패한다. (Codex 리뷰 2026-08-18 지적)
 */
let sequence = 0;

function tempFile(kind: string, token: string): string {
  return path.join(app.getPath('temp'), `bm-icon-${token}-${kind}`);
}

/** 요청 하나를 스크립트가 읽을 한 줄로 만든다. 탭이 구분자이므로 값에서 제거한다 */
function toLine(req: IconRequest): string {
  const clean = (s: string) => s.replace(/[\t\r\n]/g, ' ');
  return [clean(req.iconPath), String(req.iconIndex), clean(req.target), clean(req.lnkPath)].join('\t');
}

/**
 * 여러 항목의 아이콘을 한 번에 뽑는다.
 * 결과 배열은 요청과 **같은 순서**이며, 못 뽑은 자리는 `undefined` 다.
 */
export async function extractIcons(requests: IconRequest[]): Promise<IconResult> {
  const result: IconResult = new Array(requests.length).fill(undefined);
  if (requests.length === 0) return result;

  sequence += 1;
  const token = `${process.pid}-${sequence}`;
  const listPath = tempFile('in.txt', token);
  const outPath = tempFile('out.txt', token);
  const scriptPath = tempFile('run.ps1', token);

  try {
    await fs.writeFile(listPath, requests.map(toLine).join('\n'), 'utf-8');
    await fs.writeFile(scriptPath, PS_SCRIPT, 'utf-8');
    // 앞선 실행의 결과가 남아 있으면 그것을 읽어 버린다.
    await fs.rm(outPath, { force: true });

    await new Promise<void>((resolve) => {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, listPath, outPath],
        { windowsHide: true, stdio: 'ignore' },
      );

      // 한 번만 풀리게 한다 — 타임아웃과 close 가 겹칠 수 있다.
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      /*
       * ⚠️ 타임아웃이 없으면 PowerShell 이 멎었을 때 **여기서 영영 기다린다.**
       *    최초 임포트가 끝나지 않고, 탐색기가 부른 경우엔 파이프 응답도 못 돌려준다.
       */
      const timer = setTimeout(() => {
        console.warn(`[icon] 추출 시간 초과 — ${requests.length}개, 프로세스를 종료한다`);
        child.kill();
        finish();
      }, timeoutFor(requests.length));

      // 실패해도 그냥 넘어간다 — 아이콘이 없는 것이 앱을 멈출 이유는 아니다.
      child.on('error', finish);
      child.on('close', finish);
    });

    const raw = await fs.readFile(outPath, 'utf-8').catch(() => '');

    for (const line of raw.split(/\r?\n/)) {
      const tab = line.indexOf('\t');
      if (tab === -1) continue;

      const index = Number.parseInt(line.slice(0, tab), 10);
      const b64 = line.slice(tab + 1).trim();
      if (!Number.isInteger(index) || index < 0 || index >= result.length) continue;
      if (b64 === '') continue;

      result[index] = `data:image/png;base64,${b64}`;
    }
  } catch (err) {
    console.error(`[icon] 일괄 추출 실패\n${err}`);
  } finally {
    await Promise.all([
      fs.rm(listPath, { force: true }),
      fs.rm(outPath, { force: true }),
      fs.rm(scriptPath, { force: true }),
    ]);
  }

  const ok = result.filter((x) => x !== undefined).length;
  console.log(`[icon] 일괄 추출 — 요청 ${requests.length}개 / 성공 ${ok}개`);
  return result;
}
