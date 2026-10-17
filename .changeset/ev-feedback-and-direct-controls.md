---
"ftw-webapp": patch
---

Read the current FTW charge-level and schedule fields, including a plugged car at zero percent. Charging feedback follows the charger's status instead of treating a received request as proof of charging. Show unavailable readings and recover when contact returns.

Apply schedule edits and changes to a running manual current without Save or Update. Keep an ongoing charge-level drag when an earlier response arrives. Keep failed requests visible, poll only while the panel is visible, and keep keyboard focus inside the dialog.

Keep the charging goal and solar rule together, with no mode tabs. Show when Charge now overrides them. Show the current slider only while manual charging is active. Opening goal settings does not send a command.

Preserve one-off goals and the home battery threshold for solar when editing a schedule.
