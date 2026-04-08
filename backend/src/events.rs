use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSharedEvent {
    pub slug: String,
    pub id: String,
    pub participant_id: String,
    pub uploader_name: String,
    pub role: String,
    pub name: String,
    pub size: u64,
    pub mime: String,
    pub ts: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KickedEvent {
    pub slug: String,
    pub participant_id: String,
}

#[derive(Clone)]
pub struct EventChannels {
    pub room_live: broadcast::Sender<String>,
    pub room_pending: broadcast::Sender<String>,
    pub room_ended: broadcast::Sender<String>,
    pub file_shared: broadcast::Sender<FileSharedEvent>,
    pub participant_kicked: broadcast::Sender<KickedEvent>,
}

impl EventChannels {
    pub fn new() -> Self {
        Self {
            room_live: broadcast::channel(64).0,
            room_pending: broadcast::channel(64).0,
            room_ended: broadcast::channel(64).0,
            file_shared: broadcast::channel(64).0,
            participant_kicked: broadcast::channel(64).0,
        }
    }
}
