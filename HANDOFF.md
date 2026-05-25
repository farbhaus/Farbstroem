# Farbström — feature brief: in-room file display + streaming uploads + host delete (#104 and follow-ups)

You are picking up work on the Farbström repo. **Start from a fresh branch off `dev`** — a previous attempt on `display-uploads` got tangled and we're scrapping it. The features below are well-scoped and have a couple of subtle pitfalls; this brief tells you the final design we converged on, the order to build in, and exactly which footguns to avoid.

## Read first

- `CLAUDE.md` (repo root) — architecture, dev commands, conventions. Especially the "Frontend structure", "Backend structure", and "Key implementation details" sections.
- `frontend/viewer/player.ts` on `dev` — this is the live-broadcast OvenPlayer wiring you'll be extending. Treat its current shape as the contract for live mode and don't change behavior there.
- `frontend/viewer/types.ts` for `Role`, `RoomStatus`, `TileId`, `SessionFile`, `WsMessage`, `WsClientMessage`.
- `backend/src/ws.rs` — patterns for `WS_ROOM_FOCUS` (in-memory per-room transient state) and the `handle_text_message` match for presenter-only message types.
- `backend/src/routes/files.rs` — `MAX_FILE_SIZE`, `ParticipantQuery`, `validate_participant`, `upload_file`, `download_file`, `delete_draft_file`, `sanitize_mime`, `extract_extension`.
- `backend/src/events.rs` — `FileSharedEvent`, `FileUnsharedEvent`, broadcast channels.

## The features

