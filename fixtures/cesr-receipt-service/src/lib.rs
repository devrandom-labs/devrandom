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

pub fn parse_receipt_stream(stream: &str) -> Result<Vec<VerifiedReceipt<'_>>, ReceiptError> {
    let mut rest = stream;
    let mut receipts = Vec::new();
    while !rest.is_empty() {
        let (kind, body, next) = short_frame(rest)?;
        rest = next;
        if kind != b'A' {
            return Err(ReceiptError::InvalidFrame);
        }
        let payload = if let Some(payload) = body.strip_prefix("-_AAACAA") {
            payload
        } else if body.starts_with("-_AAA") {
            return Err(ReceiptError::UnsupportedVersion);
        } else {
            body
        };
        if payload.len() != 44 || !payload.starts_with('E') || !payload.bytes().all(is_base64url) {
            return Err(ReceiptError::InvalidPayload);
        }
        receipts.push(VerifiedReceipt {
            version: ReceiptVersion::Current,
            payload,
        });
    }
    Ok(receipts)
}

fn short_frame(input: &str) -> Result<(u8, &str, &str), ReceiptError> {
    let code = input.as_bytes();
    if code.len() < 4 || code[0] != b'-' || code[1] != b'A' {
        return Err(ReceiptError::InvalidFrame);
    }
    let count = decode_count(&input[2..4]).ok_or(ReceiptError::InvalidFrame)?;
    let length = 4 + count * 4;
    if input.len() < length {
        return Err(ReceiptError::InvalidFrame);
    }
    Ok((code[1], &input[4..length], &input[length..]))
}

fn decode_count(digits: &str) -> Option<usize> {
    let mut count = 0usize;
    for byte in digits.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        };
        count = count * 64 + usize::from(value);
    }
    Some(count)
}

fn is_base64url(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'
}
