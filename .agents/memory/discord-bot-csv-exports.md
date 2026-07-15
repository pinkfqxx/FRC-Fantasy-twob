---
name: Discord bot text/CSV exports must resolve real usernames
description: Discord mention markup renders fine in-chat but is unusable raw text outside Discord (CSV, logs, exports)
---

Helper functions that build in-Discord message text (e.g. player display helpers returning `<@id>` mention markup) look correct when rendered by Discord, but any export path that leaves Discord — CSV files, plain-text logs, webhooks to non-Discord systems — must resolve the mention to a real display name instead.

**Why:** A CSV export bug looked like "no usable files" to the user, but the files were valid; every player name column just contained raw `<@123456789>` markup because the export reused the same helper used for in-chat messages.

**How to apply:** For any export/report feature, add a dedicated async name-resolution helper (e.g. `guild.members.fetch` → fallback to `client.users.fetch` → fallback to a placeholder) rather than reusing chat-display helpers, and use it specifically on the export path.
