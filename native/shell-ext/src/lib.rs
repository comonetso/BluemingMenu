//! Blueming Menu 탐색기 컨텍스트 메뉴 핸들러.
//!
//! # 이게 왜 필요한가
//! Windows 11 의 **1급** 우클릭 메뉴(잘라내기·복사 아래 영역)에 항목을 넣으려면
//! `IExplorerCommand` COM 핸들러가 있어야 한다. 레지스트리 `shell\<verb>` 방식으로 넣은
//! 항목은 "추가 옵션 표시" 하위로 밀려난다. 반디집·PowerToys·VS Code 전부 이 방식을 쓴다
//! (실측 확인: 셋 다 `SignatureKind=Developer` 인 MSIX 패키지로 등록돼 있다).
//!
//! # 왜 Electron 이 아니라 DLL 인가
//! 메뉴를 그리는 주체는 `explorer.exe` 다. 우클릭하는 순간 탐색기가 이 DLL 을 **자기 프로세스에**
//! 로드해서 "이 파일에 어떤 항목이 있나" 를 묻는다. 그 자리에 Electron 앱은 없다.
//! Node 네이티브 모듈(N-API)은 Node 런타임 안에서만 사니 여기 쓸 수 없다.
//!
//! # 앱과의 통신
//! named pipe `\\.\pipe\blueming-menu` 한 줄 요청 / 한 줄 응답.
//! ```text
//!   QUERY\t<경로>   →  ADDED | ABSENT
//!   TOGGLE\t<경로>  →  ADDED | REMOVED | ERROR
//! ```
//! **파이프에 붙지 못하면 앱이 꺼져 있는 것이고, 그때는 메뉴 항목을 숨긴다.**
//! (사용자 지정: "앱이 켜져 있을 때만") 파이프는 프로세스와 수명을 같이하므로
//! lock 파일과 달리 비정상 종료 뒤 찌꺼기가 남지 않는다.

#![allow(non_snake_case)]

use std::ffi::c_void;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};

use windows::core::{implement, w, Interface, Result, GUID, HRESULT, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, BOOL, CLASS_E_CLASSNOTAVAILABLE, E_FAIL, E_POINTER, HANDLE, HMODULE,
    INVALID_HANDLE_VALUE, S_FALSE, S_OK, TRUE,
};
use windows::Win32::System::LibraryLoader::GetModuleFileNameW;

/// `DllMain` 의 호출 사유. `Win32_System_SystemServices` feature 를 켜면 얻을 수 있지만,
/// 상수 하나 때문에 의존 범위를 넓히지 않는다. 값은 winnt.h 에 고정돼 있다.
const DLL_PROCESS_ATTACH: u32 = 1;
use windows::Win32::System::Pipes::{SetNamedPipeHandleState, PIPE_NOWAIT, PIPE_READMODE_BYTE};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_FLAGS_AND_ATTRIBUTES, FILE_GENERIC_READ,
    FILE_GENERIC_WRITE, FILE_SHARE_NONE, OPEN_EXISTING,
};
use windows::Win32::System::Com::{IBindCtx, IClassFactory, IClassFactory_Impl};
use windows::Win32::UI::Shell::{
    IEnumExplorerCommand, IExplorerCommand, IExplorerCommand_Impl, IShellItemArray, SHStrDupW,
    ECS_ENABLED, ECS_HIDDEN, SIGDN_FILESYSPATH,
};

/// 이 핸들러의 CLSID. **`AppxManifest.xml` 의 `Clsid` 와 반드시 같아야 한다.**
/// 한쪽만 바꾸면 탐색기가 핸들러를 못 찾아 메뉴가 조용히 사라진다.
pub const CLSID_BLUEMING_COMMAND: GUID = GUID::from_u128(0x7f3a9c21_4e6b_4d8a_9f12_5c8e7a2b6d40);

/// 파이프 이름. **`src/pipe.ts` 의 `PIPE_PATH` 와 반드시 같아야 한다.**
const PIPE_NAME: PCWSTR = w!(r"\\.\pipe\blueming-menu");

/// 살아 있는 COM 객체 수. 0 이 되어야 탐색기가 DLL 을 내려도 된다.
static OBJECT_COUNT: AtomicU32 = AtomicU32::new(0);

/**
 * 앱 응답을 기다리는 한계 시간.
 *
 * ⚠️ **임의값이다.** "탐색기가 멈춘 것처럼 느껴지지 않을 만큼" 이라는 체감 기준뿐이라
 *    실측으로 정할 수 없다. 앱 쪽 응답은 메모리 조회라 정상일 때는 즉시 돌아온다 —
 *    이 값은 **앱이 멎었을 때 얼마나 빨리 포기하는가**를 정한다.
 */
const PIPE_TIMEOUT: Duration = Duration::from_millis(500);

