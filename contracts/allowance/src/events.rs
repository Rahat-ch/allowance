//! NEP-297 events, so explorers and indexers can follow every Spend Request,
//! including Blocked ones that aren't stored.

use near_sdk::serde::Serialize;
use near_sdk::serde_json::{Value, json};
use near_sdk::env;

pub const STANDARD: &str = "allowance";
pub const VERSION: &str = "1.0.0";

pub fn emit(event: &str, data: impl Serialize) {
    let data: Value = near_sdk::serde_json::to_value(data).expect("event data serializes");
    let log = json!({ "standard": STANDARD, "version": VERSION, "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{log}"));
}
