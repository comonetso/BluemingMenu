//! Blueming Menu 전역 단축키 감시 프로세스.
//!
//! # 왜 별도 프로세스인가
//! Electron 의 `globalShortcut` 은 **수식키만으로 이뤄진 조합을 등록할 수 없다.**
//! `Win+Alt` 처럼 일반 키가 없는 조합을 잡으려면 저수준 키보드 훅(`WH_KEYBOARD_LL`)이 필요하고,
//! 그건 네이티브 코드여야 한다. Node 네이티브 모듈로 만들면 Electron 메인 스레드에서 돌아
//! 훅 타임아웃 위험이 커지므로, **아무 일도 하지 않는 작은 프로세스**로 분리했다.
//!
//! # ⚠️ 절대 지킬 것 두 가지
//!
//! ### 1. 키 입력을 삼키지 않는다
//! `CallNextHookEx` 를 **언제나** 호출한다. 삼키는 순간
//!   - `Win+E` · `Win+R` 같은 조합이 전부 죽고
//!   - down 만 막고 up 을 흘리면 수식키가 **눌린 상태로 고착**된다
//! (`docs/DIRECTION.md` 3.3 에 이 함정이 정리돼 있다)
//!
//! 우리는 감시만 한다. "다른 키 없이 지정한 수식키만 눌렀다 뗐다" 를 판정할 뿐이다.
//!
//! ### 2. 훅 콜백 안에서 I/O 를 하지 않는다
//! 콜백이 `LowLevelHooksTimeout`(기본 300ms)을 넘기면 **Windows 가 훅을 조용히 해제한다.**
//! 그러면 단축키가 아무 예고 없이 먹통이 된다.
//! 그래서 콜백은 원자 변수만 만지고, 실제 파이프 전송은 `PostThreadMessageW` 로 넘겨
//! 메시지 루프에서 처리한다.

