use std::{cell::RefCell, ffi::OsStr};

thread_local! {
    static CALLS: RefCell<Option<Vec<String>>> = const { RefCell::new(None) };
}

pub fn command_output(program: &OsStr) -> Option<String> {
    CALLS.with(|calls| {
        let mut calls = calls.borrow_mut();
        let calls = calls.as_mut()?;
        let program = program.to_str().unwrap();
        calls.push(program.to_string());
        Some(match program {
            "ps" => concat!(
                "10 Tue Sep  8 09:00:00 2026 /sbin/launchd\n",
                "11 Tue Sep  8 09:00:00 2026 /Applications/Other.app/Contents/MacOS/Other\n",
                "12 Tue Sep  8 09:00:00 2026 /Applications/Synthesizer V Toolbox.app/Contents/MacOS/synthv-toolbox\n",
                "13 Tue Sep  8 09:00:00 2026 /Applications/Synthesizer V Studio 2 Pro.app/Contents/MacOS/synthv-studio\n",
                "14 Tue Sep  8 09:00:00 2026 /Applications/Synthesizer V Flat.app/Contents/MacOS/Synthesizer V Flat\n",
            ).to_string(),
            "mdls" => "2.3.0".to_string(),
            "osascript" => "Song.svp".to_string(),
            other => panic!("Unexpected command: {other}"),
        })
    })
}

#[test]
fn reads_metadata_only_for_synthv_hosts() {
    CALLS.with(|calls| *calls.borrow_mut() = Some(Vec::new()));
    let processes = crate::synthv_control::list_processes().unwrap();
    let calls = CALLS.with(|calls| calls.borrow_mut().take().unwrap());
    assert_eq!(calls, ["ps", "mdls", "osascript", "mdls", "osascript"]);
    assert_eq!(processes.iter().map(|p| p.process_id).collect::<Vec<_>>(), [13, 14]);
    assert!(processes[0].is_sv2);
    assert!(!processes[1].is_sv2);
    assert!(processes.iter().all(|p| p.version == "2.3.0" && p.window_title == "Song.svp"));
}
