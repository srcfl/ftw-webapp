---
"ftw-webapp": patch
---

The relay can carry a watch's commands. A box opens a second socket, the exchange socket, and a watch posts one sealed message at a time to `/x/<epoch>/<handle>`. The relay reads only the 16-byte id it puts in front of each message, an exchange never takes a phone's stream place, and Caddy writes no access log line for these requests. A box that opens no exchange socket works as before.
