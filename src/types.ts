/**
 * 메인 · 렌더러가 함께 쓰는 순수 타입.
 *
 * ⚠️ 이 파일에서 `electron` 을 import 하지 마라. 렌더러가 이 파일을 읽는다.
 */

import type { Locale } from './i18n';

/** 그리드에 놓이는 앱 하나 */
export interface AppEntry {
  kind: 'app';
  id: string;
  /** 표시 이름. `.lnk` 파일명에서 확장자를 뗀 것 */
  name: string;
  /** 실행 대상 경로 */
  target: string;
  /** 실행 인자 */
  args: string;
  /** 원본 `.lnk` 경로. **읽기 전용이며 이 앱은 절대 수정·이동하지 않는다** */
  lnkPath: string;
  /** 추출한 아이콘 (data URL). 추출 실패 시 null */
  icon: string | null;
}

/**
 * 폴더. 아이콘 위에 다른 아이콘을 떨구면 즉시 만들어진다.
 * "별도로 폴더를 만들지 않는 구조" — 사용자 지정 (2026-08-18)
 */
export interface FolderEntry {
  kind: 'folder';
  id: string;
  name: string;
  children: AppEntry[];
}

export type GridEntry = AppEntry | FolderEntry;

/** 플로팅 아이콘 상태 */
export interface FloatingState {
  /** 사용자가 드래그해 옮긴 좌표. 한 번도 안 옮겼으면 null */
  x: number | null;
  y: number | null;
  visible: boolean;
}

/** 디스크에 저장되는 전체 설정 */
export interface AppConfig {
  version: number;
  locale: Locale;
  cols: number;
  rows: number;
  floating: FloatingState;
  /** 그리드 배치 순서 그대로. 인덱스가 곧 위치다 */
  items: GridEntry[];
  /** `Start Menu\Programs` 최초 임포트를 마쳤는가 */
  imported: boolean;

  /**
   * 아이콘 추출 **규칙**의 버전.
   *
   * 추출 방식이 바뀌면 이 값을 올린다. 앱이 뜰 때 저장된 값이 낮으면 **아이콘만** 다시 뽑는다.
   * 재임포트와 달리 사용자가 만든 배치·폴더·삭제 이력이 보존된다.
   */
  iconRevision: number;

  /**
   * 전역 단축키 조합. `'win+alt'` 처럼 `+` 로 잇는다. `'none'` 이면 쓰지 않는다.
   *
   * 수식키만으로 이뤄진 조합도 된다 — `native/hotkey` 프로세스가 저수준 훅으로 잡기 때문이다.
   * Electron 의 `globalShortcut` 은 그런 조합을 등록조차 못 한다.
   */
  hotkey: string;
}

/** 렌더러에 내려보내는 화면 구성 정보 */
export interface GridPayload {
  cols: number;
  rows: number;
  items: GridEntry[];
  locale: Locale;
}
