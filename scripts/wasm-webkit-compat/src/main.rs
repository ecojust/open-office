//! Avoid WebKit bug 317022 without changing i64 comparison semantics.
//! Its old B3 optimizer can infer an overflowing sparse i64 jump-table range.
use std::{env, fs, ops::Range, path::Path};
use wasmparser::{Operator, Parser, Payload, Validator};

fn leb(out: &mut Vec<u8>, mut value: usize) {
    loop {
        let byte = (value & 127) as u8;
        value >>= 7;
        out.push(if value == 0 { byte } else { byte | 128 });
        if value == 0 {
            break;
        }
    }
}

fn code_section(input: &[u8]) -> Result<Option<Range<usize>>, String> {
    let mut at = 8;
    while at < input.len() {
        let start = at;
        let id = input[at];
        at += 1;
        let mut size = 0usize;
        let mut shift = 0;
        loop {
            let byte = *input.get(at).ok_or("Truncated section length")?;
            at += 1;
            size |= usize::from(byte & 127)
                .checked_shl(shift)
                .ok_or("Section length overflow")?;
            if byte & 128 == 0 {
                break;
            }
            shift += 7;
            if shift >= usize::BITS {
                return Err("Section length overflow".into());
            }
        }
        at = at
            .checked_add(size)
            .filter(|&end| end <= input.len())
            .ok_or("Truncated section")?;
        if id == 10 {
            return Ok(Some(start..at));
        }
    }
    Ok(None)
}

fn rewrite(input: &[u8]) -> Result<(Vec<u8>, usize), String> {
    Validator::new()
        .validate_all(input)
        .map_err(|e| e.to_string())?;
    let mut bodies = Vec::new();
    let mut changes = 0;
    for payload in Parser::new(0).parse_all(input) {
        if let Payload::CodeSectionEntry(body) = payload.map_err(|e| e.to_string())? {
            let range = body.range();
            let mut reader = body.get_operators_reader().map_err(|e| e.to_string())?;
            let mut output = Vec::new();
            let mut copied = range.start;
            while !reader.eof() {
                let start = reader.original_position();
                let op = reader.read().map_err(|e| e.to_string())?;
                let prefix: &[u8] = match op {
                    Operator::I64Eq => &[0x85], // xor
                    Operator::I64Ne => &[0x85],
                    Operator::I64Eqz => &[],
                    _ => continue,
                };
                output.extend_from_slice(&input[copied..start]);
                output.extend_from_slice(prefix);
                // clz(x) is 64 exactly when x == 0. For every other value it is
                // 0..63, so clz(x) >> 6 is precisely the original equality bit.
                output.extend_from_slice(&[0x79, 0x42, 0x06, 0x88, 0xa7]);
                if matches!(op, Operator::I64Ne) {
                    output.push(0x45);
                } // i32.eqz
                copied = reader.original_position();
                changes += 1;
            }
            output.extend_from_slice(&input[copied..range.end]);
            bodies.push(output);
        }
    }
    if changes == 0 {
        return Ok((input.to_vec(), 0));
    }
    let section = code_section(input)?.ok_or("Missing code section")?;
    let mut code = Vec::new();
    leb(&mut code, bodies.len());
    for body in bodies {
        leb(&mut code, body.len());
        code.extend_from_slice(&body);
    }
    let mut output = input[..section.start].to_vec();
    output.push(10);
    leb(&mut output, code.len());
    output.extend_from_slice(&code);
    output.extend_from_slice(&input[section.end..]);
    Validator::new()
        .validate_all(&output)
        .map_err(|e| e.to_string())?;
    Ok((output, changes))
}

fn run() -> Result<(), String> {
    let path = env::args_os()
        .nth(1)
        .ok_or("Usage: open-office-wasm-webkit-compat module.wasm")?;
    let path = Path::new(&path);
    let input = fs::read(path).map_err(|e| e.to_string())?;
    let (output, changes) = rewrite(&input)?;
    if changes != 0 {
        fs::write(path, output).map_err(|e| e.to_string())?;
    }
    println!("WebKit sparse-i64 compatibility: {changes} comparisons rewritten");
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("WASM compatibility: {error}");
        std::process::exit(1);
    }
}
