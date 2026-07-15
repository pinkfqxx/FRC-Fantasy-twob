# FRC Fantasy Draft Discord Bot

A Discord bot for running an FRC (FIRST Robotics Competition) Fantasy Draft. Players join a draft, pick FRC teams from the season or Worlds pool, and compete based on their teams' performances.

## Project Structure

- `index.js` — Main bot file. Handles all Discord slash command interactions.
- `commands.js` — Registers slash commands with Discord's API. Run once when adding/changing commands.
- `data.json` — Persistent draft state (players, picks, phase, team pools).
- `package.json` — Node.js dependencies.

## Running the Bot

The bot starts automatically via the "Start application" workflow (`node index.js`).

To register/update slash commands with Discord (run once after changes):
```
node commands.js
```

## Environment Variables (Secrets)

All secrets are stored in Replit Secrets:
- `TOKEN` — Discord bot token
- `CLIENT_ID` — Discord application client ID
- `TBA_KEY` — The Blue Alliance API key (for fetching FRC team data)

The bot is multi-server by design and does not need a hardcoded guild or channel ID — it auto-detects both at runtime:
- **Guild**: commands are global (registered once via `node commands.js`, no per-guild ID needed at the code level), and every interaction carries its own `guildId` from Discord. On `guildCreate` the bot auto-creates a `#frc-fantasy-updates` announcements channel and saves its ID to `guild_config_<guildId>.json`.
- **Draft channel**: a server admin picks it by running `/setchannel` in the desired channel; that channel's ID is likewise saved to `guild_config_<guildId>.json`.

**Status:** Dependencies are installed, secrets (`TOKEN`, `CLIENT_ID`, `TBA_KEY`) are set, the "Start application" workflow runs `node index.js` and the bot is logged in to Discord. Slash commands have been registered globally via `node commands.js` (can take up to an hour to appear in a server — invite the bot to a server to use it).

## Slash Commands

| Command | Description |
|---|---|
| `/draftstatus open:true` | Open the draft for players to join |
| `/draftstatus open:false` | Close and fully reset the draft |
| `/join_draft` | Join the fantasy draft (while open) |
| `/start_draft` | Start the season draft (host only) |
| `/start_worlds_draft` | Start the Worlds draft — auto-calculates season standings and reverses order (host only) |
| `/pick team:<number>` | Pick an FRC team by number |
| `/standings` | Show live fantasy standings with real scores pulled from TBA |
| `/teams` | Show all players and their drafted teams |
| `/team name:<keyword>` | Search for a team by name |
| `/team_identify number:<n>` | Get a team's name by number |
| `/reset_draft confirm:RESET` | Manually reset the draft |

## Scoring System

### Season
- Each team's score = district/regional points from their **first 2 events** (type 0=Regional, 1=District)
- Points sourced from `/event/{key}/district_points` on TBA (includes qual ranking, alliance selection, playoffs, awards)
- If a team has only played **1 event**, their points are **doubled**
- Fetched live from TBA whenever `/standings` is called

### Worlds
- Each team's score = district points from their **Championship Division** event (type 3) and Finals (type 4)
- Same TBA points structure as season events

### Worlds Draft Order
- When `/start_worlds_draft` is called, season standings are calculated live from TBA
- Draft order is **reversed** from standings (worst season rank picks first — snake format)
- `lastSeasonStandings` is saved to `data.json` for reference

### Auto-Pick Heuristic (CPU picks, `/skip`, and timer auto-skip)
Auto-picks don't just chase the single top-scoring team — they use a historical, randomized heuristic so the CPU doesn't feel robotic or overfit to one lucky season:
- **Season phase:** each available team's score is the **average of its best-2-events score across the last 3 years** (current year + 2 prior), not just the current year. This is normalized per-year the same way live standings are (first 2 non-DCMP events, doubled if only 1 played) — so a team that plays 7 events and wins them all isn't unfairly favored over a team that plays 2 and wins them all; only years the team actually competed count toward its average.
- **Worlds phase:** still uses the current year's live Worlds score (`getTeamWorldsScore`), since Worlds performance is a single-season event.
- **Randomness:** instead of always taking the #1 team, the top 10 scoring teams are treated as "relatively similar" and one is picked at random from that group. Applies uniformly to CPU picks, `/skip`, and the pick-timer auto-skip.

## Draft Flow

1. Host runs `/draftstatus open:true` to open joining
2. Players run `/join_draft` to enter
3. Host runs `/start_draft` (season) — random snake draft order
4. Players take turns with `/pick team:<number>` — 6 picks each
5. Check `/standings` anytime to see live scores from TBA
6. When season is over, host runs `/start_worlds_draft` — auto-calculates final standings and sets worlds draft order
7. Worlds draft proceeds the same way with `/pick`

## Reliability: Startup Message-History Recovery
`data_<channelId>.json` is already saved to disk after every pick/join/trade, before the bot announces it in Discord — so a normal crash mid-action shouldn't lose state. As an extra safety net, on every startup (`clientReady`) the bot also replays each guild's draft-channel message history (its own past announcements) and rebuilds draft state from that if the channel shows equal-or-greater progress than the on-disk file. This protects against the JSON file itself being lost, corrupted, or rolled back independent of Discord.
- This is a best-effort heuristic parser (regex over the bot's own message text), not a full audit log — it covers joins, admin promotions, manual/CPU players, season/worlds draft starts, all 4 pick variants (`/pick`, `/manualpick`, `/skip`, timer auto-skip), `/undraft`, and completed trades.
- It only looks back to the most recent "draft closed & reset" message (`/draftstatus open:false` or `/reset_draft`), since those already purge most of the channel's bot messages anyway.
- If the scan can't find a reset boundary within ~1000 messages, it skips recovery entirely rather than risk overwriting good data with a partial rebuild.
- Note: this only makes the bot resilient to *data* loss on restart. It does not keep the bot *online* — the process still needs to be running (e.g. via a workflow) to serve Discord at all.

## Dependencies

- `discord.js` ^14.26.3 — Discord bot framework
- `@discordjs/rest` — REST API client for command registration
- `dotenv` — Environment variable loading
- `node-cron` — Cron job support
- `node-fetch` — HTTP fetch polyfill
