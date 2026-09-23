use std::{env, fs, path::PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};
use solana_pubkey::Pubkey;

const PROGRAM_ID: &str = "CW1jtAmpZWWwu3HyTACiW6W7Bwh6efcPHiha3noXbRkh";
const DEVNET_GENESIS: &str = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const DEVNET_AUTHORITY: &str = "FSyL13FTp3Yrgdo8VWpoNtpL8FS5FcSGL3tdNp1sjw2t";

fn text<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_else(|| panic!("missing public deployment field {field}"))
}

fn hex<const N: usize>(value: &str, field: &str) -> [u8; N] {
    assert!(value.len() == N * 2 && value.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()), "invalid {field} hex");
    let mut out = [0; N];
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&value[i * 2..i * 2 + 2], 16).expect("hex digit");
    }
    out
}

fn pubkey(value: &str, field: &str) -> [u8; 32] {
    let bytes = bs58::decode(value).into_vec().unwrap_or_else(|_| panic!("invalid {field} base58"));
    assert!(bytes.len() == 32 && bytes.iter().any(|b| *b != 0), "invalid {field} identity");
    let mut out = [0; 32];
    out.copy_from_slice(&bytes);
    assert!(bs58::encode(&out).into_string() == value, "noncanonical {field} base58");
    out
}

fn array(value: &[u8]) -> String {
    format!("[{}]", value.iter().map(u8::to_string).collect::<Vec<_>>().join(","))
}

fn emit(enabled: bool, genesis: [u8; 32], deployment: [u8; 32], config: [u8; 32], initializer: [u8; 32], admin: [u8; 32], policy_hash: [u8; 32], policy_bytes: [u8; 652]) {
    let code = format!(
        "pub const DEPLOYMENT_ENABLED: bool = {enabled};\n\
         pub const GENESIS: [u8;32] = {};\n\
         pub const DEPLOYMENT_ID: [u8;32] = {};\n\
         pub const CONFIG_ADDRESS: anchor_lang::prelude::Pubkey = anchor_lang::prelude::Pubkey::new_from_array({});\n\
         pub const EXPECTED_INITIALIZER: anchor_lang::prelude::Pubkey = anchor_lang::prelude::Pubkey::new_from_array({});\n\
         pub const EXPECTED_INITIAL_ADMIN: anchor_lang::prelude::Pubkey = anchor_lang::prelude::Pubkey::new_from_array({});\n\
         pub const INITIAL_POLICY_HASH: [u8;32] = {};\n\
         pub const INITIAL_POLICY_BYTES: [u8;652] = {};\n",
        array(&genesis), array(&deployment), array(&config), array(&initializer),
        array(&admin), array(&policy_hash), array(&policy_bytes),
    );
    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    fs::write(out.join("deployment.rs"), code).expect("write deployment constants");
}

fn main() {
    println!("cargo:rerun-if-env-changed=CROSSFLOW_DEPLOYMENT_MANIFEST");
    let Ok(file) = env::var("CROSSFLOW_DEPLOYMENT_MANIFEST") else {
        println!("cargo:warning=CrossFlow deployment constants disabled; configuration initialization must reject");
        emit(false, [0; 32], [0; 32], [0; 32], [0; 32], [0; 32], [0; 32], [0; 652]);
        return;
    };
    assert!(!file.is_empty(), "empty deployment manifest path");
    let requested_path = PathBuf::from(&file);
    let manifest_path = if requested_path.is_absolute() {
        requested_path
    } else {
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(requested_path)
    };
    println!("cargo:rerun-if-changed={}", manifest_path.display());
    let raw = fs::read_to_string(&manifest_path).expect("read public deployment manifest");
    let manifest: Value = serde_json::from_str(&raw).expect("parse public deployment manifest");
    let object = manifest.as_object().expect("deployment manifest object");
    let fields = ["schema_version", "cluster", "program_id", "genesis", "deployment_id", "config_address",
        "expected_initializer", "expected_initial_admin", "fixture_publisher", "initial_policy_hash", "policy_bytes_hex", "policy"];
    assert!(object.len() == fields.len() && fields.iter().all(|field| object.contains_key(*field)), "unknown/missing deployment field");
    assert!(text(&manifest, "schema_version") == "1", "unsupported deployment schema");
    let cluster = text(&manifest, "cluster");
    assert!(cluster == "localnet" || cluster == "devnet", "unsupported deployment cluster");
    assert!(text(&manifest, "program_id") == PROGRAM_ID, "wrong program ID");
    let program = pubkey(PROGRAM_ID, "program_id");
    let genesis = pubkey(text(&manifest, "genesis"), "genesis");
    let deployment = hex::<32>(text(&manifest, "deployment_id"), "deployment_id");
    assert!(deployment.iter().any(|b| *b != 0), "zero deployment ID");
    let config = pubkey(text(&manifest, "config_address"), "config_address");
    let expected_config = Pubkey::find_program_address(&[b"config", &deployment], &Pubkey::new_from_array(program)).0;
    assert!(config == expected_config.to_bytes(), "wrong config PDA");
    let initializer = pubkey(text(&manifest, "expected_initializer"), "expected_initializer");
    let admin = pubkey(text(&manifest, "expected_initial_admin"), "expected_initial_admin");
    let publisher = pubkey(text(&manifest, "fixture_publisher"), "fixture_publisher");
    if cluster == "devnet" {
        assert!(text(&manifest, "genesis") == DEVNET_GENESIS &&
            text(&manifest, "expected_initializer") == DEVNET_AUTHORITY &&
            text(&manifest, "expected_initial_admin") == DEVNET_AUTHORITY &&
            text(&manifest, "fixture_publisher") == DEVNET_AUTHORITY, "unapproved devnet identity");
    } else {
        assert!(text(&manifest, "genesis") != DEVNET_GENESIS, "local manifest on devnet genesis");
    }
    let policy_hash = hex::<32>(text(&manifest, "initial_policy_hash"), "initial_policy_hash");
    let policy_bytes = hex::<652>(text(&manifest, "policy_bytes_hex"), "policy_bytes_hex");
    assert!(&policy_bytes[0..8] == b"CFLCFG01" && policy_bytes[8..40] == genesis &&
        policy_bytes[40..72] == program && policy_bytes[72..104] == config &&
        policy_bytes[104..108] == 1u32.to_le_bytes() && policy_bytes[108] == 0 &&
        policy_bytes[109] < 3 && policy_bytes[110] == 3, "policy domain/header mismatch");
    assert!(policy_bytes[618..650] == publisher, "policy publisher mismatch");
    let digest: [u8; 32] = Sha256::digest(policy_bytes).into();
    assert!(digest == policy_hash, "policy hash mismatch");
    emit(true, genesis, deployment, config, initializer, admin, policy_hash, policy_bytes);
}
