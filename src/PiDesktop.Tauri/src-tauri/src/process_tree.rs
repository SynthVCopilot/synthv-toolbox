//! Cross-platform ownership of an FFmpeg process and every child it creates.
//!
//! This module deliberately accepts a `tokio::process::Command`, rather than a
//! string, so callers cannot accidentally re-introduce shell execution while
//! adding media workflows.

use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(unix)]
use std::time::Duration;

use tokio::process::{Child, Command};

/// Prepare a command to run in an independently manageable process tree.
///
/// Windows needs no pre-spawn change: [`attach_child`] places the spawned
/// process in a Job Object.  On Unix, make the child the leader of a fresh
/// process group so a negative PID can address descendants as well.
pub fn prepare_command(command: &mut Command) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;

        // `pre_exec` is necessarily unsafe: it runs after fork and before
        // exec.  `setpgid` is async-signal-safe and this closure does no
        // allocation, logging, locking, or other work in that interval.
        unsafe {
            command.as_std_mut().pre_exec(|| {
                if libc::setpgid(0, 0) == 0 {
                    Ok(())
                } else {
                    Err(std::io::Error::last_os_error())
                }
            });
        }
    }
    #[cfg(not(unix))]
    {
        let _ = command;
    }
    Ok(())
}

/// Handle which owns the process tree created for one audio job.
///
/// Call [`ProcessTreeGuard::release`] after a successful normal wait.  Dropping
/// an unreleased guard intentionally cleans a still-running tree, which keeps
/// cancellation/error paths from leaking encoders or helpers.
pub struct ProcessTreeGuard {
    released: AtomicBool,
    #[cfg(windows)]
    job: isize,
    #[cfg(unix)]
    process_group: libc::pid_t,
}

/// Bind a spawned child to the platform process-tree primitive.
pub fn attach_child(child: &Child) -> Result<ProcessTreeGuard, String> {
    let pid = child
        .id()
        .ok_or_else(|| "The media process has no operating-system PID.".to_string())?;

    #[cfg(windows)]
    {
        attach_windows_job(pid)
    }
    #[cfg(unix)]
    {
        let process_group = i32::try_from(pid)
            .map_err(|_| "The media process PID is outside the supported range.".to_string())?;
        Ok(ProcessTreeGuard {
            released: AtomicBool::new(false),
            process_group,
        })
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = pid;
        Err("Process-tree control is not implemented for this platform.".to_string())
    }
}

impl ProcessTreeGuard {
    /// Stop the process and all currently associated descendants, then wait for
    /// the direct child to be reaped.  It is safe to call after the child has
    /// already exited.
    pub async fn terminate(&self, child: &mut Child) -> Result<(), String> {
        #[cfg(windows)]
        {
            // The job close in `release` is also a fallback, but terminate
            // explicitly gives callers deterministic cancellation semantics.
            unsafe {
                if windows_sys::Win32::System::JobObjects::TerminateJobObject(
                    self.job as windows_sys::Win32::Foundation::HANDLE,
                    1,
                ) == 0
                {
                    let error = std::io::Error::last_os_error();
                    if error.raw_os_error() != Some(6) {
                        return Err(format!("Unable to terminate media process tree: {error}"));
                    }
                }
            }
        }
        #[cfg(unix)]
        {
            signal_group(self.process_group, libc::SIGTERM)?;
            match tokio::time::timeout(Duration::from_millis(400), child.wait()).await {
                Ok(Ok(_)) => {}
                Ok(Err(error)) => return Err(error.to_string()),
                Err(_) => {
                    signal_group(self.process_group, libc::SIGKILL)?;
                    // A non-zero status is expected after cancellation.  The
                    // wait is for reaping, not validation.
                    let _ = child.wait().await.map_err(|error| error.to_string())?;
                }
            }
            self.release();
            return Ok(());
        }

        // `wait` returns success for a non-zero exit status; that is expected
        // after cancellation. Its purpose here is reaping, not validation.
        let _ = child.wait().await.map_err(|error| error.to_string())?;
        self.release();
        Ok(())
    }

    /// Mark normal completion and relinquish the underlying OS resource.
    ///
    /// This is intentionally idempotent so a normal completion path can defer
    /// it without racing an error/cancellation cleanup path.
    pub fn release(&self) {
        if self.released.swap(true, Ordering::AcqRel) {
            return;
        }
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(
                self.job as windows_sys::Win32::Foundation::HANDLE,
            );
        }
        #[cfg(unix)]
        {
            // The direct child has already been reaped on the normal path.
            // Kill any helper which outlived it before relinquishing the group.
            let _ = unsafe { libc::kill(-self.process_group, libc::SIGKILL) };
        }
    }
}

impl Drop for ProcessTreeGuard {
    fn drop(&mut self) {
        if self.released.swap(true, Ordering::AcqRel) {
            return;
        }
        #[cfg(windows)]
        unsafe {
            // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE makes this a tree cleanup,
            // not merely a direct-child cleanup.
            windows_sys::Win32::Foundation::CloseHandle(
                self.job as windows_sys::Win32::Foundation::HANDLE,
            );
        }
        #[cfg(unix)]
        {
            // Best effort only: Drop cannot await reaping.  A caller that
            // observed normal completion must call `release`, preventing this
            // path from signalling a completed job.
            let _ = unsafe { libc::kill(-self.process_group, libc::SIGKILL) };
        }
    }
}

#[cfg(windows)]
fn attach_windows_job(pid: u32) -> Result<ProcessTreeGuard, String> {
    use std::mem::size_of;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() || job == INVALID_HANDLE_VALUE {
        return Err(format!(
            "Unable to create media Job Object: {}",
            std::io::Error::last_os_error()
        ));
    }

    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let configured = unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const _,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if configured == 0 {
        let error = std::io::Error::last_os_error();
        unsafe { CloseHandle(job) };
        return Err(format!("Unable to configure media Job Object: {error}"));
    }

    let process: HANDLE = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
    if process.is_null() || process == INVALID_HANDLE_VALUE {
        let error = std::io::Error::last_os_error();
        unsafe { CloseHandle(job) };
        return Err(format!(
            "Unable to open media process for Job Object: {error}"
        ));
    }
    let assigned = unsafe { AssignProcessToJobObject(job, process) };
    let assign_error = std::io::Error::last_os_error();
    unsafe { CloseHandle(process) };
    if assigned == 0 {
        unsafe { CloseHandle(job) };
        return Err(format!(
            "Unable to assign media process to Job Object: {assign_error}"
        ));
    }
    Ok(ProcessTreeGuard {
        released: AtomicBool::new(false),
        job: job as isize,
    })
}

#[cfg(unix)]
fn signal_group(process_group: libc::pid_t, signal: libc::c_int) -> Result<(), String> {
    let result = unsafe { libc::kill(-process_group, signal) };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    // The process may have won the race and exited between polling and signal.
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(format!("Unable to signal media process group: {error}"))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn unix_preparation_accepts_an_argument_command() {
        let mut command = Command::new("true");
        command.arg("not a shell expression");
        assert!(prepare_command(&mut command).is_ok());
    }
}
