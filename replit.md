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
- **Draft channel**: a server admin picks it by running `/admin setchannel` in the desired channel; that channel's ID is likewise saved to `guild_config_<guildId>.json`.

**Status:** Dependencies are installed, secrets (`TOKEN`, `CLIENT_ID`, `TBA_KEY`) are set, the "Start application" workflow runs `node index.js` and the bot is logged in to Discord. Slash commands have been registered globally via `node commands.js` (can take up to an hour to appear in a server — invite the bot to a server to use it).

## Slash Commands

Commands are grouped into a handful of top-level commands with subcommands (rather than ~35 flat commands) so Discord's command list stays short while typing `/draft`, `/pick`, etc. still autocompletes every related action. A single command set is always registered — handlers gate behavior at runtime off `data.draftOpen`/`data.phase`, there's no more swapping the registered command list when the draft opens/closes.

| Command | Description |
|---|---|
| `/draft status open:true\|false` | Open the draft for joining, or close + fully reset it |
| `/draft join` | Join the fantasy draft (while open) |
| `/draft addbot` | Add a CPU auto-picker (up to 3 per draft) |
| `/draft start mode:season\|worlds` | Start the season draft, or the Worlds draft (auto-calculates season standings and reverses order) — host only |
| `/draft order` | Show the upcoming pick order |
| `/draft timer minutes:<n>` | Set the auto-skip timer; `0` disables it — admin only |
| `/draft reset confirm:RESET` | Reset the draft |
| `/draft hardreset confirm:HARDRESET` | Nuclear option — wipes all draft data files and the server's config for this guild when things are bugged beyond repair. Gated on Discord's native "Manage Server" permission (not the bot's internal admin list, since that list could itself be corrupted) |
| `/pick team team:<number>` | Pick an FRC team by number |
| `/pick manual player:<name> team:<number>` | Pick on behalf of a manual (non-Discord) player — admin only |
| `/pick skip` | Auto-pick the best available team for your turn |
| `/pick undo team:<number>` | Undo a pick — admin only |
| `/trade propose offer:<n> request:<n>` | Propose a team swap |
| `/trade accept` / `/trade decline` | Accept or decline a pending trade |
| `/trade lock mode:auto\|locked\|open` | Override the trade lock — admin only |
| `/team search name:<keyword>` | Search for a team by name |
| `/team identify number:<n>` | Get a team's name by number |
| `/team score team:<number>` | Full point breakdown for one FRC team |
| `/stats standings` | Show live fantasy standings with real scores pulled from TBA |
| `/stats teams` / `/stats roster` | Show all players and their drafted teams |
| `/stats myteams` | Your personal team scores (private) |
| `/stats breakdown player:<@mention\|name\|ALL>` | Detailed breakdown for one or all players |
| `/stats podium` / `/stats schedule` / `/stats export` | Fantasy podium / upcoming events / CSV export |
| `/season current` / `/season set year:<n>` | Show or override the active FRC season year |
| `/admin setchannel` / `addadmin` / `addmanualplayer` / `announce` | Server admin configuration |
| `/help`, `/rules` | Command reference and scoring rules (unchanged, top-level) |

## Scoring System

### Season
- Each team's score = district/regional points from their **first 2 events** (type 0=Regional, 1=District)
- Points sourced from `/event/{key}/district_points` on TBA (includes qual ranking, alliance selection, playoffs, awards)
- If a team has only played **1 event**, their points are **doubled**
- Fetched live from TBA whenever `/stats standings` is called

### Worlds
- Each team's score = district points from their **Championship Division** event (type 3) and Finals (type 4)
- Same TBA points structure as season events

### Worlds Draft Order
- When `/draft start mode:worlds` is called, season standings are calculated live from TBA
- Draft order is **reversed** from standings (worst season rank picks first — snake format)
- `lastSeasonStandings` is saved to `data.json` for reference

### Auto-Pick Heuristic (CPU picks, `/pick skip`, and timer auto-skip)
Auto-picks don't just chase the single top-scoring team — they use a historical, randomized heuristic so the CPU doesn't feel robotic or overfit to one lucky season:
- **Season phase:** each available team's score is the **average of its best-2-events score across the last 3 years** (current year + 2 prior), not just the current year. This is normalized per-year the same way live standings are (first 2 non-DCMP events, doubled if only 1 played) — so a team that plays 7 events and wins them all isn't unfairly favored over a team that plays 2 and wins them all; only years the team actually competed count toward its average.
- **Worlds phase:** still uses the current year's live Worlds score (`getTeamWorldsScore`), since Worlds performance is a single-season event.
- **Randomness:** instead of always taking the #1 team, the top 15 scoring teams are treated as "relatively similar" and one is picked at random from that group. Applies uniformly to CPU picks, `/pick skip`, and the pick-timer auto-skip.

## Draft Flow

1. Host runs `/draft status open:true` to open joining
2. Players run `/draft join` to enter
3. Host runs `/draft start mode:season` — random snake draft order
4. Players take turns with `/pick team team:<number>` — 6 picks each
5. Check `/stats standings` anytime to see live scores from TBA
6. When season is over, host runs `/draft start mode:worlds` — auto-calculates final standings and sets worlds draft order
7. Worlds draft proceeds the same way with `/pick team`

## Reliability: Startup Message-History Recovery
`data_<channelId>.json` is already saved to disk after every pick/join/trade, before the bot announces it in Discord — so a normal crash mid-action shouldn't lose state. As an extra safety net, on every startup (`clientReady`) the bot also replays each guild's draft-channel message history (its own past announcements) and rebuilds draft state from that if the channel shows equal-or-greater progress than the on-disk file. This protects against the JSON file itself being lost, corrupted, or rolled back independent of Discord.
- This is a best-effort heuristic parser (regex over the bot's own message text), not a full audit log — it covers joins, admin promotions, manual/CPU players, season/worlds draft starts, all 4 pick variants (`/pick team`, `/pick manual`, `/pick skip`, timer auto-skip), `/pick undo`, and completed trades.
- It only looks back to the most recent "draft closed & reset" message (`/draft status open:false` or `/draft reset`), since those already purge most of the channel's bot messages anyway.
- If the scan can't find a reset boundary within ~1000 messages, it skips recovery entirely rather than risk overwriting good data with a partial rebuild.
- Note: this only makes the bot resilient to *data* loss on restart. It does not keep the bot *online* — the process still needs to be running (e.g. via a workflow) to serve Discord at all.

## Dependencies

- `discord.js` ^14.26.3 — Discord bot framework
- `@discordjs/rest` — REST API client for command registration
- `dotenv` — Environment variable loading
- `node-cron` — Cron job support
- `node-fetch` — HTTP fetch polyfill