1. **Display uploaded files in the room (#104).** A presenter (host) can pick an image or video the room already has and "Show" it to everyone. The room's main stage tile renders it. Closing it returns to whatever was there before (live stream or nothing).
2. **Streaming uploads.** The upload handlers slurp the whole multipart field into memory today; with bigger files this OOMs. Stream chunks to disk instead.
3. **Larger file ceiling.** Bump `MAX_FILE_SIZE` from 100 MB to **2.5 GB**.
4. **Host delete on shared files.** A trash button next to "Get" on every shared file in the room (chat row + Files panel). Presenter-only.
5. **".mov with H.264 inside" plays in Chromium.** Many phones / cameras export `video/quicktime` containers holding H.264. Chrome/Firefox refuse the QuickTime container upfront. Backend trick: on the in-room display path, relabel `video/quicktime` → `video/mp4` so the browser accepts it. Files served via the regular "Get" download keep their true mime.

## Design decisions we converged on (do these — don't relitigate)

- **One OvenPlayer instance for the stage tile.** The existing `#tile-stream` keeps mounting OvenPlayer at `#player`. The instance's source swaps between the **live broadcast** (LL-HLS / WebRTC) and a **file video** (MP4 / WebM / H.264-MOV). The toolbar play/pause/mute/volume buttons already target the singleton, so they "just work" for whichever source is loaded — no rewiring.
- **Images don't go through OvenPlayer.** OvenPlayer is video-only (confirmed via their docs — supported `type` values are streaming protocols + mp3/m4a, no image type). Render images as a separate `<img id="display-img">` overlay *inside* `#tile-stream > .tile-inner`, sibling to `#player`. Hide/show by toggling `display`. When an image is shown, OvenPlayer is destroyed; when cleared, OvenPlayer is recreated for the live stream (if any). **Do NOT give the `<img>` its own `background: #000`** — the parent `.tile` already paints black; an `<img>` element forced to 100%×100% with `background:#000` paints a full-tile black rectangle on top of `#player` if it ever ends up `display:''` without a src.
- **Source swap = destroy + recreate the OvenPlayer instance.** OvenPlayer's `load(sources)` exists but the types don't declare it and crossing providers (WebRTC → MP4) needs full re-init anyway. ~200 ms hiccup is acceptable for the explicit Show/Hide action.
- **Server is source of truth for what's being displayed.** Per-room in-memory `WS_ROOM_DISPLAY` map in `backend/src/ws.rs` holds `{ file_id, name, mime, size, playing, position, updated_at_ms }`. Late joiners get a `display:state` replay on auth. Mirrors how `WS_ROOM_FOCUS` already works.
- **Presenter-only control of Show / Hide / play / pause / seek on the displayed file.** Server validates `role == "presenter"` on `display:set` and `display:transport`, same gate as the existing `focus:set`.
- **Synchronized video transport.** Presenter's `play`/`pause`/`seek` events on the OvenPlayer file instance get echoed as `display:transport` → server merges into `WS_ROOM_DISPLAY` and broadcasts → viewers apply. Use a `suppressTransport` counter so applying a server update doesn't bounce back.
- **`canShow` filter** for the "Show" button: `image/*`, `video/mp4`, `video/webm`, `video/quicktime`. ProRes / DNxHD MOVs will still fail at *decode* time — handle that on the OvenPlayer `error` event by sending `display:set { fileId: null }` and toasting the presenter.
- **Streaming upload helper module.** New `backend/src/uploads.rs` exports `stream_field_to_temp(field, files_dir, max_bytes) -> StoredUpload { temp_name, size, sha256_hex }`. Writes to `{files_dir}/.tmp-<uuid>`, hashes incrementally, enforces size cap, deletes the temp on any error before returning. Same dir as final blobs so the eventual rename is atomic. Also export `sweep_stale_temps(dir, max_age)` and call it once at backend startup from `main.rs`.
- **Host delete reuses the existing `DELETE /api/public/rooms/:slug/files/:fileId` route.** The handler branches:
  - If the file is an un-shared draft owned by the requester → existing draft-cleanup behavior.
  - Else if the requester is a presenter in this room AND the file is visible in this room → host delete: if `session_files.room_id` matches this room, drop the row + reclaim the blob if no other row references its `stored_path`; if the file is only linked via `room_files`, just remove the `room_files` link (the library copy survives). Either path broadcasts a new `FileUnsharedEvent`.
  - Else → 404.
  - Server broadcasts `file:removed { id }` via the existing `file_unshared` channel. The frontend listens and strips the file from chat + the Files panel.

## Architecture (concrete shape)

### Backend

- `backend/src/ws.rs`:
  - Add `struct DisplayState` + `static WS_ROOM_DISPLAY: LazyLock<Arc<RwLock<HashMap<String, DisplayState>>>>` near `WS_ROOM_FOCUS`.
  - Two new presenter-only match arms in `handle_text_message`:
    - `"display:set"` — `{ fileId: string | null }`. If non-null, validate file is visible in this room (same SQL as the public `list_files`: file is `is_shared = 1` and `room_id = current_room` OR linked via `room_files`). Insert into `WS_ROOM_DISPLAY` with `playing=false, position=0, updated_at_ms=now`. If null, remove. Broadcast `display:state` (full JSON or `{type:"display:state", fileId:null}`).
    - `"display:transport"` — `{ playing: bool, position: f64 }`. Merge into the current `WS_ROOM_DISPLAY` entry, update `updated_at_ms`, rebroadcast.
  - Extend the `focus:set` valid tiles to also accept `"display"` if you want hosts to be able to pin it; with the unified tile approach you can keep tiles as `"stream" | "share"` and let the broadcast/file share `"stream"`. **We landed on the unified approach — keep TileId at `"stream" | "share"`** and don't add `"display"`.
  - In `handle_socket`'s auth-success block, after the focus replay, also replay the display state if `WS_ROOM_DISPLAY.get(slug)` is Some.
  - In `start_disconnect_timer`, after removing the room from `WS_ROOMS` when it's empty, **also clear `WS_ROOM_DISPLAY.remove(slug)` and `WS_ROOM_FOCUS.remove(slug)`**. This is load-bearing — otherwise a stale display from yesterday's test session persists and the next person to join sees the file player mount instead of the live stream.
  - In the `room:ended` listener, also clear both maps for that slug.

- `backend/src/routes/files.rs`:
  - `MAX_FILE_SIZE` → `2560 * 1024 * 1024` (2.5 GB).
  - Extend `ParticipantQuery` with `display: Option<String>` (parsed as `"1" | "true"`).
  - In `download_file`: if `display` is truthy, set `Content-Disposition: inline` (not `attachment; filename=...`) AND relabel served mime from `video/quicktime` → `video/mp4` (other mimes pass through). Keep `X-Content-Type-Options: nosniff`.
  - Rewrite `upload_file` to use `stream_field_to_temp`. Dedup logic unchanged: hash match → delete temp + reuse existing id; miss → rename temp to `{new_id}{ext}`.
  - **Rename `delete_draft_file` to `delete_room_file`** and extend per the host-delete branch above. Use a small `enum DeleteOutcome { NotFound, DraftCleanup { stored_path }, HostHardDelete { stored_path }, HostUnassign }` to keep the post-DB blob cleanup + broadcast logic clear.

- `backend/src/routes/admin_files.rs`:
  - `MAX_FILE_SIZE` → 2.5 GB to match.
  - Rewrite `upload_library_file` AND `replace_file` to use `stream_field_to_temp`.

- **New** `backend/src/uploads.rs`:
  ```rust
  pub struct StoredUpload {
      pub temp_name: String,
      pub size: u64,
      pub sha256_hex: String,
  }
  pub async fn stream_field_to_temp(
      field: &mut axum::extract::multipart::Field<'_>,
      files_dir: &str,
      max_bytes: u64,
  ) -> Result<StoredUpload, AppError>;
  pub async fn sweep_stale_temps(files_dir: &str, max_age: std::time::Duration);
  ```
  Loop `field.chunk().await`, write to `{files_dir}/.tmp-<uuid>`, hash with `Sha256`, abort+remove temp on oversize or any error.

- `backend/src/lib.rs`: `pub mod uploads;`.
- `backend/src/main.rs`: call `stream_backend::uploads::sweep_stale_temps(&format!("{}/files", state.config.data_path), Duration::from_secs(3600)).await;` once during startup, before spawning background tasks.

### Frontend

- `frontend/viewer/types.ts`:
  - Add `DisplayFileState { fileId; name; mime; size; playing; position; updatedAtMs }`.
  - Add `mime?: string` to `SessionFile`.
  - Add `mime?: string` to the existing `file:shared` WS message variant.
  - Add `file:removed { id }` variant to `WsMessage`.
  - Add `display:state { fileId: string | null; name?; mime?; size?; playing?; position?; updatedAtMs? }` variant to `WsMessage`.
  - Add `display:set { fileId: string | null }` and `display:transport { playing: bool; position: number }` variants to `WsClientMessage`.

- `frontend/viewer/state.ts`:
  - Add `displayFile: { fileId; name; mime } | null` to `ViewerState`. Initial `null`.
  - Drives the Show/Hide button label and the unified-stage refresh.

- `frontend/viewer/player.ts` — **extend, don't rewrite the live path**. The dev version of `initPlayer` works perfectly for live broadcast; don't change its OvenPlayer config, its event-handler shape, or its order of operations. **Specifically, do not introduce a redundant second `stateChanged` listener for live mode** — keep the single handler that calls `syncPlayerControls()` at the top, exactly as on dev.
  - Add a module-level `mode: 'live' | 'file' | 'image' | null = null` and `currentFileId: string | null = null`.
  - Add `suppressTransport: number` counter.
  - Add `wsSend` via the existing `configurePlayer({ onPlayingChange, send })` (extend the opts).
  - In existing `initPlayer`, set `mode = 'live'` after `OvenPlayer.create(...)` and after the existing event registrations (so handler order matches dev).
  - **Gate `initPlayer` early-return on `viewerStore.get().displayFile`** — when a file is being displayed, leave the stage to `applyDisplayState`.
  - Add `initFilePlayer(fileId)` — destroys current OvenPlayer, hides the image overlay, creates a new OvenPlayer with `sources: [{ type: 'mp4', file: fileUrl(fileId) }]`, `autoStart: true`, `mute: !isPresenter`. Wires `play` / `pause` / `seek` listeners for presenter to emit `display:transport` (gated on `suppressTransport === 0`). Wires `stateChanged` for `error` → `display:set { fileId: null }` + toast if presenter.
  - Add `showImageOverlay(url | null)` — toggles `#display-img` visibility/src. **When url, `img.style.display = '';` AND set src. When null, `display: 'none';` AND remove src. Always paired — never set display:'' without a src.**
  - Add `applyDisplayState(state | null)` — exported, called from `ws.ts`:
    - If null/no fileId: `viewerStore.set({ displayFile: null })`; `showImageOverlay(null)`; if mode was file/image, destroy player + `initPlayer()` (which mounts live if streamKey exists). Update tile visibility.
    - Else: set `displayFile` in store. Branch on mime: `image/*` → destroy player, `showImageOverlay(url)`, mode='image'. `video/{mp4,webm,quicktime}` → ensure file player (recreate only if fileId changed) + `applyTransport`. Other → no-op.
  - Add `applyTransport(state)`: predict head with elapsed-since-`updatedAtMs` when playing; if drift > 0.5 s, `player.seek(head)`. If `state.playing && !isPlaying`, `player.play()`. Reverse for pause. All wrapped in `suppressTransport++` / `--`.
  - Export `getPlayerMode()` so `main.ts` can show the right offline-overlay state.
  - **File source URL** must include `&display=1` so the backend serves it inline + mime-relabeled.

- `frontend/viewer/ws.ts`:
  - Import `applyDisplayState` from player.ts.
  - Route `display:state` → `applyDisplayState(...)`.
  - Route `file:removed` → `removeFileEverywhere(msg.id)` (new helper in chat.ts).

- `frontend/viewer/chat.ts`:
  - Add `canShow(mime)` returning true for `image/*` and `{video/mp4, video/webm, video/quicktime}`.
  - Render a presenter-only **"Show"** button next to "Get" in `appendFileMessage` (inline chat row) and `addFileToSection` (Files panel). Label is "Show" normally and "Hide" when `displayFile?.fileId === thisFile`. Click → `wsSend({ type: 'display:set', fileId: current ? null : fileId })`.
  - Render a presenter-only **trash (Delete) button** next to "Get" on every shared file row, both contexts. Click → `DELETE /api/public/rooms/:slug/files/:fileId?participantId=...&token=...`. UI removal is driven by the resulting `file:removed` broadcast — don't optimistically remove.
  - Export `removeFileEverywhere(fileId)` that strips the chat-msg row + Files-panel row + updates count badge + restores empty placeholder.
  - Export `refreshShowButtons()` that walks all `[data-action="display-show"]` and updates label/active class against `displayFile`.

- `frontend/viewer/main.ts`:
  - Subscribe to `viewerStore`; in the subscriber call `refreshConfButtons()`, `refreshShowButtons()`, and **`refreshStatusOverlay()`** (pure DOM read). **DO NOT call `setRoomStatus` from the subscriber** — see Pitfall #1.
  - Split `setRoomStatus(status, playerPlaying?)` into a state-writer (only calls `setState({status})` if `status !== current`) and a separate `refreshStatusOverlay(playerPlaying?)` (pure DOM read/write).
  - Pass `wsSend` into `configurePlayer`.

- `frontend/viewer/conference.ts`: trivial — `updateFocusAspect` for `focusedTile === 'stream'` should fall back to `#display-img` natural dimensions when the image overlay is up. `requestAutoFocus` should prefer `share > stream` (the stream tile now hosts file or live indifferently — `streamKey || displayFile` keeps it focusable).

- `www/viewer/index.html`:
  - Inside `#tile-stream > .tile-inner`, add `<img id="display-img" alt="" style="display:none">` as a **second child** after `<div id="player">`.
  - CSS for `#display-img`: `position:absolute; inset:0; z-index:6; width:100%; height:100%; object-fit:contain;`. **No `background` property.** The parent `.tile` already paints `#000`.
  - Add CSS for the new presenter Show button (`.chat-file-show`, `.file-row-show`, `.is-active` variant) and Delete button (`.chat-file-del`, `.file-row-del`).

## Implementation order (recommended)

Build in this order so you can test each piece end-to-end before stacking the next:

1. **Streaming uploads + 2.5 GB ceiling** (backend only). New `uploads.rs`, rewire the three upload handlers, bump `MAX_FILE_SIZE`. Add startup sweep. Test by uploading a 500 MB file via the existing admin UI and watching `docker stats stream-backend` stay flat.
2. **Backend display state machinery.** `WS_ROOM_DISPLAY`, `display:set` / `display:transport` handlers, hello replay, `?display=1` query on `download_file` (inline disposition + quicktime relabel). End-to-end test via `wscat` or by manually crafting WS messages.
3. **Frontend display playback.** `applyDisplayState`, file-mode OvenPlayer, image overlay, `displayFile` state, Show/Hide button on chat + Files panel, `removeFileEverywhere`. Test by uploading an MP4, clicking Show in two browser tabs, confirming sync.
4. **Host delete.** Extend the DELETE endpoint, add the trash button, wire `file:removed` route in ws.ts. Test deleting a participant-uploaded file and an admin-library file.
5. **Polish:** offline-overlay refactor, `canShow` filter tweaks, image natural-aspect handling in conference.ts.

## Pitfalls — these tripped us up; avoid them

1. **Don't recurse from the viewerStore subscriber.** `setRoomStatus` calls `setState({status})`, which fires every subscriber synchronously, even if the value didn't change. If your subscriber calls `setRoomStatus(s.status)` you get an infinite loop on the *first* notification (the store's `subscribe()` immediately invokes the callback once with current state). The page hangs before `init()` returns — nothing paints, you get a blank dark page. **Split `setRoomStatus` into a state-writer that no-ops when status is unchanged, and a pure `refreshStatusOverlay` DOM-only function that the subscriber calls.**

2. **Don't let `WS_ROOM_DISPLAY` leak across sessions.** It's in-memory per-room and ONLY cleared by explicit `display:set null` or `room:ended` in the naive design. If a presenter Shows a file and forgets to Hide before leaving, the entry persists. Next time anyone joins, the WS auth handler replays `display:state` → frontend mounts the file player instead of the live broadcast. **Clear the entry (and `WS_ROOM_FOCUS` for symmetry) in `start_disconnect_timer` when the room becomes empty.**

3. **Don't give `#display-img` its own `background: #000`.** With `position:absolute; inset:0; width:100%; height:100%`, even an empty `<img>` element (no src) will paint a full-tile black rectangle if it's ever `display:''`. With `z-index:6` that rectangle sits above `#player`. The parent `.tile` already has black; you get the same look without the failure mode.

4. **Keep `showImageOverlay(url)` strictly paired — display:'' iff src set.** Any code path that toggles display without also setting src is a black-screen bug waiting to happen.

5. **The offline overlay must have a single owner.** On dev, both `setRoomStatus` in main.ts and a 3 s setTimeout in player.ts (on error) added `.visible` to `#offline-screen`. With the new viewerStore subscriber re-running `refreshStatusOverlay`, this becomes racy and the overlay gets stuck. **Make `setRoomStatus` the sole authority** — remove the error-handler re-show in player.ts. If a live stream that was playing stops, the backend's OME poller will broadcast `room:pending` → status change → overlay shown through the proper path.

6. **OvenPlayer is video-only.** Don't try to feed it an image URL. We checked the OvenPlayer docs — supported `type` values are streaming protocols (WebRTC, LL-HLS, HLS, DASH) + audio (mp3, m4a) + progressive video (mp4). No image / jpg / png. Render images as a plain `<img>` overlay.

7. **`.mov` in Chrome/Firefox is a `Content-Type` problem, not a codec problem.** Many `.mov` files are H.264 + AAC in a QuickTime container that Chrome can decode just fine — but only if served as `Content-Type: video/mp4`. `video/quicktime` is rejected upfront regardless of inner codec. Hence the `?display=1` relabel. Don't do this for the "Get" download path (keep the true mime there).

8. **Don't add a redundant `stateChanged` listener on the live OvenPlayer.** On dev there is exactly one `stateChanged` handler that calls `syncPlayerControls()` at the top, then handles `playing` / `error`. We had a regression where the live tile stayed black on this branch and never fully isolated whether the duplicate listener or some other refactor was at fault. **Mirror dev's wiring 1:1 for live mode — only add new behavior for file mode.**

9. **Default `autoStart: true` for the file OvenPlayer too.** With `autoStart: false`, the video element renders as a blank black box until something calls `.play()`. Pair with `applyTransport` which aligns play/pause/seek to the server's state immediately after.

10. **Don't break the WS hello replay order.** New `display:state` replay goes AFTER the existing `focus:set` replay and BEFORE `send_chat_history`. The frontend assumes display state arrives before user-visible chat history.

11. **TypeScript `exactOptionalPropertyTypes` is on.** Passing `{ mime: undefined }` to a field typed `mime?: string` is an error. Use conditional spread: `...(maybe ? { mime: maybe } : {})`.

12. **Don't forget to `cargo fmt` and delete the old `display.js` from `www/dist/viewer/` if you ever introduce an intermediate display.ts module and later remove it.** `tsc` doesn't clean up stale outputs.

## Verification (do all of these before declaring done)

- `cargo fmt && cargo clippy --all-targets -- -D warnings && cargo test` — green.
- `cd frontend && npm run typecheck && npm run build` — green.
- `docker compose up -d --build stream-backend` and manually:
  - Live stream alone — plays, toolbar play/pause/mute/volume work. Confirm it still works after the refactor — this is the regression vector.
  - Upload + Show MP4 — both viewers see it, toolbar drives it, presenter play/pause/seek sync within ~0.5 s. Third tab joining mid-playback joins at the right head.
  - Upload + Show H.264-in-MOV — plays the same as MP4 (relies on backend relabel).
  - Upload + Show ProRes MOV — Show button still appears; playback fails cleanly; toast shown to presenter; display clears.
  - Upload + Show image — `<img>` overlay shows; pin works; presenter Hide returns to live stream.
  - Presenter deletes a file in a room — file vanishes from chat + Files panel + display tile (if shown) for both tabs.
  - Stop displaying when no live stream — tile shows offline overlay (correct "no stream" state).
  - Stop displaying with live stream running — tile swaps back to live, live badge returns.
  - **Empty-room cleanup:** Show a file, close all tabs, wait > 3 s for the disconnect-grace, rejoin in a fresh tab → the stage shows the live stream (or empty), not the stale file.
  - Large upload (~500 MB MP4): completes successfully; `docker stats stream-backend` shows roughly steady RSS during the upload (not climbing by 500 MB).
  - Oversize upload (>2.5 GB): rejected with `400 "File too large (max 2.5 GB)"`; no `.tmp-*` left in `{data_path}/files/`.

## What we built but are intentionally not redoing

- A separate `#tile-display` tile next to `#tile-stream`. The unified-tile approach is better; don't bring this back.
- A separate `display.ts` module. Everything lives in `player.ts` now.
- A toolbar "Display file" button + picker modal. Per-file Show button in chat + Files panel replaces it.
- An offline-overlay re-show on OvenPlayer error. `setRoomStatus` is the sole authority.
