use cesr_receipt_service::{parse_receipt_stream, ReceiptError, ReceiptVersion, VerifiedReceipt};

const FIRST: &str = "EABCDefghijk0123456789-_ABCDEFGHIJKLMNOPQRST";
const SECOND: &str = "EABCDefghijk0123456789-_ABCDEFGHIJKLMNOPQRSU";

#[test]
fn legacy_group_contains_two_payloads_then_default_returns() {
    assert_eq!(FIRST.len(), 44);
    assert_eq!(SECOND.len(), 44);
    // -AAY = 24 quadlets: version marker (8) + two payloads (88).
    // -AAL = 11 quadlets: one payload (44).
    let stream = format!("-AAY-_AAABAA{FIRST}{SECOND}-AAL{FIRST}");
    assert_eq!(
        parse_receipt_stream(&stream),
        Ok(vec![
            VerifiedReceipt {
                version: ReceiptVersion::Legacy,
                payload: FIRST
            },
            VerifiedReceipt {
                version: ReceiptVersion::Legacy,
                payload: SECOND
            },
            VerifiedReceipt {
                version: ReceiptVersion::Current,
                payload: FIRST
            },
        ])
    );
}

#[test]
fn a_partial_second_payload_and_bad_group_count_are_rejected() {
    assert_eq!(
        parse_receipt_stream(&format!("-AAY-_AAABAA{FIRST}{}", &SECOND[..40])),
        Err(ReceiptError::InvalidFrame)
    );
    assert!(parse_receipt_stream(&format!("-AAX-_AAABAA{FIRST}{SECOND}")).is_err());
}

#[test]
fn unsupported_marker_and_invalid_second_payload_are_rejected() {
    assert_eq!(
        parse_receipt_stream(&format!("-AAY-_AAADAA{FIRST}{SECOND}")),
        Err(ReceiptError::UnsupportedVersion)
    );
    assert_eq!(
        parse_receipt_stream(&format!(
            "-AAY-_AAABAA{FIRST}{}",
            SECOND.replacen('E', "!", 1)
        )),
        Err(ReceiptError::InvalidPayload)
    );
}

fn frame(body: &str, large: bool) -> String {
    assert_eq!(body.len() % 4, 0);
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let width = if large { 5 } else { 2 };
    let mut count = body.len() / 4;
    let mut digits = vec![b'A'; width];
    for digit in digits.iter_mut().rev() {
        *digit = alphabet[count % 64];
        count /= 64;
    }
    assert_eq!(count, 0);
    format!(
        "{}{}{}",
        if large { "--A" } else { "-A" },
        String::from_utf8(digits).unwrap(),
        body
    )
}

#[test]
fn large_group_accepts_small_and_over_short_limit_bodies() {
    for count in [2, 373] {
        let body = format!("-_AAABAA{}", FIRST.repeat(count));
        let stream = frame(&body, true);
        assert_eq!(
            parse_receipt_stream(&stream),
            Ok((0..count)
                .map(|_| VerifiedReceipt {
                    version: ReceiptVersion::Legacy,
                    payload: FIRST
                })
                .collect())
        );
    }
}

#[test]
fn nested_versions_inherit_override_and_restore() {
    let inherited = frame(FIRST, false);
    let overridden = frame(&format!("-_AAACAA{SECOND}"), true);
    let restored = frame(SECOND, true);
    let outer = frame(
        &format!("-_AAABAA{inherited}{overridden}{restored}{FIRST}"),
        true,
    );
    let stream = format!("{outer}{}", frame(FIRST, false));
    assert_eq!(
        parse_receipt_stream(&stream),
        Ok(vec![
            VerifiedReceipt {
                version: ReceiptVersion::Legacy,
                payload: FIRST
            },
            VerifiedReceipt {
                version: ReceiptVersion::Current,
                payload: SECOND
            },
            VerifiedReceipt {
                version: ReceiptVersion::Legacy,
                payload: SECOND
            },
            VerifiedReceipt {
                version: ReceiptVersion::Legacy,
                payload: FIRST
            },
            VerifiedReceipt {
                version: ReceiptVersion::Current,
                payload: FIRST
            },
        ])
    );
}

#[test]
fn nested_legacy_override_restores_default_parent() {
    let legacy = frame(&format!("-_AAABAA{SECOND}"), false);
    let stream = frame(&format!("{FIRST}{legacy}{FIRST}"), false);
    assert_eq!(
        parse_receipt_stream(&stream),
        Ok(vec![
            VerifiedReceipt {
                version: ReceiptVersion::Current,
                payload: FIRST
            },
            VerifiedReceipt {
                version: ReceiptVersion::Legacy,
                payload: SECOND
            },
            VerifiedReceipt {
                version: ReceiptVersion::Current,
                payload: FIRST
            },
        ])
    );
}

#[test]
fn complete_nested_framing_and_marker_placement_are_required() {
    for stream in [
        frame(&format!("-AAM{FIRST}"), true),
        frame(&format!("{FIRST}-_AAABAA{SECOND}"), false),
        frame("-AAA", false),
        frame("-AAC-_AAABAA", true),
        frame(&frame(&format!("-_AAADAA{FIRST}"), false), false),
        format!("--A_____{FIRST}"),
        format!("--AAA!AL{FIRST}"),
        format!("--AAAAAL{FIRST}!"),
        format!("-_AAABAA{}", frame(FIRST, false)),
        format!("-AéA{FIRST}"),
        frame(&format!("E{}éA", "A".repeat(40)), false),
    ] {
        assert!(
            parse_receipt_stream(&stream).is_err(),
            "unexpected acceptance: {stream}"
        );
    }
}

#[test]
fn nesting_has_a_disclosed_bounded_depth() {
    let mut stream = FIRST.to_string();
    for _ in 0..64 {
        stream = frame(&stream, false);
    }
    assert_eq!(
        parse_receipt_stream(&stream),
        Ok(vec![VerifiedReceipt {
            version: ReceiptVersion::Current,
            payload: FIRST
        }])
    );
    assert!(parse_receipt_stream(&frame(&stream, false)).is_err());
}
