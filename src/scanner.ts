/**
 * Start Menu `Programs` 스캐너 — **메인 프로세스 전용**.
 *
 * 이 앱이 존재하는 이유가 여기 있다. 이 PC 프로필은 새로 설치한 앱이 시작 메뉴·검색에
 * 나타나지 않으므로, **`Start Menu\Programs` 아래의 `.lnk` 파일을 직접 읽는 것이 유일한 수집 경로다.**
 *
 * ⚠️ AppsFolder · CloudStore · AppResolver · StateRepository · `start2.bin` 을 절대 경유하지 않는다.
 *    그 경로들의 장애를 우회하는 것이 이 프로젝트의 목적이라 경유하는 순간 프로젝트가 무의미해진다.
 *
 * ⚠️ 원본 `.lnk` 는 **읽기 전용**이다. 이동·삭제·수정하지 않는다.
 *
 * `app.getPath()` · `app.getFileIcon()` 은 `ready` 이후에만 유효하므로
 * `scanStartMenu()` 도 `app.on('ready')` 뒤에 불러야 한다.
 */

import { app, shell } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractIcons, type IconRequest } from './icon-extractor';
import type { AppEntry } from './types';

/** 바로가기 확장자. 비교는 항상 소문자로 한다 (Windows 는 대소문자를 구분하지 않는다) */
const LNK_EXT = '.lnk';

/**
 * 스캔 대상 루트 2곳. **순서가 중복 제거 규칙의 일부다.**
 *
 * 중복 제거는 "먼저 만난 것을 남긴다"이고 사용자 폴더를 앞에 둔다.
 * 근거 — 같은 앱이 양쪽에 있을 때 사용자 폴더 쪽이 사용자가 직접 놓았거나 이름을 바꾼 사본일
 * 가능성이 높다. Windows 자신도 사용자별 시작 메뉴를 공용보다 우선해 다룬다.
 */
function startMenuRoots(): string[] {
  const user = path.join(
    app.getPath('appData'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
  );
  const common = path.join(
    process.env.ProgramData ?? 'C:\\ProgramData',
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
  );
  return [user, common];
}

/** 폴더가 실제로 존재하는지 */
async function dirExists(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    // 없거나 접근 불가 — 호출부가 조용히 건너뛴다
    return false;
  }
}

/**
 * 하위 폴더까지 재귀로 `.lnk` 를 전부 모은다. **필터를 걸지 않는다** —
 * 임포트 범위는 결과를 보고 사용자가 정한다 (`docs/DIRECTION.md` 5.1).
 *
 * 심볼릭 링크·정션은 따라가지 않는다 (`isDirectory()` 가 false 라 자연히 제외된다).
 * 순환 참조로 무한 재귀에 빠지는 것을 막아 준다.
 */
async function collectLnkFiles(dir: string): Promise<string[]> {
  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    console.warn(`[scanner] 폴더를 읽지 못했다 — ${dir}\n${err}`);
    return [];
  }

  // readdir 순서는 파일시스템에 달려 있다. 중복 제거가 "먼저 만난 것"을 남기므로
  // 실행마다 결과가 흔들리지 않도록 이름순으로 고정한다.
  dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const files: string[] = [];
  const subDirs: string[] = [];

  for (const dirent of dirents) {
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      subDirs.push(full);
    } else if (dirent.isFile() && dirent.name.toLowerCase().endsWith(LNK_EXT)) {
      files.push(full);
    }
  }

  for (const sub of subDirs) {
    files.push(...(await collectLnkFiles(sub)));
  }

  return files;
}

/**
 * 여러 항목의 아이콘을 한 번에 채운다. 채운 개수를 돌려준다.
 *
 * ⚠️ `.lnk` 를 다시 읽어 **`icon` / `iconIndex`** 를 가져온다. 탐색기가 아이콘을 고를 때
 *    가장 먼저 보는 값이고, 이걸 빼면 서로 무관한 앱들이 같은 그림이 된다
 *    (`SHELL32.dll` 을 공유하고 인덱스로만 갈리는 항목이 많다).
 *    자세한 실측은 `icon-extractor.ts` 머리말 참조.
 */
async function fillIcons(entries: AppEntry[]): Promise<number> {
  const requests: IconRequest[] = entries.map((entry) => {
    let iconPath = '';
    let iconIndex = 0;

    try {
      const details = shell.readShortcutLink(entry.lnkPath);
      iconPath = details.icon ?? '';
      iconIndex = details.iconIndex ?? 0;
    } catch {
      // `.lnk` 를 못 읽으면 target 폴백에 맡긴다. 여기서 실패해도 추출 자체는 계속된다.
    }

    return { iconPath, iconIndex, target: entry.target, lnkPath: entry.lnkPath };
  });

  const icons = await extractIcons(requests);

  let changed = 0;
  entries.forEach((entry, index) => {
    const next = icons[index];
    // 못 뽑았으면 기존 것을 유지한다. 있던 아이콘을 지우는 쪽이 더 나쁘다.
    if (next !== undefined && next !== entry.icon) {
      entry.icon = next;
      changed += 1;
    }
  });

  return changed;
}