/// 논블로킹 읽기 재시도 간격. 위와 같은 이유로 임의값이다.
const PIPE_POLL: Duration = Duration::from_millis(10);

/// 이 DLL 의 모듈 핸들. `DllMain` 에서 채운다.
///
/// 메뉴 아이콘 경로를 만들려면 DLL 이 **자기가 어디 있는지** 알아야 한다.
/// 탐색기 프로세스에 로드되므로 현재 실행 파일 경로(=explorer.exe)는 쓸 수 없다.
static DLL_MODULE: AtomicUsize = AtomicUsize::new(0);

/// DLL 이 놓인 폴더. 실패하면 `None`.
fn module_dir() -> Option<PathBuf> {
    let handle = DLL_MODULE.load(Ordering::SeqCst);
    if handle == 0 {
        return None;
    }

    let mut buf = [0u16; 260]; // MAX_PATH
    let len = unsafe { GetModuleFileNameW(HMODULE(handle as *mut c_void), &mut buf) };
    if len == 0 {
        return None;
    }

    let path = PathBuf::from(String::from_utf16_lossy(&buf[..len as usize]));
    path.parent().map(|p| p.to_path_buf())
}

// ─────────────────────────────────────────────────────────────
// 파이프 통신
// ─────────────────────────────────────────────────────────────

/// 앱에 한 줄 보내고 한 줄 받는다. 앱이 없거나 실패하면 `None`.
///
/// ⚠️ 탐색기는 `GetTitle`/`GetState` 를 **동기로 기다린다.** 여기서 오래 끌면 우클릭 메뉴
///    자체가 멈춘다. 앱 쪽 응답은 메모리 조회뿐이라 즉시 돌아오지만, 앱이 멎으면
///    `ReadFile` 이 블로킹된다. 그래서 파이프를 **비동기(overlapped) 없이** 열되
///    `CreateFileW` 가 실패하면(=앱 꺼짐) 즉시 포기한다.
fn pipe_request(request: &str) -> Option<String> {
    unsafe {
        let handle: HANDLE = CreateFileW(
            PIPE_NAME,
            (FILE_GENERIC_READ | FILE_GENERIC_WRITE).0,
            FILE_SHARE_NONE,
            None,
            OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(0),
            None,
        )
        .ok()?;

        if handle == INVALID_HANDLE_VALUE {
            return None;
        }

        /*
         * ⚠️ **시간 제한을 반드시 건다.**
         * 탐색기는 `GetTitle`/`Invoke` 를 동기로 기다린다. 앱이 멎었거나 응답이 늦으면
         * 이 `ReadFile` 이 영영 돌아오지 않고 **우클릭 메뉴 전체가 멈춘다.**
         * `CreateFileW` 성공은 "연결됐다"만 보장하지 응답을 보장하지 않는다.
         * (Codex 리뷰 2026-08-18 지적)
         *
         * 파이프 핸들에 읽기/쓰기 타임아웃을 직접 걸 수는 없으므로, 파이프를 **논블로킹 모드**로
         * 두고 짧게 폴링한다. 앱 쪽 응답은 메모리 조회뿐이라 정상일 때는 첫 시도에 돌아온다.
         */
        let mut mode = PIPE_READMODE_BYTE | PIPE_NOWAIT;
        let _ = SetNamedPipeHandleState(handle, Some(&mut mode), None, None);

        let payload = format!("{request}\n");
        let mut written = 0u32;
        let write_ok = WriteFile(handle, Some(payload.as_bytes()), Some(&mut written), None).is_ok();

        let mut reply: Option<String> = None;
        if write_ok {
            let mut buf = [0u8; 64];
            let deadline = Instant::now() + PIPE_TIMEOUT;

            loop {
                let mut read = 0u32;
                if ReadFile(handle, Some(&mut buf), Some(&mut read), None).is_ok() && read > 0 {
                    reply = Some(
                        String::from_utf8_lossy(&buf[..read as usize])
                            .trim()
                            .to_string(),
                    );
                    break;
                }

                if Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(PIPE_POLL);
            }
        }

        let _ = CloseHandle(handle);
        reply
    }
}

/// 앱이 켜져 있는가. 파이프를 열 수 있으면 켜져 있는 것이다.
fn app_running() -> bool {
    unsafe {
        let handle = CreateFileW(
            PIPE_NAME,
            (FILE_GENERIC_READ | FILE_GENERIC_WRITE).0,
            FILE_SHARE_NONE,
            None,
            OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(0),
            None,
        );

        match handle {
            Ok(h) if h != INVALID_HANDLE_VALUE => {
                let _ = CloseHandle(h);
                true
            }
            _ => false,
        }
    }
}

// ─────────────────────────────────────────────────────────────
// 선택된 항목 경로 얻기
// ─────────────────────────────────────────────────────────────

