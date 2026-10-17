---
"ftw-webapp": patch
---

Discard Caddy's own diagnostics in front of the relay, as the escrow already does, so a proxy or TLS error no longer writes a client address or a rendezvous handle to disk.
