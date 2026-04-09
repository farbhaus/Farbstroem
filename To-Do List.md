# Rust rewrite bugs to fix: 
- [ ] Room File upload: Can't ulpoad .mp4 or .mov, unsure if it's file size related or due to file type.
- [ ] When exiting and rejoining the room the files persist but their place in the chat sequence is lost. i.e. they only appear at the botom in the file block.
- [ ] Mute participant button doesn't work
- [ ] Rooms are configured to either load the WebRTC or HLS player. This is defined in the admin page, in testing high latency is indicative that only the hls player is being loaded and room config in admin page is being ignored - in admin UI webRTC is selected but the actual player in the room remains the HLS player
- [ ] Part of the image in OvenPlayer shifts position and resets when moving the mouse over it (not talking about the html pointer overlay).
- [ ] When building this message appears: #19 26.42 warning: `stream-backend` (lib) generated 8 warnings (run `cargo fix --lib -p stream-backend` to apply 8 suggestions)

# General
- [ ] Create README.md with instructions on how to test and deploy this project as well as overview of project architecture.
- [ ] Cleanup Streaming.md it's too stuffed
- [ ] Create and test a setup script for development & deployment
- [ ] Test room expiration and verify auto-cleanup
# Admin:
- [ ] replace  <span class="brand">Stream — Admin</span>  - with logo
- [ ] main-nav: Add “Files” tab with ability to manage files uploaded to rooms. Include ability to upload files as well as add/remove files to existing rooms.
- [ ] main-nav: Add "Dashboard" tab showing server performance metrics
- [ ] Branding tab - Expand functionality: add ability to change admin and room color palette.
- [ ] Waiting room approval: Reduce time it takes for a participant request to appear in the waiting room tab in admin.
- [ ] Presenter “enter room” button: window to input presenter name should match style.
- [ ] Expiration date and hour: is it based on the timezone of the server? If so adjust to timezone of the browser/IP accessing the admin page.
# Room: 
- [ ] Branding BG image doesn’t appear on https://stream.domain.com/
- [ ] Presenter and participants need to be able to change their Video & audio device inputs at any time: Add gear icon where participants can choose video & audio device 
- [ ] (Maybe) If a participant selects camera on when joining room then auto open conference
- [ ] Pointer overlay needs to match icon in the menu bar (Classic Mouse icon)
- [ ] Conference column participants with video&mic on appear in watch only div (id="conf-viewers”) simultaneously. Remove watch only div, every participant in the room needs a conference tile even if cam&mic are off.
- [ ] Room design isn’t coherent. Conference & Chat columns are square & have edges but the the control strip has rounded icons, much more modern. Consolidate design to match that of Control Strip 
- [ ] Participant connection tester - each participant can test their connection quality & speed, this can be usefull if a participant is having issues with the stream and/or call

# Research
- [ ] ?Email invitation? - research open source project for email forwarding to clients
- [ ] ?Load balancer? - to guarantee stream integrity 


