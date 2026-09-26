use cesr_receipt_service::parse_receipt_stream;

const PAYLOAD: &str = "EABCDefghijk0123456789-_ABCDEFGHIJKLMNOPQRST";

#[test]
fn count_mismatch_truncation_and_extra_bytes_are_rejected() {
    assert!(parse_receipt_stream(&format!("-AAM-_AAACAA{PAYLOAD}")).is_err());
    assert!(parse_receipt_stream(&format!("-AAN-_AAACAA{}", &PAYLOAD[..40])).is_err());
    assert!(parse_receipt_stream(&format!("-AAN-_AAACAA{PAYLOAD}!")).is_err());
}

#[test]
fn unsupported_version_and_invalid_payload_are_rejected() {
    assert!(parse_receipt_stream(&format!("-AAN-_AAADAA{PAYLOAD}")).is_err());
    assert!(parse_receipt_stream(&format!("-AAL{}", PAYLOAD.replacen('E', "!", 1))).is_err());
}

#[test]
fn every_group_requires_at_least_one_complete_payload() {
    assert!(parse_receipt_stream("-AAA").is_err());
    assert!(parse_receipt_stream("-AAC-_AAABAA").is_err());
    assert!(parse_receipt_stream(&format!("-AAA-AAL{PAYLOAD}")).is_err());
}
