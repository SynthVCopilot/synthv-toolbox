use super::*;

#[test]
fn concurrent_ffmpeg_demands_share_one_installation_task() {
    let queue = Arc::new(ComponentDownloadManager::default());
    let requests: Vec<_> = (0..8)
        .map(|_| {
            let queue = Arc::clone(&queue);
            std::thread::spawn(move || queue.enqueue("ffmpeg").unwrap())
        })
        .collect();
    let mut worker_starts = 0;
    let mut ids = HashSet::new();
    for request in requests {
        let (items, starts) = request.join().unwrap();
        worker_starts += usize::from(starts);
        ids.insert(items[0].id.clone());
    }
    assert_eq!(worker_starts, 1);
    assert_eq!(ids.len(), 1);
    assert_eq!(queue.snapshot().len(), 1);
}

#[test]
fn waiting_demands_resume_only_after_installation_completes() {
    let queue = Arc::new(ComponentDownloadManager::default());
    let (items, _) = queue.enqueue("ffmpeg").unwrap();
    let id = items[0].id.clone();
    assert!(queue.installation_result(&id).unwrap().is_none());
    let waiting_queue = Arc::clone(&queue);
    let waiting_id = id.clone();
    let waiter = std::thread::spawn(move || waiting_queue.wait_for_installation(&waiting_id, None));
    queue.finish(
        &id,
        ComponentDownloadStatus::Completed,
        100,
        "ready".to_string(),
    );
    assert!(waiter.join().unwrap().is_ok());
}

#[test]
fn failed_and_cancelled_downloads_stop_the_waiting_operation() {
    let queue = ComponentDownloadManager::default();
    let (items, _) = queue.enqueue("ffmpeg").unwrap();
    let id = &items[0].id;
    queue.finish(
        id,
        ComponentDownloadStatus::Failed,
        100,
        "archive verification failed".to_string(),
    );
    assert_eq!(
        queue.wait_for_installation(id, None).unwrap_err(),
        "archive verification failed"
    );
    let (items, _) = queue.enqueue("ffmpeg").unwrap();
    let id = &items[0].id;
    queue.cancel_queued(id).unwrap();
    assert!(queue.wait_for_installation(id, None).is_err());
    assert!(!queue.has_active("ffmpeg"));
}

#[test]
fn cancelling_one_caller_does_not_cancel_the_shared_installation() {
    let queue = ComponentDownloadManager::default();
    let (items, _) = queue.enqueue("ffmpeg").unwrap();
    let cancelled = AtomicBool::new(true);
    assert!(queue
        .wait_for_installation(&items[0].id, Some(&cancelled))
        .is_err());
    assert!(queue.has_active("ffmpeg"));
}

#[test]
fn a_replaced_task_is_not_silently_followed_by_a_waiting_caller() {
    let queue = ComponentDownloadManager::default();
    let (items, _) = queue.enqueue("ffmpeg").unwrap();
    queue.cancel_queued(&items[0].id).unwrap();
    queue.enqueue("ffmpeg").unwrap();
    assert!(queue.wait_for_installation(&items[0].id, None).is_err());
}
