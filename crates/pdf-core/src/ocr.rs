//! Local OCR runs outside the PDFium worker so recognition never holds a PDF handle.
use std::{
    io::{Read, Write},
    path::Path,
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

#[derive(Debug, PartialEq)]
pub enum OcrError {
    Unavailable,
    Failed,
    Cancelled,
    TimedOut,
}

pub struct Recognition {
    pub text: String,
    pub confidence: f32,
}

pub fn recognize(
    directory: &Path,
    png: &[u8],
    cancelled: &AtomicBool,
    progress: impl Fn(u8),
) -> Result<Recognition, OcrError> {
    let deadline = Instant::now() + Duration::from_secs(90);
    progress(10);
    let mut result = pass(directory, png, "3", cancelled, deadline)?;
    if result.text.is_empty() || result.confidence < 65.0 {
        progress(70);
        let alternate = pass(directory, png, "6", cancelled, deadline)?;
        if !alternate.text.is_empty()
            && (result.text.is_empty() || alternate.confidence > result.confidence)
        {
            result = alternate;
        }
    }
    progress(100);
    Ok(result)
}

fn check(cancelled: &AtomicBool, deadline: Instant) -> Result<(), OcrError> {
    if cancelled.load(Ordering::Acquire) {
        Err(OcrError::Cancelled)
    } else if Instant::now() >= deadline {
        Err(OcrError::TimedOut)
    } else {
        Ok(())
    }
}

fn pass(
    directory: &Path,
    png: &[u8],
    segmentation: &str,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Recognition, OcrError> {
    check(cancelled, deadline)?;
    let mut command = Command::new(directory.join("tesseract.exe"));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    // Relative model names also work in installations with non-ASCII directory names.
    let mut child = command
        .current_dir(directory)
        .args([
            "stdin",
            "stdout",
            "--tessdata-dir",
            ".",
            "-l",
            "kor+eng",
            "--dpi",
            "180",
            "--psm",
            segmentation,
            "-c",
            "tessedit_create_tsv=1",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| OcrError::Unavailable)?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    const LIMIT: u64 = 16 * 1024 * 1024;
    thread::scope(|scope| {
        let writer = scope.spawn(move || stdin.write_all(png));
        let reader = scope.spawn(move || {
            let mut bytes = Vec::new();
            stdout.take(LIMIT + 1).read_to_end(&mut bytes)?;
            Ok::<_, std::io::Error>(bytes)
        });
        let status = loop {
            if let Err(error) = check(cancelled, deadline) {
                break Err(error);
            }
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) => thread::sleep(Duration::from_millis(35)),
                Err(_) => break Err(OcrError::Failed),
            }
        };
        if status.is_err() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if !status?.success() {
            return Err(OcrError::Failed);
        }
        writer
            .join()
            .map_err(|_| OcrError::Failed)?
            .map_err(|_| OcrError::Failed)?;
        let bytes = reader
            .join()
            .map_err(|_| OcrError::Failed)?
            .map_err(|_| OcrError::Failed)?;
        if bytes.len() as u64 > LIMIT {
            return Err(OcrError::Failed);
        }
        parse_tsv(std::str::from_utf8(&bytes).map_err(|_| OcrError::Failed)?)
    })
}

fn parse_tsv(tsv: &str) -> Result<Recognition, OcrError> {
    let mut rows = tsv.lines();
    if rows.next() != Some("level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext") { return Err(OcrError::Failed); }
    let mut text = String::new();
    let mut previous = None;
    let mut sum = 0.0;
    let mut words = 0;
    for row in rows.filter(|row| row.starts_with("5\t")) {
        let fields: Vec<_> = row.splitn(12, '\t').collect();
        if fields.len() != 12 {
            return Err(OcrError::Failed);
        }
        let word = fields[11].trim();
        if word.is_empty() {
            continue;
        }
        let confidence = fields[10].parse::<f32>().map_err(|_| OcrError::Failed)?;
        if !(0.0..=100.0).contains(&confidence) {
            return Err(OcrError::Failed);
        }
        // Paragraph and line numbers restart within each block.
        let key = ([fields[1], fields[2], fields[3]], fields[4]);
        if let Some((paragraph, number)) = previous {
            text.push_str(if paragraph != key.0 {
                "\n\n"
            } else if number != key.1 {
                "\n"
            } else {
                " "
            });
        }
        previous = Some(key);
        text.push_str(word);
        sum += confidence;
        words += 1;
    }
    if text.encode_utf16().count() > 200_000 {
        return Err(OcrError::Failed);
    }
    Ok(Recognition {
        text,
        confidence: if words == 0 { 0.0 } else { sum / words as f32 },
    })
}
