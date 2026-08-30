//! Exercises the credential store the shell exists to use.
//!
//! Runs against the real Keychain (or Credential Manager on Windows) under a
//! test-only service name, so a pass means the platform integration works —
//! not that a mock was satisfied.

use keyring::Entry;

const SERVICE: &str = "com.runpodlauncher.desktop.test";

#[test]
fn a_connection_survives_a_round_trip_through_the_os_credential_store() {
    let account = "round-trip";
    let entry = Entry::new(SERVICE, account).expect("keychain unavailable");

    let payload = r#"{"base_url":"https://launcher.example.com","token":"abc123"}"#;
    entry.set_password(payload).expect("could not write");

    let read = entry.get_password().expect("could not read back");
    assert_eq!(read, payload);

    entry.delete_credential().expect("could not delete");
}

#[test]
fn an_unpaired_device_reports_no_entry_rather_than_an_error() {
    // The state before pairing is normal, and must not surface as a failure.
    let entry = Entry::new(SERVICE, "definitely-not-paired").expect("keychain unavailable");
    let _ = entry.delete_credential();

    match entry.get_password() {
        Err(keyring::Error::NoEntry) => {}
        other => panic!("expected NoEntry, got {other:?}"),
    }
}
