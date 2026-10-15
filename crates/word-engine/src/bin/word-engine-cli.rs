use std::io::{self, BufRead, Write};
use word_engine::{request_json, Engine, Response, MAX_REQUEST_BYTES};

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let stdout = io::stdout();
    let mut output = stdout.lock();
    let mut engine = Engine::new();
    loop {
        let mut line = Vec::new();
        let mut oversized = false;
        let mut eof = false;
        loop {
            let available = input.fill_buf()?;
            if available.is_empty() {
                eof = true;
                break;
            }
            let length = available
                .iter()
                .position(|b| *b == b'\n')
                .map_or(available.len(), |index| index + 1);
            if !oversized {
                if line.len() + length > MAX_REQUEST_BYTES + 1 {
                    oversized = true;
                    line.clear();
                } else {
                    line.extend_from_slice(&available[..length]);
                }
            }
            let end = available[length - 1] == b'\n';
            input.consume(length);
            if end {
                break;
            }
        }
        if eof && line.is_empty() && !oversized {
            break;
        }
        if line.last() == Some(&b'\n') {
            line.pop();
        }
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        let response = if oversized {
            serde_json::to_vec(&Response::error("Request exceeds 24 MiB"))?
        } else {
            request_json(&mut engine, &line)
        };
        output.write_all(&response)?;
        output.write_all(b"\n")?;
        output.flush()?;
        if eof {
            break;
        }
    }
    Ok(())
}
