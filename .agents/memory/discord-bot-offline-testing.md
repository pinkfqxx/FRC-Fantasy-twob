---
name: Testing a live Discord bot without a second gateway session
description: How to safely test a production Discord bot's command handlers offline, without touching the running workflow's connection
---

Guard `client.login(...)` behind `if (require.main === module)` at the bottom of the bot's entry file, and export the `client` instance (plus any pure helper functions needed) via `module.exports`. This lets a standalone test script `require()` the bot file — registering all `client.on(...)` listeners — without opening a second Discord gateway connection alongside the already-running production workflow.

**Why:** Opening a second login with the same bot token while the live workflow is running risks session conflicts; but testing command-handling logic against real on-disk data files (or via synthetic `client.emit('interactionCreate', fakeInteraction)` calls) is very valuable before restarting the live bot with risky changes.

**How to apply:** In a `/tmp` test script, `require()` the bot file, build a minimal fake interaction object (stub `reply`/`deferReply`/`editReply`, `options.getSubcommand/getString/getInteger/getBoolean/getUser`, `isChatInputCommand`/`isButton`/etc. returning false as needed, `guild`, `channel`, `user`), then call `client.emit('interactionCreate', fakeInteraction)` and assert on the captured reply text or resulting file-system side effects. Use a distinct fake guild/channel ID so cleanup never touches real production data files.
