use cesr_receipt_service::{parse_receipt_stream, ReceiptVersion, VerifiedReceipt};

const PAYLOAD: &str = "EABCDefghijk0123456789-_ABCDEFGHIJKLMNOPQRST";

#[test]
fn current_direct_and_unmarked_groups_use_version_two() {
    assert_eq!(PAYLOAD.len(), 44);
    let stream = format!("-AAN-_AAACAA{PAYLOAD}-AAL{PAYLOAD}");
    assert_eq!(
        parse_receipt_stream(&stream),
        Ok(vec![
            VerifiedReceipt {
                version: ReceiptVersion::Current,
                payload: PAYLOAD
            },
            VerifiedReceipt {
                version: ReceiptVersion::Current,
                payload: PAYLOAD
            },
        ])
    );
}
