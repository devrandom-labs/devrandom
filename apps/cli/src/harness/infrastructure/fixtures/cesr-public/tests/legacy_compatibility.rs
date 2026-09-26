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
