---
"ftw-webapp": patch
---

Retry brief busy refusals so charging status can recover without a reload. Expire queued API calls and discard them on disconnect. Never retry a write after a timeout or a lost answer.
