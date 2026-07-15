---
name: /nuke command maintenance
description: Rules for keeping /nuke in sync whenever new features add persistent server state.
---

# /nuke command maintenance

## Rule
Whenever a significant new feature introduces new persistent server state — new fields in `guild_config_<guildId>.json`, new `data_<channelId>.json` fields, new Discord channels/roles the bot manages, or new cache data written to disk — update the `/nuke` command so it resets or recreates that state too.

**Why:** `/nuke` is the recovery tool for servers on old bot versions or with corrupted/missing config. If it doesn't know about a new resource, running it on an old server will leave stale pre-feature data in place, defeating the point of the command.

**How to apply:**
1. Find the `/nuke` slash command handler in `index.js` (search `commandName === 'nuke'`). This is the first confirmation step — add a description of the new thing to the warning embed so users know what will be wiped.
2. Find the `nuke_confirm` button handler (search `nuke_confirm`). This is where the actual work happens — add a cleanup/reset step there, following the numbered step pattern already in place.
3. Update the step list comment block above `nuke_confirm` to document the new step.
