use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
struct Config {
    expected_slot: PathBuf,
    report_path: PathBuf,
    nonce: String,
}

#[derive(Serialize)]
struct Report {
    actual: String,
    expected: String,
    matched: bool,
    error: Option<String>,
}

fn main() {
    let config_path = std::env::args_os().nth(1).map(PathBuf::from);
    let result = config_path
        .ok_or_else(|| "missing fixture config".to_string())
        .and_then(|path| fs::read(path).map_err(|error| error.to_string()))
        .and_then(|bytes| serde_json::from_slice::<Config>(&bytes).map_err(|error| error.to_string()))
        .and_then(run);
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run(config: Config) -> Result<(), String> {
    let expected = config.expected_slot.canonicalize().map_err(|error| error.to_string())?;
    let official = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| "APPDATA unavailable".to_string())?
        .join("Dreamtonics/Synthesizer V Studio 2");
    let actual = official.canonicalize();
    let report = match actual {
        Ok(actual) => {
            let matched = actual == expected;
            if matched {
                fs::write(official.join("sandboxie-smoke-nonce.txt"), &config.nonce)
                    .map_err(|error| error.to_string())?;
            }
            Report { actual: actual.to_string_lossy().into_owned(), expected: expected.to_string_lossy().into_owned(), matched, error: None }
        }
        Err(error) => Report { actual: official.to_string_lossy().into_owned(), expected: expected.to_string_lossy().into_owned(), matched: false, error: Some(error.to_string()) },
    };
    fs::write(&config.report_path, serde_json::to_vec(&report).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    if !report.matched { return Err("Sandboxie APPDATA route did not match fixture slot".to_string()); }
    std::thread::sleep(std::time::Duration::from_secs(6));
    Ok(())
}