#![windows_subsystem = "windows"]

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE, LPARAM, LRESULT, WPARAM};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, WriteFile, FILE_FLAGS_AND_ATTRIBUTES, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
    FILE_SHARE_NONE, OPEN_EXISTING,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{
    OpenProcess, WaitForSingleObject, INFINITE, PROCESS_SYNCHRONIZE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, PostThreadMessageW, SetWindowsHookExW,
    UnhookWindowsHookEx, HHOOK, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_APP, WM_KEYDOWN,
    WM_KEYUP, WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

/// 파이프 이름. **`src/pipe.ts` 의 `PIPE_PATH` 와 반드시 같아야 한다.**
const PIPE_NAME: PCWSTR = w!(r"\\.\pipe\blueming-menu");

/// 훅 콜백이 메시지 루프에 "발동했다" 를 알릴 때 쓰는 메시지.
const WM_HOTKEY_FIRED: u32 = WM_APP + 1;

// ─────────────────────────────────────────────────────────────
// 감시할 수식키
// ─────────────────────────────────────────────────────────────

/// 수식키 종류. 좌/우를 구분하지 않는다 — 사용자는 왼쪽 Alt 든 오른쪽 Alt 든 같게 여긴다.
const MOD_WIN: u32 = 1 << 0;
const MOD_ALT: u32 = 1 << 1;
const MOD_CTRL: u32 = 1 << 2;
const MOD_SHIFT: u32 = 1 << 3;

/// 가상 키 코드를 수식키 비트로. 수식키가 아니면 `None`.
fn modifier_bit(vk: u32) -> Option<u32> {
    match vk {
        0x5B | 0x5C => Some(MOD_WIN),           // LWIN / RWIN
        0x12 | 0xA4 | 0xA5 => Some(MOD_ALT),    // MENU / LMENU / RMENU
        0x11 | 0xA2 | 0xA3 => Some(MOD_CTRL),   // CONTROL / LCONTROL / RCONTROL
        0x10 | 0xA0 | 0xA1 => Some(MOD_SHIFT),  // SHIFT / LSHIFT / RSHIFT
        _ => None,
    }
}

/// `"win+alt"` 같은 문자열을 비트마스크로. 알 수 없는 이름은 무시한다.
fn parse_combo(text: &str) -> u32 {
    let mut mask = 0;
    for part in text.split('+') {
        match part.trim().to_ascii_lowercase().as_str() {
            "win" | "meta" | "super" => mask |= MOD_WIN,
            "alt" => mask |= MOD_ALT,
            "ctrl" | "control" => mask |= MOD_CTRL,
            "shift" => mask |= MOD_SHIFT,
            _ => {}
        }
    }
    mask
}

// ─────────────────────────────────────────────────────────────
// 상태 (훅 콜백이 만지므로 전부 원자 변수)
// ─────────────────────────────────────────────────────────────

/// 감시 대상 조합
static TARGET_MASK: AtomicU32 = AtomicU32::new(0);
/// 지금 눌려 있는 수식키
static PRESSED_MASK: AtomicU32 = AtomicU32::new(0);
/// 조합이 완성된 적이 있는가 (전부 눌렸던 순간이 있었나)
static ARMED: AtomicBool = AtomicBool::new(false);
/// 이번 누름 동안 **다른 키**가 섞였는가. 섞였으면 발동하지 않는다
static POLLUTED: AtomicBool = AtomicBool::new(false);
/// 메시지를 받을 스레드
static MAIN_THREAD: AtomicU32 = AtomicU32::new(0);

// ─────────────────────────────────────────────────────────────
// 훅
// ─────────────────────────────────────────────────────────────

unsafe extern "system" fn keyboard_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    // code < 0 이면 처리하지 말고 그대로 넘기라는 뜻이다 (문서 규정).
    if code >= 0 {
        let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        let vk = info.vkCode;
        let target = TARGET_MASK.load(Ordering::Relaxed);
        let message = wparam.0 as u32;

        let is_down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
        let is_up = message == WM_KEYUP || message == WM_SYSKEYUP;

        if is_down {
            match modifier_bit(vk) {
                Some(bit) => {
                    let now = PRESSED_MASK.fetch_or(bit, Ordering::Relaxed) | bit;
                    // 감시 대상이 아닌 수식키가 섞여도 "다른 키" 로 친다.
                    // 예: Win+Alt 를 기다리는데 Shift 까지 눌렀으면 사용자의 의도가 다르다.
                    if bit & target == 0 {
                        POLLUTED.store(true, Ordering::Relaxed);
                    } else if now & target == target && !POLLUTED.load(Ordering::Relaxed) {
                        ARMED.store(true, Ordering::Relaxed);
                    }
                }
                // 일반 키가 눌렸다 → 이번 누름은 단축키가 아니다.
                None => POLLUTED.store(true, Ordering::Relaxed),
            }
        } else if is_up {
            if let Some(bit) = modifier_bit(vk) {
                let now = PRESSED_MASK.fetch_and(!bit, Ordering::Relaxed) & !bit;

                // 수식키가 **전부** 떨어진 순간에만 판정한다.
                if now == 0 {
                    let fire = ARMED.load(Ordering::Relaxed) && !POLLUTED.load(Ordering::Relaxed);
                    ARMED.store(false, Ordering::Relaxed);
                    POLLUTED.store(false, Ordering::Relaxed);

                    if fire {
                        // ⚠️ 여기서 파이프를 열지 마라. 훅 콜백이 늦으면 Windows 가 훅을 해제한다.
                        //    메시지만 던지고 즉시 빠져나간다.
                        let tid = MAIN_THREAD.load(Ordering::Relaxed);
                        if tid != 0 {
                            let _ = PostThreadMessageW(tid, WM_HOTKEY_FIRED, WPARAM(0), LPARAM(0));
                        }
                    }
                }
            }
        }
    }

    // ⚠️ 언제나 다음 훅으로 넘긴다. 삼키면 Win 조합이 죽고 수식키가 고착된다.
    CallNextHookEx(None, code, wparam, lparam)
}

