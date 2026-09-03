use std::path::Path;
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

use crate::process_tree::{attach_child, prepare_command};

const STDOUT_LIMIT: usize = 4 * 1024 * 1024;
const STDERR_LIMIT: usize = 2 * 1024 * 1024;

pub struct ManagedProcessOutput {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

pub async fn run_managed_process(
    program: &Path,
    args: &[String],
    cancelled: &AtomicBool,
    label: &str,
) -> Result<ManagedProcessOutput, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    run_managed_command(command, cancelled, label).await
}

pub async fn run_managed_command(
    mut command: Command,
    cancelled: &AtomicBool,
    label: &str,
) -> Result<ManagedProcessOutput, String> {
    if cancelled.load(Ordering::Acquire) {
        return Err(format!("{label}已取消。"));
    }
    prepare_command(&mut command)?;
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动{label}：{error}"))?;
    let process_tree = match attach_child(&child) {
        Ok(process_tree) => process_tree,
        Err(error) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err(error);
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            process_tree.terminate(&mut child).await?;
            return Err(format!("{label} stdout 不可用"));
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            process_tree.terminate(&mut child).await?;
            return Err(format!("{label} stderr 不可用"));
        }
    };
    let mut stdout_task = tokio::spawn(collect_bounded(stdout, STDOUT_LIMIT, "stdout"));
    let mut stderr_task = tokio::spawn(collect_bounded(stderr, STDERR_LIMIT, "stderr"));
    let mut stdout_result = None;
    let mut stderr_result = None;

    let status = loop {
        if cancelled.load(Ordering::Acquire) {
            process_tree.terminate(&mut child).await?;
            if stdout_result.is_none() {
                let _ = stdout_task.await;
            }
            if stderr_result.is_none() {
                let _ = stderr_task.await;
            }
            return Err(format!("{label}已取消。"));
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("无法等待{label}：{error}"))?
        {
            process_tree.release();
            break status;
        }
        tokio::select! {
            result = &mut stdout_task, if stdout_result.is_none() => {
                match process_reader_result(result, label, "stdout") {
                    Ok(output) => stdout_result = Some(output),
                    Err(error) => {
                        process_tree.terminate(&mut child).await?;
                        if stderr_result.is_none() {
                            let _ = stderr_task.await;
                        }
                        return Err(error);
                    }
                }
            }
            result = &mut stderr_task, if stderr_result.is_none() => {
                match process_reader_result(result, label, "stderr") {
                    Ok(output) => stderr_result = Some(output),
                    Err(error) => {
                        process_tree.terminate(&mut child).await?;
                        if stdout_result.is_none() {
                            let _ = stdout_task.await;
                        }
                        return Err(error);
                    }
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(40)) => {}
        }
    };
    let stdout = match stdout_result {
        Some(output) => output,
        None => process_reader_result(stdout_task.await, label, "stdout")?,
    };
    let stderr = match stderr_result {
        Some(output) => output,
        None => process_reader_result(stderr_task.await, label, "stderr")?,
    };
    Ok(ManagedProcessOutput {
        status,
        stdout,
        stderr,
    })
}

fn process_reader_result(
    result: Result<Result<Vec<u8>, String>, tokio::task::JoinError>,
    label: &str,
    stream: &str,
) -> Result<Vec<u8>, String> {
    result.map_err(|error| format!("{label} {stream} 读取任务失败：{error}"))?
}

async fn collect_bounded<R>(mut reader: R, limit: usize, stream: &str) -> Result<Vec<u8>, String>
where
    R: AsyncRead + Unpin,
{
    let mut output = Vec::new();
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .await
            .map_err(|error| format!("无法读取进程 {stream}：{error}"))?;
        if read == 0 {
            return Ok(output);
        }
        if output.len().saturating_add(read) > limit {
            return Err(format!("进程 {stream} 超过 {limit} 字节限制。"));
        }
        output.extend_from_slice(&buffer[..read]);
    }
}
