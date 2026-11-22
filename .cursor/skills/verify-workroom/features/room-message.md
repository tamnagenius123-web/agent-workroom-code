# Room message

Posting to `room_main` requires an authenticated principal. This worker does not issue one.

The drive does not insert a message and does not write message text into evidence. Launch still inserts the empty `rooms` row `room_main` so the local schema has the room.