// ─────────────────────────────────────────────────────────────
// 파이프
// ─────────────────────────────────────────────────────────────

/// 앱에 한 줄 보낸다. 앱이 꺼져 있으면 조용히 실패한다 (그게 정상 상황이다).
fn notify_app(line: &str) {
    unsafe {
        let handle: HANDLE = match CreateFileW(
            PIPE_NAME,
            (FILE_GENERIC_READ | FILE_GENERIC_WRITE).0,
            FILE_SHARE_NONE,
            None,
            OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(0),
            None,
        ) {
            Ok(h) if h != INVALID_HANDLE_VALUE => h,
            _ => return,
        };

        let payload = format!("{line}\n");
        let mut written = 0u32;
        let _ = WriteFile(handle, Some(payload.as_bytes()), Some(&mut written), None);
        let _ = CloseHandle(handle);
    }
}

// ─────────────────────────────────────────────────────────────
// 진입점
// ─────────────────────────────────────────────────────────────

/**
 * 부모(앱)가 죽으면 우리도 끝낸다.
 *
 * ⚠️ Windows 에서 부모가 크래시해도 자식은 자동으로 죽지 않는다. 그대로 두면 이 프로세스가
 *    **고아로 남아 키보드 훅을 계속 물고 있고**, 앱을 다시 켜면 옛 훅과 새 훅이 같은 파이프에
 *    신호를 보내 패널이 두 번 토글된다. (Codex 리뷰 2026-08-18 지적)
 *
 * 부모 핸들이 시그널되면(= 프로세스 종료) 메시지 루프에 종료를 알린다.
 * 감시 전용 스레드라 훅 콜백의 타이밍에 영향을 주지 않는다.
 */
fn watch_parent(parent_pid: u32, main_thread: u32) {
    std::thread::spawn(move || unsafe {
        let handle = match OpenProcess(PROCESS_SYNCHRONIZE, false, parent_pid) {
            Ok(h) => h,
            // 이미 죽었거나 열 수 없으면 감시할 것이 없다. 훅은 그대로 두고 넘어간다.
            Err(_) => return,
        };

        // 부모가 끝날 때까지 무한정 기다린다. 폴링이 아니므로 간격 값을 지어낼 필요가 없다.
        WaitForSingleObject(handle, INFINITE);
        let _ = CloseHandle(handle);

        let _ = PostThreadMessageW(main_thread, WM_QUIT, WPARAM(0), LPARAM(0));
    });
}

fn main() {
    // 인자로 조합을 받는다. 없으면 아무것도 감시하지 않는다 —
    // 기본값을 여기서 지어내지 않는다. 정책은 앱(설정)이 정한다.
    let combo = std::env::args().nth(1).unwrap_or_default();
    let mask = parse_combo(&combo);
    if mask == 0 {
        return;
    }
    TARGET_MASK.store(mask, Ordering::Relaxed);

    // `--parent-pid <PID>` (선택). 주면 그 프로세스가 끝날 때 우리도 끝낸다.
    let args: Vec<String> = std::env::args().collect();
    let parent_pid = args
        .iter()
        .position(|a| a == "--parent-pid")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse::<u32>().ok());

    unsafe {
        let main_thread = windows::Win32::System::Threading::GetCurrentThreadId();
        MAIN_THREAD.store(main_thread, Ordering::Relaxed);

        if let Some(pid) = parent_pid {
            watch_parent(pid, main_thread);
        }

        let module = GetModuleHandleW(None).unwrap_or_default();
        let hook: HHOOK = match SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), module, 0) {
            Ok(h) => h,
            Err(_) => return,
        };

        // 훅은 메시지 루프가 돌아야 콜백이 불린다.
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if msg.message == WM_HOTKEY_FIRED {
                notify_app("HOTKEY\tTOGGLE");
                continue;
            }
            DispatchMessageW(&msg);
        }

        let _ = UnhookWindowsHookEx(hook);
    }
}