/// 선택된 첫 항목의 파일시스템 경로. 항목이 없거나 파일이 아니면 `None`.
///
/// 여러 개를 선택했어도 **첫 번째만** 다룬다. 토글은 파일 하나 단위 동작이고,
/// 여러 개를 한 번에 처리하면 "어떤 문구를 보여줄지"(등록/제거)가 정해지지 않는다.
fn first_item_path(items: Option<&IShellItemArray>) -> Option<String> {
    let array = items?;
    unsafe {
        let count = array.GetCount().ok()?;
        if count == 0 {
            return None;
        }
        let item = array.GetItemAt(0).ok()?;
        let raw = item.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
        let path = raw.to_string().ok()?;
        windows::Win32::System::Com::CoTaskMemFree(Some(raw.0 as *const c_void));
        Some(path)
    }
}

/// `.lnk` 인가. 이 메뉴는 바로가기에만 붙인다 (사용자 지정).
fn is_lnk(path: &str) -> bool {
    path.len() >= 4 && path[path.len() - 4..].eq_ignore_ascii_case(".lnk")
}

/// COM 이 소유권을 가져가는 문자열로 복제한다.
fn dup_string(text: PCWSTR) -> Result<PWSTR> {
    unsafe { SHStrDupW(text) }
}

// ─────────────────────────────────────────────────────────────
// IExplorerCommand
// ─────────────────────────────────────────────────────────────

#[implement(IExplorerCommand)]
struct BluemingCommand;

impl Drop for BluemingCommand {
    fn drop(&mut self) {
        OBJECT_COUNT.fetch_sub(1, Ordering::SeqCst);
    }
}

impl IExplorerCommand_Impl for BluemingCommand_Impl {
    /// 메뉴에 보일 문구.
    ///
    /// **여기가 레지스트리 방식으로는 불가능한 부분이다.** 대상 파일이 이미 등록됐는지
    /// 앱에 물어서 문구를 바꾼다 — 사용자 요구가 "없으면 추가, 있으면 제거" 였다.
    fn GetTitle(&self, psiitemarray: Option<&IShellItemArray>) -> Result<PWSTR> {
        let path = match first_item_path(psiitemarray) {
            Some(p) => p,
            None => return dup_string(w!("Blueming Menu")),
        };

        match pipe_request(&format!("QUERY\t{path}")).as_deref() {
            Some("ADDED") => dup_string(w!("Blueming Menu 에서 제거")),
            _ => dup_string(w!("Blueming Menu 에 등록")),
        }
    }

    /// 메뉴 아이콘.
    ///
    /// DLL 과 같은 폴더의 `icon.ico` 를 가리킨다. 탐색기 프로세스에 로드되므로
    /// 현재 실행 파일 기준 경로는 쓸 수 없다 — `DllMain` 에서 잡아 둔 모듈 핸들로 찾는다.
    ///
    /// 파일이 없으면 `Err` 를 돌려 **아이콘 없이** 그리게 한다. 없는 경로를 주면
    /// 탐색기가 빈 칸을 그리거나 아이콘 로딩에서 지연이 생긴다.
    fn GetIcon(&self, _psiitemarray: Option<&IShellItemArray>) -> Result<PWSTR> {
        let icon = module_dir()
            .map(|dir| dir.join("icon.ico"))
            .filter(|p| p.exists())
            .ok_or_else(|| windows::core::Error::from(E_FAIL))?;

        let wide = HSTRING::from(icon.as_os_str());
        dup_string(PCWSTR(wide.as_ptr()))
    }

    fn GetToolTip(&self, _psiitemarray: Option<&IShellItemArray>) -> Result<PWSTR> {
        Err(E_FAIL.into())
    }

    fn GetCanonicalName(&self) -> Result<GUID> {
        Ok(GUID::zeroed())
    }

    /// 항목을 보일지 말지.
    ///
    /// 두 경우에 숨긴다.
    ///   1. **앱이 꺼져 있을 때** — 사용자 지정: "앱이 켜져 있을 때만"
    ///   2. 대상이 `.lnk` 가 아닐 때
    fn GetState(&self, psiitemarray: Option<&IShellItemArray>, _foktobeslow: BOOL) -> Result<u32> {
        if !app_running() {
            return Ok(ECS_HIDDEN.0 as u32);
        }

        match first_item_path(psiitemarray) {
            Some(path) if is_lnk(&path) => Ok(ECS_ENABLED.0 as u32),
            _ => Ok(ECS_HIDDEN.0 as u32),
        }
    }

