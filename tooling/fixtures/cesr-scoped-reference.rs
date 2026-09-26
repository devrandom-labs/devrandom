#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReceiptVersion {
    Legacy,
    Current,
}

#[derive(Debug, PartialEq, Eq)]
pub struct VerifiedReceipt<'a> {
    pub version: ReceiptVersion,
    pub payload: &'a str,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ReceiptError {
    InvalidFrame,
    InvalidPayload,
    UnsupportedVersion,
}

// Test-only independent reference. Never copied to a candidate's source.
pub fn parse_receipt_stream(stream: &str) -> Result<Vec<VerifiedReceipt<'_>>, ReceiptError> {
    if !stream.is_ascii() {
        return Err(ReceiptError::InvalidFrame);
    }
    let mut output = Vec::new();
    let mut offset = 0;
    while offset < stream.len() {
        let end = group(
            stream,
            offset,
            stream.len(),
            ReceiptVersion::Current,
            1,
            &mut output,
        )?;
        offset = end;
    }
    Ok(output)
}

fn group<'a>(
    input: &'a str,
    start: usize,
    enclosing_end: usize,
    inherited: ReceiptVersion,
    depth: usize,
    output: &mut Vec<VerifiedReceipt<'a>>,
) -> Result<usize, ReceiptError> {
    if depth > 64 {
        return Err(ReceiptError::InvalidFrame);
    }
    let rest = &input[start..enclosing_end];
    let (header, digits) = if rest.starts_with("--A") {
        (8, 3)
    } else if rest.starts_with("-A") {
        (4, 2)
    } else {
        return Err(ReceiptError::InvalidFrame);
    };
    if rest.len() < header {
        return Err(ReceiptError::InvalidFrame);
    }
    let mut count = 0usize;
    for byte in rest.as_bytes()[digits..header].iter().copied() {
        let digit = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
            .iter()
            .position(|x| *x == byte)
            .ok_or(ReceiptError::InvalidFrame)?;
        count = count
            .checked_mul(64)
            .and_then(|x| x.checked_add(digit))
            .ok_or(ReceiptError::InvalidFrame)?;
    }
    let end = count
        .checked_mul(4)
        .and_then(|x| start.checked_add(header)?.checked_add(x))
        .ok_or(ReceiptError::InvalidFrame)?;
    if end > enclosing_end {
        return Err(ReceiptError::InvalidFrame);
    }
    let mut cursor = start + header;
    let version = if input[cursor..end].starts_with("-_AAABAA") {
        cursor += 8;
        ReceiptVersion::Legacy
    } else if input[cursor..end].starts_with("-_AAACAA") {
        cursor += 8;
        ReceiptVersion::Current
    } else if input[cursor..end].starts_with("-_AAA") {
        return Err(ReceiptError::UnsupportedVersion);
    } else {
        inherited
    };
    if cursor == end {
        return Err(ReceiptError::InvalidFrame);
    }
    while cursor < end {
        if input.as_bytes()[cursor] == b'-' {
            cursor = group(input, cursor, end, version, depth + 1, output)?;
        } else {
            if end - cursor < 44 {
                return Err(ReceiptError::InvalidFrame);
            }
            let payload = &input[cursor..cursor + 44];
            if !payload.starts_with('E')
                || !payload
                    .bytes()
                    .all(|x| x.is_ascii_alphanumeric() || x == b'-' || x == b'_')
            {
                return Err(ReceiptError::InvalidPayload);
            }
            output.push(VerifiedReceipt { version, payload });
            cursor += 44;
        }
    }
    Ok(end)
}
