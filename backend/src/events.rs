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
pub struct FileUnsharedEvent {
    pub slug: String,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KickedEvent {
    pub slug: String,
    pub participant_id: String,
}

/// Emitted when an admin attaches a stream key to a room. Carries the new
/// key_token so connected clients can swap it into their session and reload
/// the player without bouncing through /join (which would require re-auth
/// and, for presenters handed off via pre-session, would lose the role).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamKeyAssignedEvent {
    pub slug: String,
    pub stream_key: String,
}

#[derive(Clone)]
pub struct EventChannels {
    pub room_live: broadcast::Sender<String>,
    pub room_pending: broadcast::Sender<String>,
    pub room_ended: broadcast::Sender<String>,
    pub stream_key_assigned: broadcast::Sender<StreamKeyAssignedEvent>,
    pub stream_key_removed: broadcast::Sender<String>,
    pub file_shared: broadcast::Sender<FileSharedEvent>,
    pub file_unshared: broadcast::Sender<FileUnsharedEvent>,
    pub participant_kicked: broadcast::Sender<KickedEvent>,
}

impl EventChannels {
    pub fn new() -> Self {
        Self {
            room_live: broadcast::channel(64).0,
            room_pending: broadcast::channel(64).0,
            room_ended: broadcast::channel(64).0,
            stream_key_assigned: broadcast::channel(64).0,
            stream_key_removed: broadcast::channel(64).0,
            file_shared: broadcast::channel(64).0,
            file_unshared: broadcast::channel(64).0,
            participant_kicked: broadcast::channel(64).0,
        }
    }
}

impl Default for EventChannels {
    fn default() -> Self {
        Self::new()
    }
}