/**
 * 이미 등록된 항목들의 아이콘만 다시 뽑는다. 바뀐 개수를 돌려준다.
 *
 * 재임포트와 다르다 — **배치·폴더·삭제 이력을 건드리지 않고 아이콘만** 갈아끼운다.
 * 추출 규칙이 바뀌었을 때(`AppConfig.iconRevision`) 쓰인다.
 */
export async function refreshIcons(entries: AppEntry[]): Promise<number> {
  return fillIcons(entries);
}

/**
 * `.lnk` 하나를 읽어 항목으로 만든다. 읽지 못하면 null.
 *
 * 탐색기 컨텍스트 메뉴에서 넘어온 파일을 등록할 때 쓴다 (`--toggle`).
 * `scanStartMenu()` 와 **같은 규칙**으로 만들어야 한다 — 특히 `id` 생성 방식이 다르면
 * 같은 파일이 두 번 등록되거나 제거가 안 된다.
 *
 * ⚠️ 원본 `.lnk` 는 읽기만 한다. 이 프로젝트의 핵심 규칙이다.
 */
export async function readShortcutEntry(lnkPath: string): Promise<AppEntry | null> {
  let details;
  try {
    details = shell.readShortcutLink(lnkPath);
  } catch (err) {
    console.warn(`[scanner] .lnk 를 읽지 못했다 — ${lnkPath}\n${err}`);
    return null;
  }

  const target = details.target ?? '';
  const fileName = path.basename(lnkPath);
  const name = fileName.toLowerCase().endsWith(LNK_EXT)
    ? fileName.slice(0, fileName.length - LNK_EXT.length)
    : fileName;

  const entry: AppEntry = {
    kind: 'app',
    id: entryId(lnkPath),
    name,
    target,
    args: details.args ?? '',
    lnkPath,
    icon: null,
  };

  await fillIcons([entry]);
  return entry;
}

/**
 * 항목 id. **`lnkPath` 하나만으로 정해진다.**
 * 같은 파일은 언제 어디서 읽어도 같은 id 가 나와야 등록·제거가 맞물린다.
 */
export function entryId(lnkPath: string): string {
  return crypto.createHash('sha1').update(lnkPath).digest('hex').slice(0, 12);
}

/**
 * 두 루트를 재귀 스캔해 `AppEntry[]` 를 만든다.
 *
 * 중복 제거 — 같은 `target` 이 둘 이상이면 **먼저 만난 것 하나만** 남긴다.
 * 순회 순서가 사용자 폴더 → 공용 폴더이므로 사용자 쪽이 이긴다 (`startMenuRoots()` 주석 참조).
 */
export async function scanStartMenu(): Promise<AppEntry[]> {
  const lnkPaths: string[] = [];

  for (const root of startMenuRoots()) {
    // 공용 폴더가 없는 환경이 있을 수 있다. 조용히 건너뛴다.
    if (!(await dirExists(root))) continue;

    const found = await collectLnkFiles(root);
    console.log(`[scanner] ${root} — ${found.length}개`);
    lnkPaths.push(...found);
  }

  const entries: AppEntry[] = [];
  const seenTargets = new Set<string>();
  let readFailures = 0;
  let duplicates = 0;

  for (const lnkPath of lnkPaths) {
    let details;
    try {
      details = shell.readShortcutLink(lnkPath);
    } catch (err) {
      readFailures += 1;
      console.warn(`[scanner] .lnk 를 읽지 못했다 — ${lnkPath}\n${err}`);
      continue;
    }

    const target = details.target ?? '';

    // target 이 빈 항목(특수 폴더 바로가기 등)은 중복 판정에서 뺀다.
    // 넣으면 전부 같은 키가 되어 서로를 지워 버린다.
    if (target !== '') {
      // Windows 경로는 대소문자를 구분하지 않으므로 키를 소문자로 맞춘다.
      const key = target.toLowerCase();
      if (seenTargets.has(key)) {
        duplicates += 1;
        continue;
      }
      seenTargets.add(key);
    }

    // 파일명은 이미 `.lnk` 로 끝나는 것이 확인됐다(대소문자 무관). 확장자 길이만큼 잘라낸다.
    const fileName = path.basename(lnkPath);

    entries.push({
      kind: 'app',
      id: entryId(lnkPath),
      name: fileName.slice(0, fileName.length - LNK_EXT.length),
      target,
      args: details.args ?? '',
      lnkPath,
      // 아이콘은 아래에서 한 번에 채운다.
      icon: null,
    });
  }

  // 아이콘은 PowerShell 을 한 번만 띄워 일괄 추출한다 (`icon-extractor.ts` 주석 참조).
  const filled = await fillIcons(entries);

  entries.sort((a, b) => a.name.localeCompare(b.name));

  console.log(
    `[scanner] 총 ${entries.length}개 ` +
      `(수집 ${lnkPaths.length} / 중복 제외 ${duplicates} / 읽기 실패 ${readFailures}) · ` +
      `아이콘 ${filled}개 확보`,
  );

  return entries;
}