    /// 클릭됐다. 앱에 토글을 시킨다.
    ///
    /// 응답을 기다리지만 앱 쪽 처리는 메모리 조작 + 파일 한 번 쓰기라 즉시 끝난다.
    fn Invoke(&self, psiitemarray: Option<&IShellItemArray>, _pbc: Option<&IBindCtx>) -> Result<()> {
        let path = first_item_path(psiitemarray).ok_or_else(|| windows::core::Error::from(E_FAIL))?;

        match pipe_request(&format!("TOGGLE\t{path}")).as_deref() {
            Some("ADDED") | Some("REMOVED") => Ok(()),
            _ => Err(E_FAIL.into()),
        }
    }

    /// 하위 메뉴 없는 단일 항목.
    fn GetFlags(&self) -> Result<u32> {
        Ok(0)
    }

    fn EnumSubCommands(&self) -> Result<IEnumExplorerCommand> {
        Err(E_FAIL.into())
    }
}

// ─────────────────────────────────────────────────────────────
// IClassFactory + DLL 진입점
// ─────────────────────────────────────────────────────────────

/**
 * ⚠️ 팩토리도 **살아 있는 COM 객체다.** 카운트에 넣지 않으면, 명령 객체가 없는 동안
 *    COM 이 팩토리 참조를 들고 있어도 `DllCanUnloadNow` 가 `S_OK` 를 돌려준다.
 *    그 뒤 팩토리를 호출하면 **이미 언로드된 DLL** 을 가리킨다.
 *    (Codex 리뷰 2026-08-18 지적)
 */
#[implement(IClassFactory)]
struct BluemingFactory;

impl Drop for BluemingFactory {
    fn drop(&mut self) {
        OBJECT_COUNT.fetch_sub(1, Ordering::SeqCst);
    }
}

impl IClassFactory_Impl for BluemingFactory_Impl {
    fn CreateInstance(
        &self,
        punkouter: Option<&windows::core::IUnknown>,
        riid: *const GUID,
        ppvobject: *mut *mut c_void,
    ) -> Result<()> {
        if ppvobject.is_null() {
            return Err(E_POINTER.into());
        }
        unsafe { *ppvobject = std::ptr::null_mut() };

        // 집합(aggregation)은 지원하지 않는다.
        if punkouter.is_some() {
            return Err(windows::Win32::Foundation::CLASS_E_NOAGGREGATION.into());
        }

        OBJECT_COUNT.fetch_add(1, Ordering::SeqCst);
        let command: IExplorerCommand = BluemingCommand.into();
        unsafe { command.query(&*riid, ppvobject).ok() }
    }

    fn LockServer(&self, flock: BOOL) -> Result<()> {
        if flock.as_bool() {
            OBJECT_COUNT.fetch_add(1, Ordering::SeqCst);
        } else {
            OBJECT_COUNT.fetch_sub(1, Ordering::SeqCst);
        }
        Ok(())
    }
}

/// COM 표준 진입점. 탐색기가 이 함수로 클래스 팩토리를 얻는다.
#[no_mangle]
pub unsafe extern "system" fn DllGetClassObject(
    rclsid: *const GUID,
    riid: *const GUID,
    ppv: *mut *mut c_void,
) -> HRESULT {
    if ppv.is_null() {
        return E_POINTER;
    }
    *ppv = std::ptr::null_mut();

    if rclsid.is_null() || *rclsid != CLSID_BLUEMING_COMMAND {
        return CLASS_E_CLASSNOTAVAILABLE;
    }

    // 팩토리도 카운트에 넣는다 (위 Drop 과 짝). 이게 없으면 팩토리만 살아 있는 동안
    // DLL 이 언로드될 수 있다.
    OBJECT_COUNT.fetch_add(1, Ordering::SeqCst);

    let factory: IClassFactory = BluemingFactory.into();
    match factory.query(&*riid, ppv) {
        S_OK => S_OK,
        hr => hr,
    }
}

/// DLL 진입점. **모듈 핸들을 잡아두는 것이 유일한 목적**이다 (아이콘 경로 계산용).
///
/// ⚠️ 여기서 무거운 일을 하지 마라. 탐색기가 DLL 을 로드하는 중에 불리고,
///    로더 락을 쥔 상태라 COM 호출이나 파일 I/O 를 하면 교착에 빠질 수 있다.
#[no_mangle]
pub extern "system" fn DllMain(hinst: HMODULE, reason: u32, _reserved: *mut c_void) -> BOOL {
    if reason == DLL_PROCESS_ATTACH {
        DLL_MODULE.store(hinst.0 as usize, Ordering::SeqCst);
    }
    TRUE
}

/// 살아 있는 객체가 없으면 DLL 을 내려도 된다고 알린다.
#[no_mangle]
pub extern "system" fn DllCanUnloadNow() -> HRESULT {
    if OBJECT_COUNT.load(Ordering::SeqCst) == 0 {
        S_OK
    } else {
        S_FALSE
    }
}
