//! Ghostel's MLS engine. All commands execute on an isolated snapshot: callers
//! must durably replace the sealed state before publishing the returned output.
//! This crate deliberately contains no network or device-storage implementation.
use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, KeyInit, Nonce,
};
use openmls::prelude::*;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::OpenMlsProvider;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use tls_codec::{Deserialize as TlsDeserialize, Serialize as TlsSerialize};
use zeroize::{Zeroize, Zeroizing};

const SUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
const MAX_WIRE: usize = 1024 * 1024;
const MAX_STATE: usize = 32 * 1024 * 1024;
const MAX_MEMBERS: usize = 256;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid input or unsupported operation")]
    Input,
    #[error("MLS authentication, state or protocol error")]
    Protocol,
    #[error("unverified device or unexpected membership")]
    Trust,
    #[error("invalid sealed state or account binding")]
    State,
}
type Result<T> = std::result::Result<T, Error>;
fn protocol<T, E>(value: std::result::Result<T, E>) -> Result<T> {
    value.map_err(|_| Error::Protocol)
}

/// Credential bytes are canonical JSON, binding a signing key to both IDs.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
pub struct Device {
    pub user_id: String,
    pub device_id: String,
}
impl Device {
    fn identity(&self) -> Result<Vec<u8>> {
        if [&self.user_id, &self.device_id].iter().any(|s| {
            s.is_empty()
                || s.len() > 128
                || !s
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
        }) {
            return Err(Error::Input);
        }
        serde_json::to_vec(self).map_err(|_| Error::Input)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct VerifiedDevice {
    pub device: Device,
    pub signature_key: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
struct Snapshot {
    version: u32,
    device: Device,
    signer: SignatureKeyPair,
    storage: Vec<(Vec<u8>, Vec<u8>)>,
    /// Trust is persisted locally, never inferred from a delivery-server response.
    #[serde(with = "pins_serde")]
    verified: BTreeMap<Vec<u8>, Vec<u8>>,
}

pub struct Engine {
    provider: OpenMlsRustCrypto,
    snapshot: Snapshot,
}
#[derive(Debug)]
pub struct Commit {
    pub message: Vec<u8>,
    pub welcome: Option<Vec<u8>>,
}
#[derive(Debug, PartialEq, Eq)]
pub enum Received {
    Application { sender: Device, body: Vec<u8> },
    Commit,
}

impl Engine {
    pub fn new(device: Device) -> Result<Self> {
        let identity = device.identity()?;
        let provider = OpenMlsRustCrypto::default();
        let signer = protocol(SignatureKeyPair::new(SUITE.signature_algorithm()))?;
        protocol(signer.store(provider.storage()))?;
        let verified = BTreeMap::from([(identity, signer.public().to_vec())]);
        Ok(Self {
            provider,
            snapshot: Snapshot {
                version: 1,
                device,
                signer,
                storage: vec![],
                verified,
            },
        })
    }
    pub fn public_identity(&self) -> VerifiedDevice {
        VerifiedDevice {
            device: self.snapshot.device.clone(),
            signature_key: self.snapshot.signer.public().to_vec(),
        }
    }
    /// Call only after explicit out-of-band fingerprint verification. A changed
    /// key requires a new device ID; silently replacing a pin is forbidden.
    pub fn verify_device(&mut self, device: VerifiedDevice) -> Result<()> {
        let identity = device.device.identity()?;
        if self.snapshot.verified.len() >= 4096 && !self.snapshot.verified.contains_key(&identity) {
            return Err(Error::Input);
        }
        if device.signature_key.len() != 32 {
            return Err(Error::Input);
        }
        if self
            .snapshot
            .verified
            .get(&identity)
            .is_some_and(|k| k != &device.signature_key)
        {
            return Err(Error::Trust);
        }
        self.snapshot
            .verified
            .insert(identity, device.signature_key);
        Ok(())
    }
    pub fn create(&mut self, conversation: &str) -> Result<()> {
        self.transaction(|e| e.create_inner(conversation))
    }
    pub fn key_package(&mut self) -> Result<Vec<u8>> {
        self.transaction(|e| e.key_package_inner())
    }
    pub fn add(
        &mut self,
        conversation: &str,
        packages: &[Vec<u8>],
        expected: &[Device],
    ) -> Result<Commit> {
        self.transaction(|e| e.add_inner(conversation, packages, expected))
    }
    pub fn accept_commit(&mut self, conversation: &str, expected: &[Device]) -> Result<()> {
        self.transaction(|e| e.accept_commit_inner(conversation, expected))
    }
    pub fn update(&mut self, conversation: &str) -> Result<Commit> {
        self.transaction(|e| e.update_inner(conversation))
    }
    pub fn join(&mut self, conversation: &str, bytes: &[u8], expected: &[Device]) -> Result<()> {
        self.transaction(|e| e.join_inner(conversation, bytes, expected))
    }
    pub fn encrypt(
        &mut self,
        conversation: &str,
        body: &[u8],
        expected: &[Device],
    ) -> Result<Vec<u8>> {
        self.transaction(|e| e.encrypt_inner(conversation, body, expected))
    }
    pub fn receive(
        &mut self,
        conversation: &str,
        bytes: &[u8],
        expected: &[Device],
    ) -> Result<Received> {
        self.transaction(|e| e.receive_inner(conversation, bytes, expected))
    }
    pub fn remove(
        &mut self,
        conversation: &str,
        removed: &[Device],
        expected: &[Device],
    ) -> Result<Commit> {
        self.transaction(|e| {
            if removed.is_empty() || removed.contains(&e.snapshot.device) {
                return Err(Error::Input);
            }
            let mut group = e.group(conversation)?;
            let mut indices = Vec::new();
            for member in group.members() {
                let device = e.check_credential(&member.credential, &member.signature_key)?;
                if removed.contains(&device) {
                    indices.push(member.index);
                }
            }
            if indices.len() != removed.len() {
                return Err(Error::Input);
            }
            let (commit, _, _) =
                protocol(group.remove_members(&e.provider, &e.snapshot.signer, &indices))?;
            let result = Commit {
                message: protocol(commit.tls_serialize_detached())?,
                welcome: None,
            };
            e.copy()?.accept_commit_inner(conversation, expected)?;
            Ok(result)
        })
    }
    fn credential(&self) -> Result<CredentialWithKey> {
        Ok(CredentialWithKey {
            credential: BasicCredential::new(self.snapshot.device.identity()?).into(),
            signature_key: self.snapshot.signer.public().into(),
        })
    }
    fn check_credential(&self, credential: &Credential, key: &[u8]) -> Result<Device> {
        let basic = BasicCredential::try_from(credential.clone()).map_err(|_| Error::Trust)?;
        let device: Device = serde_json::from_slice(basic.identity()).map_err(|_| Error::Trust)?;
        let id = device.identity()?;
        if id != basic.identity() || self.snapshot.verified.get(&id).map(Vec::as_slice) != Some(key)
        {
            return Err(Error::Trust);
        }
        Ok(device)
    }
    fn check_roster(&self, group: &MlsGroup, expected: &[Device]) -> Result<()> {
        if expected.is_empty() || expected.len() > MAX_MEMBERS {
            return Err(Error::Input);
        }
        let mut actual = HashSet::new();
        for member in group.members() {
            let device = self.check_credential(&member.credential, &member.signature_key)?;
            if !actual.insert(device.identity()?) {
                return Err(Error::Trust);
            }
        }
        let wanted: HashSet<_> = expected
            .iter()
            .map(Device::identity)
            .collect::<Result<_>>()?;
        if wanted.len() != expected.len() || wanted != actual {
            return Err(Error::Trust);
        }
        Ok(())
    }
    fn key_package_inner(&mut self) -> Result<Vec<u8>> {
        let kp = protocol(KeyPackage::builder().build(
            SUITE,
            &self.provider,
            &self.snapshot.signer,
            self.credential()?,
        ))?;
        protocol(kp.key_package().tls_serialize_detached())
    }
    fn group_id(conversation: &str) -> Result<GroupId> {
        if conversation.is_empty()
            || conversation.len() > 128
            || !conversation
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
        {
            return Err(Error::Input);
        }
        Ok(GroupId::from_slice(
            format!("ghostel/mls/v1/{conversation}").as_bytes(),
        ))
    }
    fn group(&self, conversation: &str) -> Result<MlsGroup> {
        protocol(MlsGroup::load(
            self.provider.storage(),
            &Self::group_id(conversation)?,
        ))?
        .ok_or(Error::State)
    }
    fn create_inner(&mut self, conversation: &str) -> Result<()> {
        let id = Self::group_id(conversation)?;
        if protocol(MlsGroup::load(self.provider.storage(), &id))?.is_some() {
            return Err(Error::State);
        }
        let config = MlsGroupCreateConfig::builder()
            .ciphersuite(SUITE)
            .use_ratchet_tree_extension(true)
            .wire_format_policy(PURE_CIPHERTEXT_WIRE_FORMAT_POLICY)
            .build();
        protocol(MlsGroup::new_with_group_id(
            &self.provider,
            &self.snapshot.signer,
            &config,
            id,
            self.credential()?,
        ))?;
        Ok(())
    }
    fn add_inner(
        &mut self,
        conversation: &str,
        packages: &[Vec<u8>],
        expected: &[Device],
    ) -> Result<Commit> {
        if packages.is_empty() || packages.len() >= MAX_MEMBERS {
            return Err(Error::Input);
        }
        let mut group = self.group(conversation)?;
        if group.members().count() + packages.len() > MAX_MEMBERS {
            return Err(Error::Input);
        }
        let mut keys = Vec::new();
        for bytes in packages {
            if bytes.len() > 16384 {
                return Err(Error::Input);
            }
            let kp = protocol(KeyPackageIn::tls_deserialize_exact(bytes))?;
            let kp = protocol(kp.validate(self.provider.crypto(), ProtocolVersion::Mls10))?;
            if kp.ciphersuite() != SUITE {
                return Err(Error::Input);
            }
            self.check_credential(
                kp.leaf_node().credential(),
                kp.leaf_node().signature_key().as_slice(),
            )?;
            keys.push(kp);
        }
        let (commit, welcome, _) =
            protocol(group.add_members(&self.provider, &self.snapshot.signer, &keys))?;
        // Pending commit remains until the delivery service accepts the ordered event.
        let result = Commit {
            message: protocol(commit.tls_serialize_detached())?,
            welcome: Some(protocol(welcome.tls_serialize_detached())?),
        };
        // Validate the final roster on a disposable copy, without accepting early.
        let mut copy = self.copy()?;
        copy.accept_commit_inner(conversation, expected)?;
        Ok(result)
    }
    fn accept_commit_inner(&mut self, conversation: &str, expected: &[Device]) -> Result<()> {
        let mut group = self.group(conversation)?;
        if group.pending_commit().is_none() {
            return Err(Error::State);
        }
        protocol(group.merge_pending_commit(&self.provider))?;
        self.check_roster(&group, expected)
    }
    fn update_inner(&mut self, conversation: &str) -> Result<Commit> {
        let mut group = self.group(conversation)?;
        let bundle = protocol(group.self_update(
            &self.provider,
            &self.snapshot.signer,
            LeafNodeParameters::default(),
        ))?;
        Ok(Commit {
            message: protocol(bundle.commit().tls_serialize_detached())?,
            welcome: None,
        })
    }
    fn join_inner(&mut self, conversation: &str, bytes: &[u8], expected: &[Device]) -> Result<()> {
        if self.group(conversation).is_ok() || bytes.len() > MAX_WIRE {
            return Err(Error::Input);
        }
        let msg = protocol(MlsMessageIn::tls_deserialize_exact(bytes))?;
        let welcome = match msg.extract() {
            MlsMessageBodyIn::Welcome(w) => w,
            _ => return Err(Error::Input),
        };
        let config = MlsGroupJoinConfig::builder()
            .wire_format_policy(PURE_CIPHERTEXT_WIRE_FORMAT_POLICY)
            .build();
        let staged = protocol(StagedWelcome::new_from_welcome(
            &self.provider,
            &config,
            welcome,
            None,
        ))?;
        let group = protocol(staged.into_group(&self.provider))?;
        if group.group_id() != &Self::group_id(conversation)? || group.ciphersuite() != SUITE {
            return Err(Error::Trust);
        }
        self.check_roster(&group, expected)
    }
    fn encrypt_inner(
        &mut self,
        conversation: &str,
        body: &[u8],
        expected: &[Device],
    ) -> Result<Vec<u8>> {
        if body.len() > 65536 {
            return Err(Error::Input);
        }
        let mut group = self.group(conversation)?;
        self.check_roster(&group, expected)?;
        if group.pending_commit().is_some() {
            return Err(Error::State);
        }
        let msg = protocol(group.create_message(&self.provider, &self.snapshot.signer, body))?;
        protocol(msg.tls_serialize_detached())
    }
    fn receive_inner(
        &mut self,
        conversation: &str,
        bytes: &[u8],
        expected: &[Device],
    ) -> Result<Received> {
        if bytes.len() > MAX_WIRE {
            return Err(Error::Input);
        }
        let mut group = self.group(conversation)?;
        let msg = protocol(MlsMessageIn::tls_deserialize_exact(bytes))?;
        let msg = protocol(msg.try_into_protocol_message())?;
        let processed = protocol(group.process_message(&self.provider, msg))?;
        let sender = match processed.sender() {
            Sender::Member(index) => {
                let member = group
                    .members()
                    .find(|m| m.index == *index)
                    .ok_or(Error::Trust)?;
                self.check_credential(&member.credential, &member.signature_key)?
            }
            _ => return Err(Error::Trust),
        };
        match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(message) => {
                self.check_roster(&group, expected)?;
                Ok(Received::Application {
                    sender,
                    body: message.into_bytes(),
                })
            }
            ProcessedMessageContent::StagedCommitMessage(commit) => {
                protocol(group.merge_staged_commit(&self.provider, *commit))?;
                self.check_roster(&group, expected)?;
                Ok(Received::Commit)
            }
            // No unauthenticated external joins or standalone proposals.
            _ => Err(Error::Input),
        }
    }
    fn snapshot_bytes(&mut self) -> Result<Zeroizing<Vec<u8>>> {
        self.snapshot.storage = self
            .provider
            .storage()
            .values
            .read()
            .map_err(|_| Error::State)?
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let result = serde_json::to_vec(&self.snapshot)
            .map(Zeroizing::new)
            .map_err(|_| Error::State);
        for (_, value) in &mut self.snapshot.storage {
            value.zeroize();
        }
        self.snapshot.storage.clear();
        result
    }
    fn from_bytes(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_STATE {
            return Err(Error::State);
        }
        let mut snapshot: Snapshot = serde_json::from_slice(bytes).map_err(|_| Error::State)?;
        if snapshot.version != 1 {
            return Err(Error::State);
        }
        snapshot.device.identity()?;
        let provider = OpenMlsRustCrypto::default();
        *provider
            .storage()
            .values
            .write()
            .map_err(|_| Error::State)? = snapshot.storage.drain(..).collect();
        Ok(Self { provider, snapshot })
    }
    fn copy(&mut self) -> Result<Self> {
        Self::from_bytes(&self.snapshot_bytes()?)
    }
    /// Runs a command transactionally. Failed authentication/policy checks never
    /// consume a receive key or persist a partially merged commit.
    pub fn transaction<T>(&mut self, f: impl FnOnce(&mut Self) -> Result<T>) -> Result<T> {
        let mut candidate = self.copy()?;
        let output = f(&mut candidate)?;
        if candidate.snapshot_bytes()?.len() > MAX_STATE {
            return Err(Error::State);
        }
        *self = candidate;
        Ok(output)
    }
    pub fn seal(&mut self, master: &[u8; 32]) -> Result<Vec<u8>> {
        let state = self.snapshot_bytes()?;
        if state.len() > MAX_STATE {
            return Err(Error::State);
        }
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut nonce);
        let aad = self.snapshot.device.identity()?;
        let cipher = Aes256Gcm::new(master.into());
        let encrypted = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &state,
                    aad: &aad,
                },
            )
            .map_err(|_| Error::State)?;
        let mut output = b"GMLS\x01".to_vec();
        output.extend(nonce);
        output.extend(encrypted);
        Ok(output)
    }
    pub fn open(device: &Device, master: &[u8; 32], sealed: &[u8]) -> Result<Self> {
        if sealed.len() < 33 || sealed.len() > MAX_STATE + 33 || &sealed[..5] != b"GMLS\x01" {
            return Err(Error::State);
        }
        let aad = device.identity()?;
        let cipher = Aes256Gcm::new(master.into());
        let bytes = Zeroizing::new(
            cipher
                .decrypt(
                    Nonce::from_slice(&sealed[5..17]),
                    Payload {
                        msg: &sealed[17..],
                        aad: &aad,
                    },
                )
                .map_err(|_| Error::State)?,
        );
        let state = Self::from_bytes(&bytes)?;
        if &state.snapshot.device != device {
            return Err(Error::State);
        }
        Ok(state)
    }
}

mod pins_serde {
    use super::*;
    pub fn serialize<S: serde::Serializer>(
        pins: &BTreeMap<Vec<u8>, Vec<u8>>,
        s: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        pins.iter().collect::<Vec<_>>().serialize(s)
    }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(
        d: D,
    ) -> std::result::Result<BTreeMap<Vec<u8>, Vec<u8>>, D::Error> {
        Ok(Vec::<(Vec<u8>, Vec<u8>)>::deserialize(d)?
            .into_iter()
            .collect())
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        if let Ok(mut values) = self.provider.storage().values.write() {
            for value in values.values_mut() {
                value.zeroize();
            }
            values.clear();
        }
        for (_, value) in &mut self.snapshot.storage {
            value.zeroize();
        }
    }
}

pub mod bridge;
