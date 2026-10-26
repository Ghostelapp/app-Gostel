use ghostel_mls::{Device, Engine, Received};
fn device(name: &str) -> Device {
    Device {
        user_id: name.into(),
        device_id: format!("{name}-phone"),
    }
}
fn pair() -> (Engine, Engine, Vec<Device>) {
    let mut a = Engine::new(device("alice")).unwrap();
    let mut b = Engine::new(device("bob")).unwrap();
    a.verify_device(b.public_identity()).unwrap();
    b.verify_device(a.public_identity()).unwrap();
    let roster = vec![device("alice"), device("bob")];
    a.transaction(|a| a.create("chat")).unwrap();
    let package = b.key_package().unwrap();
    let commit = a
        .transaction(|a| a.add("chat", &[package], &roster))
        .unwrap();
    a.transaction(|a| a.accept_commit("chat", &roster)).unwrap();
    b.transaction(|b| b.join("chat", &commit.welcome.unwrap(), &roster))
        .unwrap();
    (a, b, roster)
}
#[test]
fn authenticated_exchange_replay_and_restart() {
    let (mut a, mut b, roster) = pair();
    let wire = a
        .transaction(|a| a.encrypt("chat", b"secret", &roster))
        .unwrap();
    assert!(!wire.windows(6).any(|w| w == b"secret"));
    let sealed = b.seal(&[7; 32]).unwrap();
    b = Engine::open(&device("bob"), &[7; 32], &sealed).unwrap();
    assert_eq!(
        b.transaction(|b| b.receive("chat", &wire, &roster))
            .unwrap(),
        Received::Application {
            sender: device("alice"),
            body: b"secret".to_vec()
        }
    );
    let sealed = b.seal(&[7; 32]).unwrap();
    b = Engine::open(&device("bob"), &[7; 32], &sealed).unwrap();
    assert!(b
        .transaction(|b| b.receive("chat", &wire, &roster))
        .is_err());
}
#[test]
fn tampering_does_not_consume_receive_key() {
    let (mut a, mut b, roster) = pair();
    let wire = a
        .transaction(|a| a.encrypt("chat", b"secret", &roster))
        .unwrap();
    let mut corrupt = wire.clone();
    let n = corrupt.len();
    corrupt[n - 1] ^= 1;
    assert!(b
        .transaction(|b| b.receive("chat", &corrupt, &roster))
        .is_err());
    assert!(b
        .transaction(|b| b.receive("chat", &wire, &[device("bob")]))
        .is_err());
    assert!(b.transaction(|b| b.receive("chat", &wire, &roster)).is_ok());
}
#[test]
fn update_rotates_epoch_and_survives_restart() {
    let (mut a, mut b, roster) = pair();
    let commit = a.transaction(|a| a.update("chat")).unwrap();
    // Pending commits block application sends until durably accepted by delivery.
    assert!(a
        .transaction(|a| a.encrypt("chat", b"too-early", &roster))
        .is_err());
    let sealed = a.seal(&[2; 32]).unwrap();
    a = Engine::open(&device("alice"), &[2; 32], &sealed).unwrap();
    a.transaction(|a| a.accept_commit("chat", &roster)).unwrap();
    assert_eq!(
        b.transaction(|b| b.receive("chat", &commit.message, &roster))
            .unwrap(),
        Received::Commit
    );
    let wire = b
        .transaction(|b| b.encrypt("chat", b"new-epoch", &roster))
        .unwrap();
    assert!(a.transaction(|a| a.receive("chat", &wire, &roster)).is_ok());
}
#[test]
fn reject_unverified_package_and_wrong_group_welcome() {
    let mut a = Engine::new(device("alice")).unwrap();
    let mut b = Engine::new(device("bob")).unwrap();
    let roster = vec![device("alice"), device("bob")];
    a.transaction(|a| a.create("chat")).unwrap();
    let package = b.key_package().unwrap();
    assert!(a
        .transaction(|a| a.add("chat", std::slice::from_ref(&package), &roster))
        .is_err());
    a.verify_device(b.public_identity()).unwrap();
    b.verify_device(a.public_identity()).unwrap();
    let welcome = a
        .transaction(|a| a.add("chat", &[package], &roster))
        .unwrap()
        .welcome
        .unwrap();
    assert!(b
        .transaction(|b| b.join("other-chat", &welcome, &roster))
        .is_err());
    b.transaction(|b| b.join("chat", &welcome, &roster))
        .unwrap();
    assert!(b
        .transaction(|b| b.join("chat", &welcome, &roster))
        .is_err());
}
#[test]
fn sealed_state_is_bound_to_device_and_key() {
    let mut a = Engine::new(device("alice")).unwrap();
    let state = a.seal(&[1; 32]).unwrap();
    assert!(Engine::open(&device("bob"), &[1; 32], &state).is_err());
    assert!(Engine::open(&device("alice"), &[2; 32], &state).is_err());
    let mut corrupt = state.clone();
    corrupt[20] ^= 1;
    assert!(Engine::open(&device("alice"), &[1; 32], &corrupt).is_err());
    assert!(Engine::open(&device("alice"), &[1; 32], &state).is_ok());
}
#[test]
fn pin_replacement_and_trailing_bytes_are_rejected() {
    let (mut a, mut b, roster) = pair();
    let mut fake = b.public_identity();
    fake.signature_key[0] ^= 1;
    assert!(a.verify_device(fake).is_err());
    let mut wire = a
        .transaction(|a| a.encrypt("chat", b"body", &roster))
        .unwrap();
    wire.push(0);
    assert!(b
        .transaction(|b| b.receive("chat", &wire, &roster))
        .is_err());
}
#[test]
fn removed_device_cannot_read_future_epoch() {
    let (mut a, mut b, mut roster) = pair();
    let mut c = Engine::new(device("carol")).unwrap();
    a.verify_device(c.public_identity()).unwrap();
    b.verify_device(c.public_identity()).unwrap();
    c.verify_device(a.public_identity()).unwrap();
    c.verify_device(b.public_identity()).unwrap();
    roster.push(device("carol"));
    let commit = a.add("chat", &[c.key_package().unwrap()], &roster).unwrap();
    a.accept_commit("chat", &roster).unwrap();
    b.receive("chat", &commit.message, &roster).unwrap();
    c.join("chat", &commit.welcome.unwrap(), &roster).unwrap();
    let remaining = vec![device("alice"), device("bob")];
    let commit = a.remove("chat", &[device("carol")], &remaining).unwrap();
    a.accept_commit("chat", &remaining).unwrap();
    b.receive("chat", &commit.message, &remaining).unwrap();
    let wire = a.encrypt("chat", b"after removal", &remaining).unwrap();
    assert!(c.receive("chat", &wire, &roster).is_err());
    assert!(b.receive("chat", &wire, &remaining).is_ok());
}
#[test]
fn rejected_membership_commit_rolls_back_automatically() {
    let (mut a, mut b, roster) = pair();
    let mut c = Engine::new(device("carol")).unwrap();
    a.verify_device(c.public_identity()).unwrap();
    let mut expanded = roster.clone();
    expanded.push(device("carol"));
    let commit = a
        .add("chat", &[c.key_package().unwrap()], &expanded)
        .unwrap();
    // Bob has not verified Carol: reject and keep original epoch operational.
    assert!(b.receive("chat", &commit.message, &expanded).is_err());
    b.verify_device(c.public_identity()).unwrap();
    assert!(b.receive("chat", &commit.message, &roster).is_err());
    assert!(b.receive("chat", &commit.message, &expanded).is_ok());
}
#[test]
fn old_epoch_keys_are_not_retained() {
    let (mut a, mut b, roster) = pair();
    let old = a
        .encrypt("chat", b"undelivered old epoch", &roster)
        .unwrap();
    let commit = a.update("chat").unwrap();
    a.accept_commit("chat", &roster).unwrap();
    b.receive("chat", &commit.message, &roster).unwrap();
    assert!(b.receive("chat", &old, &roster).is_err());
}
