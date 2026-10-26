//! Serialized boundary used by the bundled client worker. Never logs inputs.
use crate::{Device, Engine, Error, Received, VerifiedDevice};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Deserialize;
use serde_json::{json, Value};
use zeroize::Zeroizing;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    device: Device,
    master: String,
    state: Option<String>,
    command: Command,
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Command {
    Identity,
    Cancel {
        conversation: String,
        bootstrap: bool,
    },
    AuthorizeSession {
        session_id: String,
    },
    Verify {
        peer: VerifiedDevice,
    },
    KeyPackage,
    Create {
        conversation: String,
    },
    Add {
        conversation: String,
        packages: Vec<String>,
        roster: Vec<Device>,
    },
    Join {
        conversation: String,
        welcome: String,
        roster: Vec<Device>,
    },
    Accept {
        conversation: String,
        roster: Vec<Device>,
    },
    Update {
        conversation: String,
    },
    Remove {
        conversation: String,
        removed: Vec<Device>,
        roster: Vec<Device>,
    },
    Encrypt {
        conversation: String,
        body: String,
        roster: Vec<Device>,
    },
    Receive {
        conversation: String,
        message: String,
        roster: Vec<Device>,
    },
}
fn decode(value: &str) -> Result<Vec<u8>, Error> {
    STANDARD.decode(value).map_err(|_| Error::Input)
}
fn execute(request: Request) -> Result<Value, Error> {
    let key = Zeroizing::new(decode(&request.master)?);
    let master: &[u8; 32] = key.as_slice().try_into().map_err(|_| Error::Input)?;
    let mut engine = match request.state {
        Some(s) => Engine::open(&request.device, master, &decode(&s)?)?,
        None => {
            if !matches!(request.command, Command::Identity) {
                return Err(Error::State);
            }
            Engine::new(request.device)?
        }
    };
    let output = match request.command {
        Command::Identity => json!(engine.public_identity()),
        Command::Cancel {
            conversation,
            bootstrap,
        } => {
            use openmls_traits::OpenMlsProvider;
            engine.transaction(|e| {
                let mut group = e.group(&conversation)?;
                if bootstrap {
                    group
                        .delete(e.provider.storage())
                        .map_err(|_| Error::State)?;
                } else {
                    group
                        .clear_pending_commit(e.provider.storage())
                        .map_err(|_| Error::State)?;
                }
                Ok(())
            })?;
            json!(null)
        }
        Command::AuthorizeSession { session_id } => {
            use openmls_traits::signatures::Signer;
            if session_id.is_empty() || session_id.len() > 256 {
                return Err(Error::Input);
            }
            let identity = engine.public_identity();
            let message = serde_json::to_vec(&[
                "ghostel-device-session-v1",
                &identity.device.user_id,
                &identity.device.device_id,
                &session_id,
            ])
            .map_err(|_| Error::Input)?;
            json!(STANDARD.encode(
                engine
                    .snapshot
                    .signer
                    .sign(&message)
                    .map_err(|_| Error::Protocol)?
            ))
        }
        Command::Verify { peer } => {
            engine.verify_device(peer)?;
            json!(null)
        }
        Command::KeyPackage => json!(STANDARD.encode(engine.key_package()?)),
        Command::Create { conversation } => {
            engine.create(&conversation)?;
            json!(null)
        }
        Command::Add {
            conversation,
            packages,
            roster,
        } => {
            let packages = packages
                .iter()
                .map(|p| decode(p))
                .collect::<Result<Vec<_>, _>>()?;
            let commit = engine.add(&conversation, &packages, &roster)?;
            json!({"message":STANDARD.encode(commit.message),"welcome":commit.welcome.map(|w| STANDARD.encode(w))})
        }
        Command::Join {
            conversation,
            welcome,
            roster,
        } => {
            engine.join(&conversation, &decode(&welcome)?, &roster)?;
            json!(null)
        }
        Command::Accept {
            conversation,
            roster,
        } => {
            engine.accept_commit(&conversation, &roster)?;
            json!(null)
        }
        Command::Update { conversation } => {
            let commit = engine.update(&conversation)?;
            json!({"message":STANDARD.encode(commit.message)})
        }
        Command::Remove {
            conversation,
            removed,
            roster,
        } => {
            let commit = engine.remove(&conversation, &removed, &roster)?;
            json!({"message":STANDARD.encode(commit.message)})
        }
        Command::Encrypt {
            conversation,
            body,
            roster,
        } => json!(STANDARD.encode(engine.encrypt(&conversation, body.as_bytes(), &roster)?)),
        Command::Receive {
            conversation,
            message,
            roster,
        } => match engine.receive(&conversation, &decode(&message)?, &roster)? {
            Received::Application { sender, body } => {
                json!({"kind":"application","sender":sender,"body":String::from_utf8(body).map_err(|_| Error::Input)?})
            }
            Received::Commit => json!({"kind":"commit"}),
        },
    };
    Ok(json!({"state": STANDARD.encode(engine.seal(master)?), "output": output}))
}
/// A failed operation never returns a state to persist. Input/output are confined
/// to a local worker. The host must commit state+outbox before returning success.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen::prelude::wasm_bindgen)]
pub fn invoke(input: &str) -> String {
    if input.len() > 48 * 1024 * 1024 {
        return json!({"error":"input_limit"}).to_string();
    }
    let result = serde_json::from_str::<Request>(input)
        .map_err(|_| Error::Input)
        .and_then(execute);
    match result {
        Ok(value) => value.to_string(),
        Err(error) => json!({"error": error.to_string()}).to_string(),
    }
}
