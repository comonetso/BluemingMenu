/**
 * 단축키 설정 창의 렌더러 UI — **렌더러 프로세스 전용**.
 *
 * 사용자가 키를 직접 눌러 조합을 정한다 (2026-08-18 결정: 프리셋 목록이 아니라 입력 창).
 *
 * ⚠️ 지금 훅(`native/hotkey`)은 **수식키 조합만** 인식한다. 일반 키가 섞인 조합
 *    (`Win+Space` 등)을 쓰려면 훅 쪽을 먼저 확장해야 한다. 그래서 여기서도 수식키만 받는다.
 */

import { t } from '../i18n';
import type { BluemingApi } from '../preload';

/** 표시·저장 순서를 고정한다. 같은 조합이 매번 같은 문자열이어야 비교가 된다 */
const MOD_ORDER = ['win', 'ctrl', 'alt', 'shift'] as const;
type Modifier = (typeof MOD_ORDER)[number];

/** 화면에 보일 이름. 고유명사에 가까워 번역하지 않는다 */
const MOD_LABEL: Record<Modifier, string> = {
  win: 'Win',
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
};

function bm(): BluemingApi {
  return (window as unknown as { bm: BluemingApi }).bm;
}

/** 저장 형식(`'win+alt'`)을 화면 표기(`'Win + Alt'`)로 */
function toLabel(combo: string): string {
  if (combo === '' || combo === 'none') return t('hotkey.none');
  return combo
    .split('+')
    .map((m) => MOD_LABEL[m as Modifier] ?? m)
    .join(' + ');
}

/**
 * 지금 눌려 있는 수식키를 조합 문자열로.
 *
 * `metaKey` 가 Win 키다. 수식키 자신을 누른 순간에는 대응하는 `*Key` 플래그가 아직
 * false 인 경우가 있어 `e.key` 도 함께 본다.
 */
function comboFromEvent(e: KeyboardEvent): string {
  const active = new Set<Modifier>();

  if (e.metaKey || e.key === 'Meta' || e.key === 'OS') active.add('win');
  if (e.ctrlKey || e.key === 'Control') active.add('ctrl');
  if (e.altKey || e.key === 'Alt') active.add('alt');
  if (e.shiftKey || e.key === 'Shift') active.add('shift');

  return MOD_ORDER.filter((m) => active.has(m)).join('+');
}

/** 수식키인가 */
function isModifierKey(key: string): boolean {
  return key === 'Meta' || key === 'OS' || key === 'Control' || key === 'Alt' || key === 'Shift';
}

export function mountHotkeyDialog(root: HTMLElement): void {
  /** 저장 대상. 사용자가 키를 떼면 확정된다 */
  let pending = '';

  root.replaceChildren();

  const box = document.createElement('div');
  box.className = 'bm-hotkey';

  const hint = document.createElement('p');
  hint.className = 'bm-hotkey-hint';
  hint.textContent = t('hotkey.hint');

  const display = document.createElement('div');
  display.className = 'bm-hotkey-combo';

  const warn = document.createElement('p');
  warn.className = 'bm-hotkey-warn';
  // 자리를 항상 차지하게 둔다. 경고가 뜰 때마다 창 내용이 들썩이면 눈에 거슬린다.
  warn.textContent = ' ';

  const actions = document.createElement('div');
  actions.className = 'bm-hotkey-actions';

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'bm-hotkey-btn';
  clearBtn.textContent = t('hotkey.clear');

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'bm-hotkey-btn bm-hotkey-primary';
  saveBtn.textContent = t('hotkey.save');

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'bm-hotkey-btn';
  cancelBtn.textContent = t('hotkey.cancel');

  actions.append(clearBtn, saveBtn, cancelBtn);
  box.append(hint, display, warn, actions);
  root.appendChild(box);

  const render = (): void => {
    display.textContent = toLabel(pending);
    saveBtn.disabled = false;
  };

  // 현재 값으로 시작한다. 아무 키도 안 누르고 저장하면 그대로 유지된다.
  void bm()
    .hotkey.get()
    .then((current) => {
      pending = current;
      render();
    });

  window.addEventListener('keydown', (e) => {
    // Esc 는 조합이 아니라 취소다.
    if (e.key === 'Escape') {
      e.preventDefault();
      void bm().hotkey.close();
      return;
    }

    e.preventDefault();

    if (!isModifierKey(e.key)) {
      // 일반 키는 지금 훅이 못 잡는다. 조합을 바꾸지 않고 안내만 한다.
      warn.textContent = t('hotkey.modifierOnly');
      return;
    }

    warn.textContent = ' ';
    const combo = comboFromEvent(e);
    if (combo !== '') {
      pending = combo;
      render();
    }
  });

  // 키를 떼는 것으로 확정한다. 떼면서 조합이 줄어드는 것을 반영하면 안 되므로
  // `keyup` 에서는 표시를 갱신하지 않는다.
  window.addEventListener('keyup', (e) => {
    e.preventDefault();
  });

  clearBtn.addEventListener('click', () => {
    pending = 'none';
    warn.textContent = ' ';
    render();
  });

  saveBtn.addEventListener('click', () => {
    void bm().hotkey.set(pending);
  });

  cancelBtn.addEventListener('click', () => {
    void bm().hotkey.close();
  });
}
