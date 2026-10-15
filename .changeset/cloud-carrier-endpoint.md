---
"ftw-webapp": patch
---

Send the same sealed relay frames to FTW Cloud when `VITE_CARRIER=cloud`, and fall back to relay.ftw.energy if that host does not speak them. The default build still dials the relay.
