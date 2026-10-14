//! Diagnostic adapter only: persistent stdin JSON lines are not Tauri IPC.
//! Release builds exercise the production package APIs without process startup
//! or JSON/base64 conversion in the core timings. No filesystem access is used.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::hint::black_box;
use std::io::{self, BufRead, Read, Write};
use std::time::Instant;
use word_package::{read_package, read_package_base64, write_package, write_package_base64, Part};

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
enum Request {
    Read {
        base64: String,
    },
    Write {
        parts: Vec<Part>,
    },
    Ping,
    Benchmark {
        base64: String,
        warmups: usize,
        samples: usize,
        repetitions: usize,
    },
}

fn measure<T>(
    warmups: usize,
    samples: usize,
    repetitions: usize,
    mut f: impl FnMut() -> T,
) -> Vec<f64> {
    let mut times = Vec::with_capacity(samples);
    for round in 0..warmups + samples {
        let start = Instant::now();
        for _ in 0..repetitions {
            // Include destruction/allocation just as the JS loops overwrite
            // their previous result; black_box prevents dead-code elimination.
            black_box(f());
        }
        if round >= warmups {
            times.push(start.elapsed().as_secs_f64() * 1000.0 / repetitions as f64);
        }
    }
    times
}

fn run(request: Request) -> Result<Value, String> {
    match request {
        Request::Ping => Ok(json!({"ok": true})),
        Request::Read { base64 } => Ok(json!({"ok": true, "parts": read_package_base64(&base64)?})),
        Request::Write { parts } => Ok(json!({"ok": true, "base64": write_package_base64(parts)?})),
        Request::Benchmark {
            base64,
            warmups,
            samples,
            repetitions,
        } => {
            if warmups > 100 || !(1..=100).contains(&samples) || !(1..=100).contains(&repetitions) {
                return Err("Invalid benchmark repetition counts".into());
            }
            let bytes = STANDARD.decode(&base64).map_err(|e| e.to_string())?;
            let raw = read_package(&bytes)?;
            let encoded = read_package_base64(&base64)?;
            let output = write_package(&raw)?;
            if read_package(&output)? != raw {
                return Err("Core roundtrip mismatch".into());
            }
            let read_request =
                serde_json::to_vec(&json!({"operation": "read", "base64": base64})).unwrap();
            let write_request =
                serde_json::to_vec(&json!({"operation": "write", "parts": encoded})).unwrap();
            let response = json!({"ok": true, "parts": encoded});
            let measure_op = |f: &mut dyn FnMut()| measure(warmups, samples, repetitions, f);
            let core_read = measure_op(&mut || {
                black_box(read_package(black_box(&bytes)).unwrap());
            });
            let core_write = measure_op(&mut || {
                black_box(write_package(black_box(&raw)).unwrap());
            });
            let base64_read = measure_op(&mut || {
                black_box(read_package_base64(black_box(&base64)).unwrap());
            });
            // Vec ownership requires cloning the caller input. Exclude that
            // diagnostic-only clone from wrapper timing; actual JSON decoding
            // produces an owned Vec and is timed separately below.
            let mut base64_write = Vec::with_capacity(samples);
            for round in 0..warmups + samples {
                let mut elapsed = 0.0;
                for _ in 0..repetitions {
                    let input = encoded.clone();
                    let start = Instant::now();
                    black_box(write_package_base64(input).unwrap());
                    elapsed += start.elapsed().as_secs_f64() * 1000.0;
                }
                if round >= warmups {
                    base64_write.push(elapsed / repetitions as f64);
                }
            }
            let json_read_decode = measure_op(&mut || {
                black_box(serde_json::from_slice::<Request>(black_box(&read_request)).unwrap());
            });
            let json_write_decode = measure_op(&mut || {
                black_box(serde_json::from_slice::<Request>(black_box(&write_request)).unwrap());
            });
            let json_parts_encode = measure_op(&mut || {
                black_box(serde_json::to_vec(black_box(&response)).unwrap());
            });
            Ok(
                json!({"ok": true, "base64": STANDARD.encode(output), "metrics": {
                    "coreRead": core_read, "coreWrite": core_write,
                    "base64Read": base64_read, "base64Write": base64_write,
                    "jsonReadRequestDecode": json_read_decode, "jsonWriteRequestDecode": json_write_decode,
                    "jsonPartsResponseEncode": json_parts_encode
                }}),
            )
        }
    }
}

fn main() {
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let mut output = io::stdout().lock();
    loop {
        let mut line = Vec::new();
        // Diagnostic framing has the same bounded maximum as the production CLI.
        let read = (&mut input)
            .take(word_package::CLI_INPUT_LIMIT as u64 + 2)
            .read_until(b'\n', &mut line);
        if matches!(read, Ok(0)) {
            break;
        }
        let response = if read.is_err()
            || line.len() > word_package::CLI_INPUT_LIMIT
            || !line.ends_with(b"\n")
        {
            json!({"ok": false, "error": "Oversized or unterminated benchmark JSON line"})
        } else {
            match serde_json::from_slice::<Request>(&line)
                .map_err(|e| e.to_string())
                .and_then(run)
            {
                Ok(response) => response,
                Err(error) => json!({"ok": false, "error": error}),
            }
        };
        if serde_json::to_writer(&mut output, &response).is_err()
            || output.write_all(b"\n").is_err()
            || output.flush().is_err()
        {
            std::process::exit(2);
        }
    }
}
