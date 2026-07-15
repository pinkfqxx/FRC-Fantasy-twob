require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  AttachmentBuilder,
  ChannelType,
  PermissionFlagsBits,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder
} = require('discord.js');
const cron = require('node-cron');

const fs = require('fs');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// Special ID for the CPU bot player
const BOT_PLAYER_ID = "BOT_PLAYER"; // legacy alias for CPU slot #1, kept for backward compatibility with saved drafts
const BOT_PLAYER_IDS = ["BOT_PLAYER", "BOT_PLAYER_2", "BOT_PLAYER_3"];
const MAX_BOTS = BOT_PLAYER_IDS.length;
// Returns true if the given player ID belongs to a CPU auto-pick slot.
function isBotPlayer(id) { return BOT_PLAYER_IDS.includes(id); }
// Returns 1-indexed CPU slot number (1, 2, or 3). Returns 0 if id is not a bot.
function botNumber(id) { return BOT_PLAYER_IDS.indexOf(id) + 1; }

// ---------------- DATA (per-server) ----------------
function freshData() {
  return {
    players: [],
    draftOrder: [],
    pickOrder: [],        // full flat pick sequence; generated at /draft start
    teamsDrafted: {},
    currentPick: 0,
    phase: "none",
    draftStyle: 'snake',  // 'snake' or 'popcorn'; copied from guild config at draft start
    teamsPerPlayer: 6,    // teams each player drafts; copied from guild config at draft start
    draftOpen: false,
    lastSeasonStandings: [],
    worldsTeams: [],
    seasonTeams: [],
    pendingTrade: null,
    pickLog: [],
    admins: [],
    year: null,
    worldsFinishedAt: null,
    draftId: null,
    botTradeAttempts: {}  // { botId: { "offering-wanting": attemptCount } }
  };
}

// Returns a draft ID string in MMMDD format (e.g. "327" for March 27, "1201" for December 1).
function generateDraftId() {
  const now = new Date();
  return `${now.getMonth() + 1}${now.getDate()}`;
}

// Returns a trade ID: 7 random digits 0–9 with no separators (e.g. "3729158").
function generateTradeId() {
  return Array.from({ length: 7 }, () => Math.floor(Math.random() * 10)).join('');
}

// Loads per-channel draft state from disk. Fills in missing fields added in later
// versions so old save files remain compatible. Returns freshData() on any error
// (missing file, corrupt JSON, etc.) — the bot always starts from a clean slate
// rather than crashing on a bad save.
function loadData(channelId) {
  try {
    const d = JSON.parse(fs.readFileSync(`./data_${channelId}.json`));
    if (!d.pendingTrade) d.pendingTrade = null;
    if (!d.admins) d.admins = d.players.length ? [d.players[0]] : [];
    if (!d.year) d.year = null;
    if (!('worldsFinishedAt' in d)) d.worldsFinishedAt = null;
    if (!('draftId' in d)) d.draftId = null;
    if (!('botTradeAttempts' in d)) d.botTradeAttempts = {};
    if (!('pickOrder'        in d)) d.pickOrder        = [];
    if (!('draftStyle'       in d)) d.draftStyle       = 'snake';
    if (!('teamsPerPlayer'   in d)) d.teamsPerPlayer   = 6;
    return d;
  } catch {
    return freshData();
  }
}

// Returns the active FRC season year for this draft. Falls back to the current
// calendar year if no year has been set via /season set.
function getYear(data) {
  return data.year || new Date().getFullYear();
}

// Persists draft state to disk. Called after every state-mutating action so the
// bot can resume correctly after a restart. SIDE EFFECT: writes data_<channelId>.json.
function saveData(data, channelId) {
  fs.writeFileSync(`./data_${channelId}.json`, JSON.stringify(data, null, 2));
}

// ---------------- GUILD CONFIG (per-server) ----------------
function loadGuildConfig(guildId) {
  try {
    const cfg = JSON.parse(fs.readFileSync(`./guild_config_${guildId}.json`));
    if (!('predictionMessageId' in cfg)) cfg.predictionMessageId = null;
    if (!('pickTimerMinutes'    in cfg)) cfg.pickTimerMinutes    = 0;
    if (!('tradeLockOverride'   in cfg)) cfg.tradeLockOverride   = null; // null = auto rules, true = force locked, false = force open
    if (!('botTradingEnabled'   in cfg)) cfg.botTradingEnabled   = true;
    if (!('botAutoPickEnabled'  in cfg)) cfg.botAutoPickEnabled  = true;
    if (!('teamsPerPlayer'      in cfg)) cfg.teamsPerPlayer      = 6;
    if (!('draftStyle'          in cfg)) cfg.draftStyle          = 'snake';
    return cfg;
  } catch {
    return { draftChannelId: null, announcementChannelId: null, lastPostedWeek: -1, predictionMessageId: null, pickTimerMinutes: 0, tradeLockOverride: null, botTradingEnabled: true, botAutoPickEnabled: true, teamsPerPlayer: 6, draftStyle: 'snake' };
  }
}

function saveGuildConfig(config, guildId) {
  fs.writeFileSync(`./guild_config_${guildId}.json`, JSON.stringify(config, null, 2));
}

// ---------------- TBA CACHE ----------------
const teamNameCache = new Map();
let seasonTeamsCache = null;

// Caches for auto-pick historical scoring, so repeated evaluations across
// consecutive picks (same pool minus drafted teams) don't re-hit TBA.
const districtPointsCache = new Map();  // eventKey -> points payload (or null)
const historicalScoreCache = new Map(); // `${team}-${year}` -> averaged score

// Generic fetch wrapper that swallows HTTP and network errors and returns null
// instead of throwing. TBA calls pass the TBA constant as options so the auth
// header is included. Callers must treat a null return as "no data available".
async function safeFetch(url, options = {}) {
  try {
    const res = await fetch(url, options);
    if (res.status === 404) return null;
    if (!res.ok) return null;
    return await res.json();
  } catch {
    console.error(`Fetch error: ${url}`);
    return null;
  }
}

const TBA = { headers: { 'X-TBA-Auth-Key': process.env.TBA_KEY } };
const DEFAULT_YEAR = new Date().getFullYear();
// Compat alias kept for call sites not yet converted to per-guild getYear(data).
// Do not remove — still referenced by scoring functions that lack a data object.
const CURRENT_YEAR = DEFAULT_YEAR;

// Permissions the bot needs to function correctly.
// Used both for the permission check on guildCreate and to generate a correct invite link.
const REQUIRED_PERMISSIONS = [
  PermissionFlagsBits.ManageChannels,    // create #frc-fantasy-updates
  PermissionFlagsBits.ManageRoles,       // set read-only permission overwrite on that channel
  PermissionFlagsBits.ViewChannel,       // see channels
  PermissionFlagsBits.SendMessages,      // post announcements / standings / alerts
  PermissionFlagsBits.EmbedLinks,        // send rich embeds
  PermissionFlagsBits.AttachFiles,       // send /exportcsv files
  PermissionFlagsBits.ReadMessageHistory,// fetch the prediction message to edit it in place
];

// Per-year cache for season teams
let seasonTeamsCacheYear = null;

// Gaussian error function — used to map a team's Worlds ranking to a smooth,
// size-normalized points curve. Implemented via the Abramowitz & Stegun rational
// approximation (Handbook of Mathematical Functions, formula 7.1.26), which is
// accurate to ~1.5×10⁻⁷ and has no external dependencies.
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  // Abramowitz & Stegun coefficients (formula 7.1.26):
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * absX);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
  return sign * y;
}

async function getTeamName(teamNumber) {
  if (teamNameCache.has(teamNumber)) return teamNameCache.get(teamNumber);
  try {
    const res = await fetch(`https://www.thebluealliance.com/api/v3/team/frc${teamNumber}`, TBA);
    if (!res.ok) { teamNameCache.set(teamNumber, `Team ${teamNumber}`); return `Team ${teamNumber}`; }
    const data = await res.json();
    const name = `${data.nickname || 'Unknown'} (FRC ${teamNumber})`;
    teamNameCache.set(teamNumber, name);
    return name;
  } catch {
    return `Team ${teamNumber}`;
  }
}

async function loadSeasonTeams(year = DEFAULT_YEAR) {
  if (seasonTeamsCacheYear === year && seasonTeamsCache) return seasonTeamsCache;
  const allTeams = [];
  let page = 0;
  while (true) {
    const teams = await safeFetch(`https://www.thebluealliance.com/api/v3/teams/${year}/${page}`, TBA);
    if (!teams || teams.length === 0) break;
    allTeams.push(...teams.map(t => t.team_number));
    page++;
  }
  seasonTeamsCache = allTeams;
  seasonTeamsCacheYear = year;
  return allTeams;
}

async function loadWorldsTeams(year = DEFAULT_YEAR) {
  const [events, allTeams] = await Promise.all([
    safeFetch(`https://www.thebluealliance.com/api/v3/events/${year}`, TBA),
    loadSeasonTeams(year)
  ]);
  const worlds = (events || [])
    .filter(e => e.event_type === 3 || e.event_type === 4)
    .map(e => e.key);
  if (!worlds.length) return [];

  const teams = new Set();
  for (const eventKey of worlds) {
    const eventTeams = await safeFetch(`https://www.thebluealliance.com/api/v3/event/${eventKey}/teams`, TBA);
    for (const team of eventTeams || []) teams.add(team.team_number);
  }
  return [...teams].filter(team => allTeams.includes(team));
}

// ---------------- DISPLAY HELPERS ----------------
function playerDisplay(id) {
  if (isBotPlayer(id)) return `🤖 **CPU ${botNumber(id)}**`;
  if (id.startsWith("MANUAL_")) return `👤 **${id.replace("MANUAL_", "")}**`;
  return `<@${id}>`;
}

// Returns a display string for a player ID suitable for Discord chat (mentions render
// as @Name). CPU and manual players get plain text labels. Not suitable for CSV exports
// — use playerNameForExport() instead, which resolves real Discord usernames.
function playerName(id) {
  if (isBotPlayer(id)) return `CPU ${botNumber(id)}`;
  if (id.startsWith("MANUAL_")) return id.replace("MANUAL_", "");
  return `<@${id}>`;
}

// Resolves a player id to a human-readable name for exports (CSV files can't render
// Discord mention markup like <@id>, so we fetch the actual username/display name).
async function playerNameForExport(id, guild) {
  if (isBotPlayer(id)) return `CPU ${botNumber(id)}`;
  if (id.startsWith("MANUAL_")) return id.replace("MANUAL_", "");
  try {
    const member = await guild.members.fetch(id);
    return member.displayName || member.user.username;
  } catch {
    try {
      const user = await client.users.fetch(id);
      return user.username;
    } catch {
      return `Unknown User (${id})`;
    }
  }
}

function isAdmin(data, userId) {
  return data.admins.includes(userId);
}

// Returns true if the Discord member has server-level authority: either the
// guild owner or a member with the Administrator permission. These users
// automatically receive draft admin privileges regardless of the bot's own
// admin list — use isEffectiveAdmin() for all in-draft permission checks.
function isDiscordAdmin(interaction) {
  return interaction.guild?.ownerId === interaction.user.id ||
         interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

// Combined admin check: true if the user is in the bot's own admin list OR has
// Discord-level authority (Administrator permission or server ownership).
function isEffectiveAdmin(data, interaction) {
  return isAdmin(data, interaction.user.id) || isDiscordAdmin(interaction);
}

// ---------------- SCORING ----------------
// Returns a team's fantasy score for the regular season: sum of district points from
// their first 2 qualifying events (type 0=Regional, 1=District). If only 1 event was
// played the score is doubled to avoid penalizing teams with light schedules.
async function getTeamSeasonScore(teamNumber, year = DEFAULT_YEAR) {
  const events = await safeFetch(`https://www.thebluealliance.com/api/v3/team/frc${teamNumber}/events/${year}`, TBA);
  if (!events?.length) return 0;

  const regularEvents = events
    .filter(e => e.event_type === 0 || e.event_type === 1)
    .sort((a, b) => new Date(a.start_date) - new Date(b.start_date))
    .slice(0, 2);

  if (!regularEvents.length) return 0;

  let total = 0, counted = 0;
  for (const ev of regularEvents) {
    const dp = await safeFetch(`https://www.thebluealliance.com/api/v3/event/${ev.key}/district_points`, TBA);
    const pts = dp?.points?.[`frc${teamNumber}`]?.total;
    if (pts != null) { total += pts; counted++; }
  }
  if (counted === 1) total *= 2;
  return total;
}

// Returns a team's fantasy score for the Championship (Worlds). Aggregates points
// across all Worlds events (type 3=Division, 4=Championship Finals) the team played.
// Scoring components: qual ranking (erf curve), alliance selection, playoff wins, awards.
async function getTeamWorldsScore(teamNumber, year = DEFAULT_YEAR) {
  const events = await safeFetch(`https://www.thebluealliance.com/api/v3/team/frc${teamNumber}/events/${year}`, TBA);
  if (!events?.length) return 0;

  const worldsEvents = events.filter(e => e.event_type === 3 || e.event_type === 4);
  if (!worldsEvents.length) return 0;

  let total = 0;
  for (const ev of worldsEvents) {
    const [rankings, alliances, matches, awards] = await Promise.all([
      safeFetch(`https://www.thebluealliance.com/api/v3/event/${ev.key}/rankings`, TBA),
      safeFetch(`https://www.thebluealliance.com/api/v3/event/${ev.key}/alliances`, TBA),
      safeFetch(`https://www.thebluealliance.com/api/v3/event/${ev.key}/matches`, TBA),
      safeFetch(`https://www.thebluealliance.com/api/v3/event/${ev.key}/awards`, TBA)
    ]);

    const teamKey = `frc${teamNumber}`;
    const ranking = rankings?.rankings?.find(r => r.team_key === teamKey);
    if (ranking?.rank != null) {
      // Qual ranking points: erf maps rank to a smooth curve centered at the midpoint,
      // normalized by field size (worldsEvents.length) so a #1 rank in a 10-team division
      // is worth the same as #1 in a 40-team division. Floor is ~2 pts, ceiling ~22 pts.
      const q = Math.ceil((10 / 1.07) * erf((worldsEvents.length - 2 * ranking.rank + 2) / (1.07 * worldsEvents.length)) + 12);
      total += q;
    }

    // Alliance selection points: 1st pick = 16 pts, 2nd = 15 pts, ..., 0 pts beyond 17th.
    const allianceIndex = alliances?.findIndex(a => a.picks?.includes(teamKey) || a.captain?.key === teamKey);
    if (allianceIndex != null && allianceIndex >= 0) total += Math.max(0, 17 - (allianceIndex + 1));

    const finals = matches?.filter(m => m.comp_level === 'f' && (m.winning_alliance === 'red' || m.winning_alliance === 'blue'));
    const playoffMatches = matches?.filter(m => ['qf', 'sf', 'f'].includes(m.comp_level) && (m.winning_alliance === 'red' || m.winning_alliance === 'blue')) || [];
    const teamMatches = playoffMatches.filter(m => m.alliances?.red?.team_keys?.includes(teamKey) || m.alliances?.blue?.team_keys?.includes(teamKey));
    const wonMatches = teamMatches.filter(m => m.alliances?.[m.winning_alliance]?.team_keys?.includes(teamKey));
    if (wonMatches.length) {
      const allianceWon = finals?.some(m => (m.alliances?.red?.team_keys?.includes(teamKey) || m.alliances?.blue?.team_keys?.includes(teamKey)) && m.alliances?.[m.winning_alliance]?.team_keys?.includes(teamKey));
      // beta: 20 pts base for winning the finals alliance, 7 pts base for any other playoff win.
      const beta = allianceWon ? 20 : 7;
      total += Math.ceil(beta * (wonMatches.length / Math.max(1, teamMatches.filter(m => m.alliances?.[m.winning_alliance]?.team_keys?.includes(teamKey)).length)));
      if (allianceWon) total += Math.min(10, wonMatches.filter(m => m.comp_level === 'f').length * 5);
    }

    for (const award of awards || []) {
      const teamWon = award.team_key === teamKey || award.recipient_team_keys?.includes(teamKey);
      if (!teamWon) continue;
      if (award.award_type === 0) total += 10;
      else if (award.award_type === 9 || award.award_type === 10) total += 8;
      else total += 5;
    }
  }
  return total;
}

// Cached district-points fetch, shared across teams that competed at the same event.
async function getDistrictPointsCached(eventKey) {
  if (districtPointsCache.has(eventKey)) return districtPointsCache.get(eventKey);
  const dp = await safeFetch(`https://www.thebluealliance.com/api/v3/event/${eventKey}/district_points`, TBA);
  districtPointsCache.set(eventKey, dp);
  return dp;
}

// A team's "best-2-events" score for a single year: first 2 qualifying (Regional/District,
// type 0/1) events by date, points doubled if the team only played 1 that year.
// Returns null if the team didn't compete in any qualifying event that year (so callers
// can exclude that year from an average rather than treating it as a real 0).
async function getTeamYearBestTwoScore(teamNumber, year) {
  const events = await safeFetch(`https://www.thebluealliance.com/api/v3/team/frc${teamNumber}/events/${year}`, TBA);
  if (!events?.length) return null;

  const regularEvents = events
    .filter(e => e.event_type === 0 || e.event_type === 1)
    .sort((a, b) => new Date(a.start_date) - new Date(b.start_date))
    .slice(0, 2);
  if (!regularEvents.length) return null;

  let total = 0, counted = 0;
  for (const ev of regularEvents) {
    const dp = await getDistrictPointsCached(ev.key);
    const pts = dp?.points?.[`frc${teamNumber}`]?.total;
    if (pts != null) { total += pts; counted++; }
  }
  if (!counted) return null;
  if (counted === 1) total *= 2;
  return total;
}

// Auto-pick heuristic: averages each team's best-2-events score across the last few
// seasons instead of just the current year. This normalizes teams that attend many
// events (7 events, wins them all) against teams that attend few (2 events, wins them
// all) but are actually comparable — looking at only their best 2 events per year keeps
// the comparison fair, and averaging across years smooths out any single-season fluke.
const HISTORICAL_YEARS_LOOKBACK = 3;
async function getTeamHistoricalSeasonScore(teamNumber, currentYear) {
  const years = [];
  for (let i = 0; i < HISTORICAL_YEARS_LOOKBACK; i++) years.push(currentYear - i);

  const yearScores = [];
  for (const year of years) {
    const cacheKey = `${teamNumber}-${year}`;
    let score;
    if (historicalScoreCache.has(cacheKey)) {
      score = historicalScoreCache.get(cacheKey);
    } else {
      score = await getTeamYearBestTwoScore(teamNumber, year);
      historicalScoreCache.set(cacheKey, score);
    }
    if (score != null) yearScores.push(score);
  }

  if (!yearScores.length) return 0;
  return yearScores.reduce((a, b) => a + b, 0) / yearScores.length;
}

// Adds a randomness factor to auto-picks: instead of always taking the single
// highest-scoring team, gather a group of teams that are genuinely comparable in
// strength and pick randomly among them. "Comparable" is relative, not a fixed number —
// a team has to score within `minRelativeStrength` (90%) of the best available score to
// even enter the pool, capped at `poolSize` candidates. This matters because a flat
// top-15-by-count pool can include teams far behind the leader once the score gap widens
// (e.g. early in a draft with a long tail of weaker teams); a relative floor keeps every
// candidate close to the best option regardless of how the scores happen to be
// distributed, and it naturally tightens or loosens as the pool of remaining teams changes
// through the draft — no hardcoded score threshold to keep in sync with a given season/pool.
//
// `skipTop`: skip this many of the highest-scoring teams before building the candidate pool.
// Used to avoid always converging on the same consensus top teams — the top 5 are excluded
// so the random selection draws from a more interesting spread of strong-but-not-obvious picks.
async function pickWithRandomness(scoredList, poolSize = 15, minRelativeStrength = 0.9, label = 'Auto-pick', skipTop = 0) {
  if (!scoredList.length) return undefined; // callers must guard against an empty pool
  const sorted = [...scoredList].sort((a, b) => b.score - a.score);
  // Skip the top `skipTop` teams, then build the candidate pool from what remains.
  const afterSkip = sorted.slice(skipTop);
  // If skipping emptied the list (fewer teams left than skipTop), fall back to the full sorted list.
  const eligible = afterSkip.length ? afterSkip : sorted;
  const topScore = eligible[0]?.score ?? 0;
  const candidates = eligible
    .filter(s => s.score >= topScore * minRelativeStrength)
    .slice(0, poolSize);
  const chosen = candidates[Math.floor(Math.random() * candidates.length)];

  // Verbose logging: only the shortlist (top `poolSize`, not every evaluated team) plus
  // the randomly chosen winner, so this stays readable even when hundreds of teams were scored.
  try {
    const names = await Promise.all(candidates.map(c => getTeamName(c.team).catch(() => `Team ${c.team}`)));
    const skipNote = skipTop > 0 ? `, skipping top ${skipTop}` : '';
    console.log(`\n🎲 [${label}] Scored ${scoredList.length} available team(s)${skipNote} — shortlist is the top ${candidates.length} within ${(minRelativeStrength * 100).toFixed(0)}% of the best eligible score (${topScore.toFixed(1)} pts):`);
    candidates.forEach((c, i) => {
      const marker = c.team === chosen.team ? '➡️ ' : '   ';
      console.log(`${marker}${i + 1}. FRC ${c.team} — ${names[i]} — ${c.score.toFixed(1)} pts`);
    });
    console.log(`   ✅ Randomly picked: FRC ${chosen.team} — ${names[candidates.indexOf(chosen)]}\n`);
  } catch (err) {
    console.log(`🎲 [${label}] Auto-pick log failed (non-fatal): ${err.message}`);
  }

  return chosen;
}

// Aggregates fantasy scores for all players and returns them sorted highest-first.
// scoreFn is an async function (teamNumber) => number — pass getTeamSeasonScore
// or getTeamWorldsScore (partially applied with year) depending on the phase.
async function calcStandings(data, scoreFn) {
  const results = await Promise.all(
    data.players.map(async player => {
      const teams = data.teamsDrafted[player] || [];
      const scores = await Promise.all(teams.map(scoreFn));
      return { player, totalScore: scores.reduce((a, b) => a + b, 0) };
    })
  );
  return results.sort((a, b) => b.totalScore - a.totalScore);
}

// Returns the first 2 qualifying (non-DCMP) events for a team with per-event points.
// event_type 0 = Regional, 1 = District (both count); 2 = DCMP (excluded).
async function getTeamEventBreakdown(teamNumber, year = DEFAULT_YEAR) {
  const events = await safeFetch(
    `https://www.thebluealliance.com/api/v3/team/frc${teamNumber}/events/${year}`, TBA
  );
  if (!events?.length) return { events: [], total: 0, doubled: false };

  const qualifying = events
    .filter(e => e.event_type === 0 || e.event_type === 1)
    .sort((a, b) => new Date(a.start_date) - new Date(b.start_date))
    .slice(0, 2);

  let rawTotal = 0, counted = 0;
  const eventResults = [];
  for (const ev of qualifying) {
    const dp = await safeFetch(
      `https://www.thebluealliance.com/api/v3/event/${ev.key}/district_points`, TBA
    );
    const pts = dp?.points?.[`frc${teamNumber}`]?.total ?? null;
    eventResults.push({
      eventKey: ev.key,
      eventName: ev.name,
      week: resolveEventWeek(ev),
      startDate: ev.start_date,
      rawPoints: pts
    });
    if (pts != null) { rawTotal += pts; counted++; }
  }

  const doubled = counted === 1;
  const total = doubled ? rawTotal * 2 : rawTotal;
  return { events: eventResults, total, doubled };
}

// Resolve an event's week number. TBA assigns week numbers to most events, but some
// international / midweek events (e.g. Turkey, Israel) may have week === null.
// In that case we estimate the week from the event's start date relative to March 1
// of the season year, which is approximately when FRC Week 0 begins.
function resolveEventWeek(ev) {
  if (ev.week != null) return ev.week;
  const date = new Date(ev.start_date);
  const seasonStart = new Date(Date.UTC(date.getUTCFullYear(), 2, 1)); // March 1
  const daysDiff = (date - seasonStart) / (1000 * 60 * 60 * 24);
  return Math.max(0, Math.floor(daysDiff / 7));
}

// Returns the last fully-completed FRC event week number (0-indexed) for the given year,
// or -1 if none have completed yet. Includes null-week events (midweek/international).
async function getLastCompletedSeasonWeek(year) {
  const today = new Date();
  const events = await safeFetch(`https://www.thebluealliance.com/api/v3/events/${year}`, TBA);
  if (!events) return -1;
  const completed = events
    .filter(e => (e.event_type === 0 || e.event_type === 1) && new Date(e.end_date) < today)
    .map(e => resolveEventWeek(e));
  return completed.length ? Math.max(...completed) : -1;
}

// Posts full rosters to the guild's announcements channel after a draft finishes.
async function postRosterAnnouncement(data, guildId) {
  const config = loadGuildConfig(guildId);
  if (!config.announcementChannelId) return;
  try {
    const annChannel = await client.channels.fetch(config.announcementChannelId).catch(() => null);
    if (!annChannel) return;
    const year = getYear(data);

    const fields = await Promise.all(data.players.map(async player => {
      const teams = data.teamsDrafted[player] || [];
      const names = await Promise.all(teams.map(getTeamName));
      const value = names.length
        ? names.map((n, i) => `• FRC ${teams[i]} — ${n.split(' (')[0]}`).join('\n')
        : '*No teams drafted.*';
      // Discord field values cap at 1024 chars — truncate if a roster is unusually large.
      return {
        name: playerDisplay(player).replace(/\*/g, ''),
        value: value.length > 1024 ? value.slice(0, 1020) + '\n…' : value
      };
    }));

    // Discord embeds cap at 25 fields — if the league has more than 25 players, split into
    // multiple messages (extremely unlikely, but handled gracefully).
    for (let i = 0; i < fields.length; i += 25) {
      const chunk = fields.slice(i, i + 25);
      const isFirst = i === 0;
      await annChannel.send({ embeds: [
        new EmbedBuilder()
          .setTitle(isFirst ? `🏁 ${year} Fantasy Draft Complete — Full Rosters` : `🏁 Full Rosters (continued)`)
          .addFields(chunk)
          .setColor(0x00AE86)
          .setFooter({ text: isFirst ? 'Weekly standings will be posted here as events conclude.' : '' })
      ]});
    }
  } catch (err) {
    console.error('postRosterAnnouncement error:', err);
  }
}

// DMs the current first-place player when a draft pick phase completes.
// At season-draft completion scores are typically 0 (season hasn't started yet),
// so this is most meaningful when worlds_finished fires after the regular season.
// Silently swallows all errors — a failed DM must never crash the draft flow.
async function dmDraftWinner(data, guildId) {
  try {
    const isWorlds = data.phase === 'worlds_finished';
    const year = getYear(data);
    const scoreFn = isWorlds
      ? t => getTeamWorldsScore(t, year)
      : t => getTeamSeasonScore(t, year);

    const standings = await calcStandings(data, scoreFn);
    if (!standings.length) return;

    const winner = standings[0];
    if (isBotPlayer(winner.player)) return; // CPU bot in first — nobody to DM

    const guild      = await client.guilds.fetch(guildId).catch(() => null);
    const winnerUser = await client.users.fetch(winner.player).catch(() => null);
    if (!winnerUser) return;

    const phaseLabel = isWorlds ? 'Worlds Fantasy Draft' : `${year} FRC Fantasy Draft`;
    const guildName  = guild?.name ?? 'your fantasy league';

    await winnerUser.send({
      embeds: [
        new EmbedBuilder()
          .setTitle(`🏆 You won the ${phaseLabel}!`)
          .setDescription(
            `Congratulations! You finished in **1st place** in **${guildName}** ` +
            `with **${winner.totalScore} pts**.\n\n` +
            `Run \`/stats standings\` in the server to see the full leaderboard.`
          )
          .setColor(0xFFD700)
      ]
    });
  } catch (err) {
    console.error('dmDraftWinner error:', err);
  }
}

// Posts Week N standings to the guild's announcements channel.
// weekNum is 0-indexed (TBA's week field); displayed as "Week N+1".
// SIDE EFFECT: updates config.lastPostedWeek and writes guild_config_<guildId>.json
// so the same week is never double-posted across restarts.
async function postWeeklyStandings(guildId, weekNum, year) {
  const config = loadGuildConfig(guildId);
  if (!config.announcementChannelId || !config.draftChannelId) return;

  const data = loadData(config.draftChannelId);
  if (!data.players.length || data.phase === 'none') return;
  if (data.phase === 'worlds' || data.phase === 'worlds_finished') return;

  const annChannel = await client.channels.fetch(config.announcementChannelId).catch(() => null);
  if (!annChannel) return;

  const allTeams = [...new Set(Object.values(data.teamsDrafted).flat())];
  const year_ = year || getYear(data);

  // Fetch full event breakdown for every drafted team
  const teamBreakdowns = await Promise.all(allTeams.map(async t => {
    const bd = await getTeamEventBreakdown(t, year_);
    const name = await getTeamName(t);
    const weekEvents = bd.events.filter(e => e.week === weekNum && e.rawPoints != null);
    const weekPts = weekEvents.reduce((s, e) => s + e.rawPoints, 0);
    return { team: t, name, total: bd.total, doubled: bd.doubled, weekPts };
  }));

  // Week-specific results
  const played = teamBreakdowns.filter(t => t.weekPts > 0).sort((a, b) => b.weekPts - a.weekPts);
  const didntPlay = teamBreakdowns.filter(t => t.weekPts === 0);
  let weekLine = '';
  if (played.length) {
    weekLine = played.map(t => `FRC ${t.team} — ${t.name.split(' (')[0]}: **${t.weekPts} pts**`).join('\n');
    if (didntPlay.length) weekLine += '\n' + didntPlay.map(t => `FRC ${t.team}: *no event this week*`).join('\n');
  } else {
    weekLine = '*No drafted teams competed this week.*';
  }

  // Overall fantasy standings
  const medals = ['🥇', '🥈', '🥉'];
  const playerStandings = data.players.map(player => {
    const teams = data.teamsDrafted[player] || [];
    const total = teams.reduce((sum, team) => {
      const bd = teamBreakdowns.find(t => t.team === team);
      return sum + (bd?.total || 0);
    }, 0);
    return { player, total };
  }).sort((a, b) => b.total - a.total);

  const standingsLine = playerStandings
    .map((p, i) => `${medals[i] || `${i + 1}.`} ${playerDisplay(p.player)} — **${p.total} pts**`)
    .join('\n');

  // Discord field values cap at 1024 chars — truncate each if necessary.
  const weekLineSafe = weekLine.length > 1024 ? weekLine.slice(0, 1020) + '\n…' : weekLine;
  const standingsSafe = standingsLine.length > 1024 ? standingsLine.slice(0, 1020) + '\n…' : standingsLine;

  await annChannel.send({ embeds: [
    new EmbedBuilder()
      .setTitle(`📅 Week ${weekNum + 1} Standings`)
      .addFields(
        { name: `Week ${weekNum + 1} Event Results (drafted teams)`, value: weekLineSafe || '*None*' },
        { name: 'Overall Fantasy Standings', value: standingsSafe || '*No data yet*' }
      )
      .setColor(0x5865F2)
      .setFooter({ text: 'First 2 non-DCMP events only • Points doubled if only 1 event played' })
  ]});

  config.lastPostedWeek = weekNum;
  saveGuildConfig(config, guildId);
}

// Called by the 3-hour cron — posts standings for any newly completed FRC weeks.
// Runs every 3 hours so midweek events (e.g. Turkey, Israel) are caught promptly.
async function checkAndPostWeeklyUpdate() {
  const year = DEFAULT_YEAR;
  const lastWeek = await getLastCompletedSeasonWeek(year);
  if (lastWeek < 0) return;

  const files = fs.readdirSync('./').filter(f => f.startsWith('guild_config_') && f.endsWith('.json'));
  for (const file of files) {
    const guildId = file.replace('guild_config_', '').replace('.json', '');
    const config = loadGuildConfig(guildId);
    if (lastWeek > config.lastPostedWeek) {
      for (let w = config.lastPostedWeek + 1; w <= lastWeek; w++) {
        await postWeeklyStandings(guildId, w, year).catch(async err => {
          console.error(`Weekly standings error guild=${guildId} week=${w}:`, err);
          await sendBotAlert(guildId, 'Weekly Standings Error',
            `Failed to post Week ${w + 1} standings.\n\`\`\`${err.message}\`\`\``
          ).catch(() => {});
        });
      }
    }
  }
}

// ---------------- BOT ALERTS ----------------

// Sends an error/alert embed to a single guild's announcements channel.
async function sendBotAlert(guildId, title, description) {
  try {
    const config = loadGuildConfig(guildId);
    if (!config.announcementChannelId) return;
    const ch = await client.channels.fetch(config.announcementChannelId).catch(() => null);
    if (!ch) return;
    await ch.send({ embeds: [
      new EmbedBuilder()
        .setTitle(`⚠️ ${title}`)
        .setDescription(String(description).slice(0, 2000))
        .setColor(0xE74C3C)
        .setTimestamp()
    ]});
  } catch {}
}

// Broadcasts an alert to every guild that has an announcements channel.
async function broadcastBotAlert(title, description) {
  const files = fs.readdirSync('./').filter(f => f.startsWith('guild_config_') && f.endsWith('.json'));
  for (const file of files) {
    const guildId = file.replace('guild_config_', '').replace('.json', '');
    await sendBotAlert(guildId, title, description).catch(() => {});
  }
}

// ---------------- STARTUP RECOVERY (message-history reconciliation) ----------------
// Best-effort safety net: on startup, replay each guild's draft-channel message history
// to reconstruct draft state, and use it whenever the channel shows at least as much
// progress as the on-disk data file. saveData() already writes to disk before every
// announcement, so this doesn't replace that — it's a fallback for cases where the JSON
// file itself is missing, corrupted, or rolled back even though the bot's own messages
// are still sitting in Discord (which is effectively a second, durable copy of history).
const RECOVERY_MESSAGE_PAGES = 10;  // up to 10 * 100 = 1000 messages scanned per channel
const RECOVERY_PAGE_SIZE = 100;

// Resolves a chunk of message text (e.g. "<@123> → <@456>", "👤 **Jerry**", "🤖 **CPU**")
// down to the player id/key used internally (Discord id, `MANUAL_<name>`, or BOT_PLAYER_ID).
function resolvePlayerIdentityFromText(text) {
  if (!text) return null;
  const parts = text.split('→').map(s => s.trim());
  const target = parts[parts.length - 1];
  const botMatch = target.match(/🤖.*?CPU\s*(\d+)?/) || target.match(/\bCPU\s*(\d+)?\b/);
  if (botMatch) {
    const num = botMatch[1] ? parseInt(botMatch[1], 10) : 1;
    return BOT_PLAYER_IDS[num - 1] || BOT_PLAYER_ID;
  }
  const manualMatch = target.match(/👤\s*\*\*(.+?)\*\*/);
  if (manualMatch) return `MANUAL_${manualMatch[1]}`;
  const mentionMatch = target.match(/<@(\d+)>/);
  if (mentionMatch) return mentionMatch[1];
  return null;
}

function extractTeamNumber(text) {
  const m = text && text.match(/\(FRC (\d+)\)/);
  return m ? parseInt(m[1], 10) : null;
}

function ensureRecoveredPlayer(state, id) {
  if (!id) return;
  if (!state.players.includes(id)) state.players.push(id);
  if (!(id in state.teamsDrafted)) state.teamsDrafted[id] = [];
}

// Parses one of the bot's own past messages into a mutation against `state` (a
// freshData()-shaped object being rebuilt from scratch). Returns 'reset' if the message
// marks a draft close/reset, so the caller can discard everything accumulated so far.
function applyRecoveredMessage(state, content, timestamp) {
  if (/^🛑 \*\*Draft has been CLOSED and RESET\*\*/.test(content) || /^🧹 Draft fully reset\.$/.test(content)) {
    return 'reset';
  }

  // A new draft opening always supersedes whatever came before — treat it as a
  // boundary so the replay starts fresh from this point, keeping only the most
  // recent draft's history. Also captures the draftId for the new state.
  const openMatch = content.match(/^✅ \*\*Draft is now OPEN\*\* · ID: \*\*(\d+)\*\*/);
  if (openMatch) {
    return `new_draft:${openMatch[1]}`;
  }

  let m;

  if ((m = content.match(/^✅ <@(\d+)> has joined the draft!$/))) {
    ensureRecoveredPlayer(state, m[1]);
    if (!state.admins.length) state.admins.push(m[1]);
    return;
  }

  if ((m = content.match(/^✅ (<@\d+>) has been promoted to \*\*admin\*\*\.$/))) {
    const id = resolvePlayerIdentityFromText(m[1]);
    if (id && !state.admins.includes(id)) state.admins.push(id);
    return;
  }

  if ((m = content.match(/^👤 \*\*(.+?)\*\* has been added as a manual player!$/))) {
    ensureRecoveredPlayer(state, `MANUAL_${m[1]}`);
    return;
  }

  if ((m = content.match(/^🤖 \*\*CPU(?: (\d+))?(?: player)? added to the draft!\*\*/))) {
    const num = m[1] ? parseInt(m[1], 10) : 1;
    ensureRecoveredPlayer(state, BOT_PLAYER_IDS[num - 1] || BOT_PLAYER_ID);
    return;
  }

  if ((m = content.match(/^📅 Year set to \*\*(\d+)\*\*\./))) {
    state.year = parseInt(m[1], 10);
    return;
  }

  if (/^🚀 \*\*Season Draft Started!\*\*/.test(content)) {
    state.phase = 'season';
    state.currentPick = 0;
    state.draftOrder = [];
    state.teamsDrafted = Object.fromEntries(state.players.map(p => [p, []]));
    state.draftOpen = false;
    state.pendingTrade = null;
    state._needsSeasonTeams = true;
    return;
  }

  if (/^🌍 \*\*Worlds Draft Started!\*\*/.test(content)) {
    state.phase = 'worlds';
    state.currentPick = 0;
    state.draftOrder = [];
    state.teamsDrafted = Object.fromEntries(state.players.map(p => [p, []]));
    state.draftOpen = false;
    state.pendingTrade = null;
    state._needsWorldsTeams = true;
    return;
  }

  if ((m = content.match(/^⏪ Undrafted \*\*(.+?)\*\* \(was pick #(\d+) by (.+?)\)/))) {
    const team = extractTeamNumber(m[1]);
    const pickIndex = parseInt(m[2], 10) - 1;
    if (team != null) {
      const owner = findOwner(state, team);
      if (owner) state.teamsDrafted[owner] = state.teamsDrafted[owner].filter(t => t !== team);
      state.pickLog = state.pickLog.filter(p => p.pickIndex !== pickIndex);
      state.currentPick = pickIndex;
      if (state.phase === 'finished') state.phase = 'season';
      if (state.phase === 'worlds_finished') state.phase = 'worlds';
    }
    return;
  }

  if ((m = content.match(/^✅ \*\*Trade accepted!\*\*\n<@(\d+)> receives \*\*(.+?)\*\*\n<@(\d+)> receives \*\*(.+?)\*\*/))) {
    const fromId = m[1], toId = m[3];
    const wantingTeam = extractTeamNumber(m[2]);
    const offeringTeam = extractTeamNumber(m[4]);
    if (wantingTeam != null && offeringTeam != null) {
      state.teamsDrafted[fromId] = (state.teamsDrafted[fromId] || []).filter(t => t !== offeringTeam).concat(wantingTeam);
      state.teamsDrafted[toId]   = (state.teamsDrafted[toId]   || []).filter(t => t !== wantingTeam).concat(offeringTeam);
    }
    return;
  }

  // Pick-type messages — 4 variants, all end in "picked **Team Name (FRC ####)**"
  let cpuMatch, skipMatch, timeoutMatch, normalMatch;
  let player, teamText;
  if ((cpuMatch = content.match(/^🤖 \*\*CPU(?: (\d+))?\*\* picked \*\*(.+?)\*\*/))) {
    const num = cpuMatch[1] ? parseInt(cpuMatch[1], 10) : 1;
    player = BOT_PLAYER_IDS[num - 1] || BOT_PLAYER_ID;
    teamText = cpuMatch[2];
  } else if ((skipMatch = content.match(/^⚡ (.+?) skipped and picked \*\*(.+?)\*\*/))) {
    player = resolvePlayerIdentityFromText(skipMatch[1]);
    teamText = skipMatch[2];
  } else if ((timeoutMatch = content.match(/^⏱️ \*\*Time's up!\*\* (.+?) was auto-skipped → picked \*\*(.+?)\*\*/))) {
    player = resolvePlayerIdentityFromText(timeoutMatch[1]);
    teamText = timeoutMatch[2];
  } else if ((normalMatch = content.match(/^✅ (.+?) picked \*\*(.+?)\*\*/))) {
    player = resolvePlayerIdentityFromText(normalMatch[1]);
    teamText = normalMatch[2];
  }

  if (player && teamText) {
    const team = extractTeamNumber(teamText);
    if (player && team != null) {
      ensureRecoveredPlayer(state, player);
      if (!state.teamsDrafted[player].includes(team)) state.teamsDrafted[player].push(team);
      const pickIndex = state.currentPick;
      state.pickLog.push({ player, team, pickIndex });
      state.currentPick++;
      // Round 0 of a fresh phase: the order picks appear in IS the draft order.
      if (state.draftOrder.length < state.players.length && !state.draftOrder.includes(player)) {
        state.draftOrder.push(player);
      }
      // The completion messages append "🏁 Draft complete!" to the last pick of a phase.
      if (/🏁 \*\*Draft complete!\*\*/.test(content)) {
        if (state.phase === 'worlds') {
          state.phase = 'worlds_finished';
          state.worldsFinishedAt = timestamp ?? Date.now();
        } else if (state.phase === 'season') {
          state.phase = 'finished';
        }
      }
    }
  }
}

// Fetches and replays a channel's bot message history (oldest → newest, since the last
// reset) into a freshData()-shaped object. Returns null if nothing could be recovered, or
// if the scan hit its page cap without finding a reset boundary — too risky to trust a
// possibly-partial rebuild in that case, so we leave the on-disk data alone.
async function rebuildDataFromChannelHistory(channelId) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return null;

  const collected = [];
  let before;
  let hitCap = true;
  for (let page = 0; page < RECOVERY_MESSAGE_PAGES; page++) {
    const batch = await channel.messages.fetch({ limit: RECOVERY_PAGE_SIZE, ...(before ? { before } : {}) }).catch(() => null);
    if (!batch || !batch.size) { hitCap = false; break; }
    const botMsgs = [...batch.values()].filter(m => m.author.id === client.user.id);
    collected.push(...botMsgs);
    before = batch.last()?.id;
    if (botMsgs.some(m =>
      /^🛑 \*\*Draft has been CLOSED and RESET\*\*/.test(m.content) || /^🧹 Draft fully reset\.$/.test(m.content)
    )) { hitCap = false; break; }
    if (batch.size < RECOVERY_PAGE_SIZE) { hitCap = false; break; }
  }

  if (hitCap) {
    console.warn(`Recovery scan for channel ${channelId} hit the page cap without finding a reset boundary — skipping to avoid a partial rebuild.`);
    return null;
  }

  collected.sort((a, b) => a.createdTimestamp - b.createdTimestamp); // oldest -> newest

  let state = freshData();
  for (const msg of collected) {
    const result = applyRecoveredMessage(state, msg.content, msg.createdTimestamp);
    if (result === 'reset') {
      state = freshData();
    } else if (typeof result === 'string' && result.startsWith('new_draft:')) {
      // A new draft was opened — discard everything before it and start fresh,
      // capturing the draftId embedded in the open message.
      const id = result.slice('new_draft:'.length);
      state = freshData();
      state.draftId = id;
      state.draftOpen = true;
    }
  }

  if (state._needsSeasonTeams) state.seasonTeams = await loadSeasonTeams(getYear(state));
  if (state._needsWorldsTeams) state.worldsTeams = await loadWorldsTeams(getYear(state));
  delete state._needsSeasonTeams;
  delete state._needsWorldsTeams;

  return state;
}

// Runs once at startup for every guild with a configured draft channel. Treats the
// channel's own message history as at least as trustworthy as the on-disk file, and
// overwrites the file whenever history shows equal-or-greater progress (or the on-disk
// file looks empty/missing while history shows real activity).
async function recoverAllGuildData() {
  let files;
  try {
    files = fs.readdirSync('./').filter(f => f.startsWith('guild_config_') && f.endsWith('.json'));
  } catch { return; }

  for (const file of files) {
    const guildId = file.replace('guild_config_', '').replace('.json', '');
    const config = loadGuildConfig(guildId);
    if (!config.draftChannelId) continue;

    try {
      const onDisk = loadData(config.draftChannelId);
      const rebuilt = await rebuildDataFromChannelHistory(config.draftChannelId);
      if (!rebuilt) continue;

      const onDiskProgress = onDisk.pickLog?.length || 0;
      const rebuiltProgress = rebuilt.pickLog?.length || 0;
      const onDiskLooksEmpty = !onDisk.players.length && onDisk.phase === 'none';

      if (rebuiltProgress >= onDiskProgress || (onDiskLooksEmpty && (rebuilt.players.length || rebuiltProgress))) {
        // For snake drafts, regenerate the deterministic pick order from the
        // recovered draft order. Popcorn orders were random and can't be reconstructed.
        if (rebuilt.draftOrder.length > 0 && rebuilt.pickOrder.length === 0 && rebuilt.phase !== 'none') {
          if (rebuilt.draftStyle !== 'popcorn') {
            rebuilt.pickOrder = generatePickOrder(rebuilt.draftOrder, rebuilt.teamsPerPlayer || 6, rebuilt.draftStyle || 'snake');
          }
        }
        saveData(rebuilt, config.draftChannelId);
        console.log(`Startup recovery: rebuilt draft state for channel ${config.draftChannelId} from message history (${rebuiltProgress} picks, ${rebuilt.players.length} players).`);
      }
    } catch (err) {
      console.error(`Startup recovery failed for guild ${guildId}:`, err);
    }
  }
}

// ---------------- STATBOTICS PREDICTIONS ----------------

// Fetches team-event prediction data from Statbotics. Returns null on any failure.
async function getStatboticsTeamEvent(teamNumber, eventKey) {
  try {
    const res = await fetch(
      `https://api.statbotics.io/v3/team_event/${teamNumber}/${eventKey}`,
      { headers: { Accept: 'application/json' } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || Object.keys(data).length === 0) return null;
    return data;
  } catch { return null; }
}

// Returns qualifying (type 0/1) events that are actively running right now.
async function getActiveSeasonEvents(year) {
  const today = new Date().toISOString().split('T')[0];
  const events = await safeFetch(`https://www.thebluealliance.com/api/v3/events/${year}/simple`, TBA);
  if (!events) return [];
  return events.filter(e =>
    (e.event_type === 0 || e.event_type === 1) &&
    e.start_date <= today && e.end_date >= today
  );
}

// Every 3 hours: for each guild with an active season draft, find drafted teams at live
// events, fetch Statbotics predictions, then silently edit a pinned embed in the
// announcements channel (or send a new one if the old message was deleted).
async function checkAndPostPredictions() {
  const year = DEFAULT_YEAR;
  const activeEvents = await getActiveSeasonEvents(year);
  if (!activeEvents.length) return; // nothing to do off-season / between events

  const files = fs.readdirSync('./').filter(f => f.startsWith('guild_config_') && f.endsWith('.json'));

  for (const file of files) {
    const guildId = file.replace('guild_config_', '').replace('.json', '');
    const config = loadGuildConfig(guildId);
    if (!config.announcementChannelId || !config.draftChannelId) continue;

    const data = loadData(config.draftChannelId);
    if (!data.players.length || data.phase === 'none') continue;
    if (data.phase === 'worlds' || data.phase === 'worlds_finished') continue;

    const allDraftedTeams = [...new Set(Object.values(data.teamsDrafted).flat())];

    // Build per-event prediction sections
    const eventSections = [];
    for (const ev of activeEvents) {
      const eventTeams = await safeFetch(`https://www.thebluealliance.com/api/v3/event/${ev.key}/teams/simple`, TBA);
      if (!eventTeams) continue;
      const eventTeamNums = new Set(eventTeams.map(t => t.team_number));
      const draftedHere = allDraftedTeams.filter(t => eventTeamNums.has(t));
      if (!draftedHere.length) continue;

      const teamLines = await Promise.all(draftedHere.map(async teamNum => {
        const [sb, name] = await Promise.all([
          getStatboticsTeamEvent(teamNum, ev.key),
          getTeamName(teamNum)
        ]);
        const shortName = name.split(' (')[0];
        if (!sb) return `**FRC ${teamNum}** — ${shortName}: *predictions unavailable*`;

        const predWins = (sb.pred?.wins ?? sb.epa?.wins)?.toFixed(1) ?? '?';
        const predRank = sb.pred?.rank ?? '?';
        const captainFlag = typeof predRank === 'number' && predRank <= 8 ? ' 🏳️' : '';
        return `**FRC ${teamNum}** — ${shortName}\n> Pred. Wins: **${predWins}** | Pred. Rank: **${predRank}**${captainFlag}`;
      }));

      const weekLabel = `Week ${resolveEventWeek(ev) + 1}`;
      // Discord field values are capped at 1024 characters — truncate if needed.
      let fieldValue = teamLines.join('\n');
      if (fieldValue.length > 1024) fieldValue = fieldValue.slice(0, 1020) + '\n…';
      eventSections.push({ name: `📍 ${ev.name} (${weekLabel})`, value: fieldValue });
    }

    if (!eventSections.length) continue;

    // Discord embeds cap at 25 fields — keep the first 25 if there are more active events.
    const fields = eventSections.slice(0, 25);
    const overflowNote = eventSections.length > 25
      ? `\n⚠️ ${eventSections.length - 25} additional event(s) omitted (embed limit reached).`
      : '';

    const embed = new EmbedBuilder()
      .setTitle('🔮 Live Event Predictions')
      .setDescription(
        'Statbotics EPA predictions for drafted teams at active events.\n' +
        '🏳️ = predicted alliance captain (rank ≤ 8)' + overflowNote
      )
      .addFields(fields)
      .setColor(0x9B59B6)
      .setFooter({ text: 'Updated every 3 hours from statbotics.io' })
      .setTimestamp();

    try {
      const annChannel = await client.channels.fetch(config.announcementChannelId).catch(() => null);
      if (!annChannel) continue;

      if (config.predictionMessageId) {
        try {
          const existing = await annChannel.messages.fetch(config.predictionMessageId);
          await existing.edit({ embeds: [embed] });
        } catch {
          // Message was deleted — send fresh
          const msg = await annChannel.send({ embeds: [embed] });
          config.predictionMessageId = msg.id;
          saveGuildConfig(config, guildId);
        }
      } else {
        const msg = await annChannel.send({ embeds: [embed] });
        config.predictionMessageId = msg.id;
        saveGuildConfig(config, guildId);
      }
    } catch (err) {
      console.error(`Prediction post error guild=${guildId}:`, err);
    }
  }
}

// ---------------- PICK TIMER ----------------
// Maps guildId → active timeout handle (whichever stage is currently pending).
// Two-stage flow, started after every human pick:
//   1. Main timer (settimer minutes) expires → ping the player + start a grace period.
//   2. Grace period expires with no pick → auto-pick for them and move on.
// Grace period = 10 minutes, or half the main timer if it's 25 minutes or less.
const pickTimers = new Map();

function graceMinutesFor(mainMinutes) {
  return mainMinutes <= 25 ? mainMinutes / 2 : 10;
}

function formatMinutes(mins) {
  return Number.isInteger(mins) ? String(mins) : mins.toFixed(1);
}

function clearPickTimer(guildId) {
  const handle = pickTimers.get(guildId);
  if (handle) { clearTimeout(handle); pickTimers.delete(guildId); }
}

function startPickTimer(guildId, channelId) {
  clearPickTimer(guildId);
  const config = loadGuildConfig(guildId);
  if (!config.pickTimerMinutes || config.pickTimerMinutes <= 0) return;
  const ms = config.pickTimerMinutes * 60 * 1000;
  const handle = setTimeout(() => {
    firePickTimerWarning(guildId, channelId, config.pickTimerMinutes).catch(err =>
      console.error(`Pick timer warning error guild=${guildId}:`, err)
    );
  }, ms);
  pickTimers.set(guildId, handle);
}

// Runs when the main pick timer expires: pings the current player and gives them
// one more grace period before actually auto-picking for them.
async function firePickTimerWarning(guildId, channelId, mainMinutes) {
  const data = loadData(channelId);
  if (!data.players.length || data.phase === 'none' ||
      data.phase === 'finished' || data.phase === 'worlds_finished') return;

  const current = getCurrentPlayer(data);
  if (isBotPlayer(current)) return; // bots never need auto-skipping

  const ch = await client.channels.fetch(channelId).catch(() => null);
  const graceMinutes = graceMinutesFor(mainMinutes);

  const guildCfg = loadGuildConfig(guildId);

  if (ch) {
    if (guildCfg.botAutoPickEnabled) {
      await ch.send(
        `⏰ ${playerDisplay(current)}, your pick timer expired!\n` +
        `You have **${formatMinutes(graceMinutes)} more minute${graceMinutes === 1 ? '' : 's'}** to pick before you're auto-skipped.`
      ).catch(() => {});
    } else {
      await ch.send(
        `⏰ ${playerDisplay(current)}, your pick timer expired!\n` +
        `*(Auto-pick is disabled — waiting for a manual pick.)*`
      ).catch(() => {});
    }
  }

  if (!guildCfg.botAutoPickEnabled) return; // auto-pick disabled; draft waits for a manual pick

  const handle = setTimeout(() => {
    performAutoSkip(guildId, channelId).catch(err =>
      console.error(`Auto-skip error guild=${guildId}:`, err)
    );
  }, graceMinutes * 60 * 1000);
  pickTimers.set(guildId, handle);
}

// Runs when the grace period expires: auto-picks the best available team for the
// current player, announces it, then starts the timer for the next player.
async function performAutoSkip(guildId, channelId) {
  const data = loadData(channelId);
  if (!data.players.length || data.phase === 'none' ||
      data.phase === 'finished' || data.phase === 'worlds_finished') return;

  // Safety net: if auto-pick was disabled between the timer firing and now, bail out.
  const guildCfg = loadGuildConfig(guildId);
  if (!guildCfg.botAutoPickEnabled) return;

  const current = getCurrentPlayer(data);
  if (isBotPlayer(current)) return; // bots never need auto-skipping

  const pool = data.phase === 'worlds' ? data.worldsTeams : data.seasonTeams;
  const drafted = new Set(Object.values(data.teamsDrafted).flat());
  const available = pool.filter(t => !drafted.has(t));
  if (!available.length) return;

  const year = getYear(data);
  const scoreFn = data.phase === 'worlds'
    ? t => getTeamWorldsScore(t, year)
    : t => getTeamHistoricalSeasonScore(t, year);
  const scored = await Promise.all(available.map(async t => ({ team: t, score: await scoreFn(t) })));
  const team = (await pickWithRandomness(scored, 15, 0.9, 'Grace-period auto-skip', 5)).team;

  data.teamsDrafted[current].push(team);
  data.currentPick++;
  data.pickLog.push({ player: current, team, pickIndex: data.currentPick - 1 });

  const name = await getTeamName(team);
  const maxPicks = data.players.length * (data.teamsPerPlayer || 6);
  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (!ch) { saveData(data, channelId); return; }

  if (data.currentPick >= maxPicks) {
    data.phase = data.phase === 'worlds' ? 'worlds_finished' : 'finished';
    if (data.phase === 'worlds_finished') data.worldsFinishedAt = Date.now();
    saveData(data, channelId);
    clearPickTimer(guildId);
    if (data.phase === 'finished') postRosterAnnouncement(data, guildId).catch(() => {});
    dmDraftWinner(data, guildId).catch(() => {});
    await ch.send(`⏱️ **Grace period expired.** ${playerDisplay(current)} was auto-picked → **${name}**\n\n🏁 **Draft complete!** Run \`/stats standings\` to see the results.`);
    return;
  }

  saveData(data, channelId);
  const next = getCurrentPlayer(data);
  await ch.send(`⏱️ **Grace period expired.** ${playerDisplay(current)} was auto-picked → **${name}**\n\n👉 Next pick: ${playerDisplay(next)}`);

  if (isBotPlayer(next)) {
    clearPickTimer(guildId);
    await doBotPick(data, channelId, ch, guildId);
  } else {
    startPickTimer(guildId, channelId);
  }
}

// ---------------- DRAFT HELPERS ----------------
function getCurrentPlayer(data) {
  // Use pre-generated pick order when available (supports both snake and popcorn).
  // Falls back to the deterministic snake formula for saves that predate pickOrder.
  if (data.pickOrder && data.pickOrder.length > 0) return data.pickOrder[data.currentPick];
  const n = data.draftOrder.length;
  const round = Math.floor(data.currentPick / n);
  const index = data.currentPick % n;
  return (round % 2 === 0) ? data.draftOrder[index] : data.draftOrder[n - 1 - index];
}

// Generates the full flat pick sequence for a draft.
// Snake: even rounds go left→right through draftOrder, odd rounds right→left.
// Popcorn: each round is a fresh random shuffle so no player picks twice before
// everyone else has gone, and the order re-randomises every round.
function generatePickOrder(draftOrder, teamsPerPlayer, style) {
  const order = [];
  for (let round = 0; round < teamsPerPlayer; round++) {
    if (style === 'popcorn') {
      const shuffled = [...draftOrder].sort(() => Math.random() - 0.5);
      order.push(...shuffled);
    } else {
      // Snake: even rounds forward, odd rounds backward
      order.push(...(round % 2 === 0 ? [...draftOrder] : [...draftOrder].reverse()));
    }
  }
  return order;
}

function findOwner(data, team) {
  for (const [player, teams] of Object.entries(data.teamsDrafted)) {
    if (teams.includes(team)) return player;
  }
  return null;
}

// ---------------- CPU AUTO-PICK ----------------
// Executes one CPU pick for the current player, posts the announcement to Discord,
// saves state, then calls itself recursively if the next player is also a CPU
// (handles consecutive bot turns in a snake draft). Exits when it's a human's turn,
// the draft is finished, or no teams remain in the pool.
// SIDE EFFECT: mutates data, writes data_<channelId>.json, sends Discord messages.
async function doBotPick(data, channelId, channel, guildId) {
  if (data.phase === "finished" || data.phase === "worlds_finished") return;
  const current = getCurrentPlayer(data);
  if (!isBotPlayer(current)) return;

  const pool = data.phase === "worlds" ? data.worldsTeams : data.seasonTeams;
  const drafted = new Set(Object.values(data.teamsDrafted).flat());
  const available = pool.filter(t => !drafted.has(t));
  if (!available.length) return;

  const year = getYear(data);
  const scoreFn = data.phase === "worlds"
    ? t => getTeamWorldsScore(t, year)
    : t => getTeamHistoricalSeasonScore(t, year);
  const scored = await Promise.all(available.map(async t => ({ team: t, score: await scoreFn(t) })));
  const team = (await pickWithRandomness(scored, 15, 0.9, `CPU ${botNumber(current)} pick`, 5)).team;
  data.teamsDrafted[current].push(team);
  data.currentPick++;
  data.pickLog.push({ player: current, team, pickIndex: data.currentPick - 1 });

  const name = await getTeamName(team);
  const maxPicks = data.players.length * (data.teamsPerPlayer || 6);

  if (data.currentPick >= maxPicks) {
    data.phase = data.phase === "worlds" ? "worlds_finished" : "finished";
    if (data.phase === 'worlds_finished') data.worldsFinishedAt = Date.now();
    saveData(data, channelId);
    clearPickTimer(guildId);
    await channel.send(`${playerDisplay(current)} picked **${name}**\n\n🏁 **Draft complete!** Run \`/stats standings\` to see the results!`);
    if (data.phase === "finished" && guildId) postRosterAnnouncement(data, guildId).catch(() => {});
    if (guildId) dmDraftWinner(data, guildId).catch(() => {});
    return;
  }

  saveData(data, channelId);
  const next = getCurrentPlayer(data);
  await channel.send(`${playerDisplay(current)} picked **${name}**\n\n👉 Next pick: ${playerDisplay(next)}`);

  // If it's still a bot's turn (consecutive picks in snake, or another bot immediately follows), keep going
  if (isBotPlayer(next)) {
    await new Promise(r => setTimeout(r, 1500)); // small delay so it doesn't feel instant
    await doBotPick(data, channelId, channel, guildId);
  } else {
    startPickTimer(guildId, channelId);
  }
}

// Evaluates whether a CPU player accepts or declines a proposed trade.
// Uses the same scoring as auto-pick (historical season avg or live worlds score).
// Base acceptance: 45%. Improved lineup: up to +30%. Hurt lineup: up to -20%.
// Logs verbosely so admins can follow the reasoning in the console.
async function evaluateBotTrade(botId, offeringTeam, wantingTeam, year, phase, attemptNumber) {
  const isWorlds = phase === 'worlds' || phase === 'worlds_finished';
  const scoreFn = isWorlds
    ? t => getTeamWorldsScore(t, year)
    : t => getTeamHistoricalSeasonScore(t, year);

  const botNum = botNumber(botId);
  const label = `CPU ${botNum} Trade Eval`;

  console.log(`\n🤖 [${label}] ${'─'.repeat(48)}`);
  console.log(`🤖 [${label}] Incoming trade proposal — resolving immediately.`);
  console.log(`🤖 [${label}]   Phase: ${phase} | Scoring: ${isWorlds ? 'live Worlds (TBA)' : 'historical season avg (3yr)'}`);
  console.log(`🤖 [${label}]   Attempt number : ${attemptNumber} of 3`);
  console.log(`🤖 [${label}]   Bot gives up : FRC ${wantingTeam}`);
  console.log(`🤖 [${label}]   Bot receives : FRC ${offeringTeam}`);
  console.log(`🤖 [${label}] Fetching scores from TBA...`);

  const [wantingScore, offeringScore] = await Promise.all([
    scoreFn(wantingTeam).catch(() => 0),
    scoreFn(offeringTeam).catch(() => 0),
  ]);
  const [wantingName, offeringName] = await Promise.all([
    getTeamName(wantingTeam).catch(() => `Team ${wantingTeam}`),
    getTeamName(offeringTeam).catch(() => `Team ${offeringTeam}`),
  ]);

  console.log(`🤖 [${label}] ── Scores ─${'─'.repeat(38)}`);
  console.log(`🤖 [${label}]   FRC ${wantingTeam}  (${wantingName})`);
  console.log(`🤖 [${label}]     → score: ${wantingScore.toFixed(2)} pts  [bot is GIVING this up]`);
  console.log(`🤖 [${label}]   FRC ${offeringTeam}  (${offeringName})`);
  console.log(`🤖 [${label}]     → score: ${offeringScore.toFixed(2)} pts  [bot is RECEIVING this]`);

  const BASE_CHANCE = 0.45;
  const delta = offeringScore - wantingScore;            // positive = bot gains
  const ref   = Math.max(wantingScore, 1);               // avoid div/0

  // A 30% score difference relative to the giving team is treated as a "full swing" —
  // so the modifier reaches its cap (+30% or -20%) when the received team scores
  // ~30% more or less than the one being given up.
  const FULL_SWING = 0.30;
  const relativeChange = delta / ref;

  let lineupModifier;
  if (delta >= 0) {
    lineupModifier = Math.min(relativeChange / FULL_SWING, 1) * 0.30;
  } else {
    lineupModifier = Math.max(relativeChange / FULL_SWING, -1) * 0.20;
  }

  // Each repeated proposal multiplies the final chance by 0.75 — hits harder on
  // already-high chances than a flat subtraction would.
  const REPEAT_MULTIPLIER = 0.75;
  const repeatFactor = Math.pow(REPEAT_MULTIPLIER, attemptNumber - 1);

  const finalChance = Math.max(0, Math.min(1, (BASE_CHANCE + lineupModifier) * repeatFactor));
  const roll        = Math.random();
  const accepted    = roll < finalChance;

  console.log(`🤖 [${label}] ── Calculation ${'─'.repeat(34)}`);
  console.log(`🤖 [${label}]   Score delta (receiving − giving) : ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} pts`);
  console.log(`🤖 [${label}]   Reference value (giving team)    : ${ref.toFixed(2)} pts`);
  console.log(`🤖 [${label}]   Relative change                  : ${(delta / ref * 100).toFixed(1)}%`);
  console.log(`🤖 [${label}]   Base acceptance chance           : ${(BASE_CHANCE * 100).toFixed(0)}%`);
  console.log(`🤖 [${label}]   Lineup impact modifier           : ${lineupModifier >= 0 ? '+' : ''}${(lineupModifier * 100).toFixed(2)}%  (cap: ${delta >= 0 ? '+30%' : '-20%'})`);
  console.log(`🤖 [${label}]   Repeat multiplier (attempt ${attemptNumber})   : ×${repeatFactor.toFixed(4)}  (0.75^${attemptNumber - 1})`);
  console.log(`🤖 [${label}]   Final acceptance chance          : ${(finalChance * 100).toFixed(2)}%`);
  console.log(`🤖 [${label}] ── Roll ${'─'.repeat(41)}`);
  console.log(`🤖 [${label}]   Roll  : ${(roll * 100).toFixed(2)}`);
  console.log(`🤖 [${label}]   Needs : < ${(finalChance * 100).toFixed(2)} to accept`);
  console.log(`🤖 [${label}]   Result: ${accepted ? '✅ ACCEPTED' : '❌ DECLINED'}`);
  console.log(`🤖 [${label}] ${'─'.repeat(48)}\n`);

  return { accepted, baseChance: BASE_CHANCE, lineupModifier, repeatFactor, finalChance, roll, offeringScore, wantingScore };
}

// ---------------- GLOBAL ERROR SAFETY ----------------
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (bot kept alive):', err);
  // Broadcast to all guilds — fire-and-forget so we don't block the process
  broadcastBotAlert('Unexpected Bot Error',
    `An unhandled error occurred. Some commands may not respond.\n\`\`\`${String(err?.message || err).slice(0, 500)}\`\`\``
  ).catch(() => {});
});

// ---------------- READY ----------------
client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Startup safety net: reconstruct any guild's draft state from its channel's own
  // message history if the on-disk data file is missing, stale, or was rolled back.
  recoverAllGuildData().catch(err => console.error('Startup recovery error:', err));

  // Every 3 hours: update Statbotics prediction embed + catch any newly completed event weeks.
  // Running every 3 hours (instead of daily) also ensures midweek events (e.g. Turkey, Israel)
  // are picked up within hours of completion rather than waiting for the next morning.
  cron.schedule('0 */3 * * *', () => {
    checkAndPostPredictions().catch(err => console.error('Predictions cron error:', err));
    checkAndPostWeeklyUpdate().catch(err => console.error('Weekly update cron error:', err));
  });
});

// ---------------- GUILD JOIN — create announcements channel ----------------

// Human-readable names for the permission flags used in DM alerts.
const PERMISSION_NAMES = {
  [PermissionFlagsBits.ManageChannels]:     'Manage Channels',
  [PermissionFlagsBits.ManageRoles]:        'Manage Roles',
  [PermissionFlagsBits.ViewChannel]:        'View Channels',
  [PermissionFlagsBits.SendMessages]:       'Send Messages',
  [PermissionFlagsBits.EmbedLinks]:         'Embed Links',
  [PermissionFlagsBits.AttachFiles]:        'Attach Files',
  [PermissionFlagsBits.ReadMessageHistory]: 'Read Message History',
};

client.on('guildCreate', async (guild) => {
  // ── 1. Permission check ────────────────────────────────────────────────────
  // Determine which required permissions the bot is missing in this guild.
  const botMember = guild.members.me;
  const missingPerms = botMember
    ? REQUIRED_PERMISSIONS.filter(p => !botMember.permissions.has(p))
    : REQUIRED_PERMISSIONS; // can't resolve member — assume everything is missing

  if (missingPerms.length) {
    const missingList = missingPerms
      .map(p => `• **${PERMISSION_NAMES[p] ?? String(p)}**`)
      .join('\n');

    const inviteLink = client.generateInvite({
      scopes: ['bot', 'applications.commands'],
      permissions: REQUIRED_PERMISSIONS,
    });

    const dmBody =
      `⚠️ **FRC Fantasy Bot — Missing Permissions in "${guild.name}"**\n\n` +
      `The bot is missing the following permissions, which will prevent some features from working:\n\n` +
      `${missingList}\n\n` +
      `Please kick the bot and re-invite it using this link to grant all required permissions:\n` +
      `<${inviteLink}>`;

    const owner = await guild.fetchOwner().catch(() => null);
    if (owner) await owner.send(dmBody).catch(() => {}); // DM may be blocked — fail silently
    console.warn(`guildCreate: missing permissions in ${guild.name} (${guild.id}): ${missingPerms.join(', ')}`);
    // Don't return — still attempt setup with whatever permissions we do have.
  }

  // ── 2. Channel creation ────────────────────────────────────────────────────
  let channel = null;
  try {
    const config = loadGuildConfig(guild.id);
    if (config.announcementChannelId) return; // already set up from a previous join

    channel = await guild.channels.create({
      name: 'frc-fantasy-updates',
      type: ChannelType.GuildText,
      topic: 'FRC Fantasy Draft announcements and weekly standings — managed by the bot',
      permissionOverwrites: [
        {
          id: guild.roles.everyone,
          deny: [PermissionFlagsBits.SendMessages],
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]
        },
        {
          // Without an explicit allow for the bot's own role, it inherits the
          // @everyone deny above and can't post its own announcements/standings.
          id: client.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.ReadMessageHistory
          ]
        }
      ]
    });

    config.announcementChannelId = channel.id;
    saveGuildConfig(config, guild.id);

    await channel.send(
      '👋 **FRC Fantasy Bot has arrived!**\n\n' +
      'This channel will receive:\n' +
      '• 📋 Full draft rosters when a draft completes\n' +
      '• 📅 Weekly standings as FRC event results come in\n' +
      '• 🔮 Live Statbotics predictions (updated every 3 hours during active events)\n' +
      '• ⚠️ Bot error alerts\n\n' +
      'A server admin should run `/admin setchannel` in whichever channel you want to use for draft commands.'
    );
  } catch (err) {
    console.error('guildCreate channel setup error:', err);

    const owner = await guild.fetchOwner().catch(() => null);
    if (owner) {
      const inviteLink = client.generateInvite({
        scopes: ['bot', 'applications.commands'],
        permissions: REQUIRED_PERMISSIONS,
      });
      if (channel) {
        // The channel itself exists — only the welcome message (or the permission
        // overwrites on it) failed. Don't tell the owner the channel is missing.
        await owner.send(
          `⚠️ **FRC Fantasy Bot — Partial Setup Issue in "${guild.name}"**\n\n` +
          `The \`#${channel.name}\` channel was created, but the bot couldn't post its ` +
          `welcome message there (likely missing \`Send Messages\`/\`Embed Links\` permission ` +
          `in that specific channel).\n\n` +
          `Check the channel's permissions for the bot's role, or re-invite it using this link ` +
          `to reset permissions server-wide:\n<${inviteLink}>`
        ).catch(() => {});
      } else {
        await owner.send(
          `⚠️ **FRC Fantasy Bot — Setup Failed in "${guild.name}"**\n\n` +
          `The bot couldn't create the \`#frc-fantasy-updates\` announcements channel. ` +
          `This is usually a permissions issue.\n\n` +
          `Please kick the bot and re-invite it using this link:\n<${inviteLink}>`
        ).catch(() => {});
      }
    }
  }
});

// ---------------- HELP MENU (button-driven) ----------------
// Each category backs both a home-menu button and its own drill-down embed.
// ── /help content ─────────────────────────────────────────────────────────────
// MAINTENANCE NOTE FOR FUTURE AGENTS:
// Whenever you add, rename, or remove a slash command or a significant user-facing
// feature, update HELP_CATEGORIES below AND the command table in replit.md.
// Also run `node commands.js` after any change to commands.js so Discord picks up
// the new registration (global commands can take up to an hour to propagate).
//
// Structure: each category has an id (matches the button customId suffix),
// an emoji + label shown on the home page, a short description, and a lines[]
// array of markdown strings shown when the user opens that category.
const HELP_CATEGORIES = [
  {
    id: 'setup',
    emoji: '🔧',
    label: 'Draft Setup',
    lines: [
      '`/draft join` — Join the fantasy draft',
      '`/draft addbot` — Add a CPU auto-picker (up to 3)',
      '`/draft removebot` — Remove the most recently added CPU player',
      '`/admin addmanualplayer [name]` — Add a non-Discord player *(admin)*',
      '`/draft status [open]` — Open or close the draft *(admin)*',
      '`/admin setchannel` — Set this channel as the draft channel *(admin)*',
      '`/season set [year]` — Override the FRC season year *(admin)*',
      '`/admin addadmin [@user]` — Promote a player to admin',
      '`/draft start [mode]` — Start the season or worlds draft *(admin)*',
    ]
  },
  {
    id: 'during',
    emoji: '🎯',
    label: 'During the Draft',
    lines: [
      '`/pick team [team]` — Pick a team on your turn',
      '`/pick manual [player] [team]` — Pick for a manual player *(admin)*',
      '`/pick skip` — Auto-pick the best available team for your turn',
      '`/draft order` — Show the upcoming pick order',
      '`/draft timer [minutes]` — Set auto-skip timer; `0` = disabled *(admin)*',
      '`/pick undo [team]` — Undo a pick *(admin)*',
      '`/draft reset` — Fully reset the draft *(admin)*',
      '`/draft hardreset` — Nuclear option: wipe all data + server config if things are bugged beyond repair *(Manage Server)*',
      '`/nuke` — Full server reconfiguration: wipes all draft data, resets config, recreates `#frc-fantasy-updates` *(Manage Server, two-step confirmation)*',
      '`/draft restore` — Rebuild draft state from this channel\'s message history (useful after a restart with missing data) *(admin)*',
      '`/admin trade manualaccept [tradeid]` — Accept any pending trade by Trade ID *(admin)*',
      '`/admin trade manualdecline [tradeid]` — Decline any pending trade by Trade ID *(admin)*',
      '`/config bottrading enable` / `disable` — Allow or block trades with CPU players *(admin)*',
      '`/config botpicksforplayers enable` / `disable` — Allow or block auto-pick via `/pick skip` and timer expiry *(admin)*',
      '`/config pick teamspickable [n]` — Set how many teams each player drafts (3–8, default 6) *(admin)*',
      '`/config draft style [snake|popcorn]` — Snake reverses order each round; Popcorn reshuffles randomly each round *(admin)*',
      '*CPU auto-picks and auto-skips pick from a pool of similarly-strong available teams, not always the single best one.*',
      '*If the pick timer expires, the player is pinged and gets a grace period (10 min, or half the timer if it\'s 25 min or less) before being auto-picked.*',
    ]
  },
  {
    id: 'season',
    emoji: '🏆',
    label: 'Season',
    lines: [
      '`/stats standings` — Live fantasy standings with scores',
      '`/stats myteams` — Your personal team scores *(private)*',
      '`/stats schedule` — Upcoming events for all drafted teams',
      '`/team score [team]` — Full point breakdown for any FRC team',
      '`/stats breakdown [player]` — Detailed breakdown for ALL, an @mention, or a manual player\'s name',
      '`/stats podium` — Fantasy podium',
    ]
  },
  {
    id: 'trades',
    emoji: '🔄',
    label: 'Trades',
    lines: [
      '*Trades close after Week 5, and 24h after the worlds draft finishes.*',
      '`/trade propose [offer] [request]` — Propose a team swap',
      '`/trade lock [mode]` — Override the trade lock: `auto`, `locked`, or `open` *(admin)*',
      '`/trade accept` — Accept a pending trade',
      '`/trade decline` — Decline or cancel a trade',
    ]
  },
  {
    id: 'info',
    emoji: '🔍',
    label: 'Teams & Info',
    lines: [
      '`/stats teams` — All fantasy teams and their owners',
      '`/stats roster` — Clean roster list (no scores)',
      '`/team search [name]` — Search for a team by name',
      '`/team identify [number]` — Look up a team by number',
      '`/rules` — Show scoring rules',
      '`/season current` — Show the active FRC season year',
    ]
  },
  {
    id: 'export',
    emoji: '📤',
    label: 'Export & Announcements',
    lines: [
      '`/stats export` — Export draft data as two CSV files',
      '`/admin announce [message]` — Post to #frc-fantasy-updates *(admin)*',
      '`/admin setup` — Reconfigure server from scratch: recreate announcements channel, wipe draft data, check permissions *(Manage Server)*',
    ]
  },
];

function buildHelpHomeEmbed() {
  return new EmbedBuilder()
    .setTitle('📖 FRC Fantasy Bot — Command Reference')
    .setDescription('Pick a category below to see its commands.')
    .setColor(0x5865F2)
    .addFields(HELP_CATEGORIES.map(c => ({
      name: `${c.emoji} ${c.label}`,
      value: `${c.lines.length} ${c.lines.length === 1 ? 'entry' : 'entries'}`,
      inline: true
    })))
    .setFooter({ text: 'Buttons only work for you — this message is private.' });
}

function buildHelpHomeComponents() {
  const rows = [];
  for (let i = 0; i < HELP_CATEGORIES.length; i += 3) {
    rows.push(new ActionRowBuilder().addComponents(
      HELP_CATEGORIES.slice(i, i + 3).map(c =>
        new ButtonBuilder().setCustomId(`help_${c.id}`).setLabel(c.label).setEmoji(c.emoji).setStyle(ButtonStyle.Primary)
      )
    ));
  }
  return rows;
}

function buildHelpCategoryEmbed(cat) {
  return new EmbedBuilder()
    .setTitle(`${cat.emoji} ${cat.label}`)
    .setDescription(cat.lines.join('\n'))
    .setColor(0x5865F2)
    .setFooter({ text: 'FRC Fantasy Bot — Command Reference' });
}

function buildHelpCategoryComponents() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('help_home').setLabel('Back').setEmoji('◀️').setStyle(ButtonStyle.Secondary)
  )];
}

// ---------------- COMMAND HANDLER ----------------
client.on('interactionCreate', async (interaction) => {
  // ── /nuke confirmation buttons ───────────────────────────────
  // nuke_confirm: user clicked "Confirm Nuke" after the /nuke warning embed.
  // nuke_cancel:  user clicked "Cancel" — dismiss the warning.
  // Both run outside the draft-channel guard since the server may be misconfigured.
  if (interaction.isButton() && (interaction.customId === 'nuke_confirm' || interaction.customId === 'nuke_cancel')) {
    if (interaction.customId === 'nuke_cancel') {
      return interaction.update({ content: '❌ Nuke cancelled.', embeds: [], components: [] });
    }

    // Re-verify permission on the button click — the ephemeral message is only
    // visible to the invoker, but it's good practice to check again.
    if (!isDiscordAdmin(interaction)) {
      return interaction.update({ content: '❌ Only the server owner or a member with **Administrator** permission can do this.', embeds: [], components: [] });
    }

    await interaction.deferUpdate();
    const nukeGuildId  = interaction.guildId;
    const nukeChannelId = interaction.channelId;
    const steps = [];

    // ── 1. Clear any running pick timer ───────────────────────────
    clearPickTimer(nukeGuildId);
    steps.push('⏱️ Pick timer cleared.');

    // ── 2. Wipe all draft data files belonging to this guild ───────
    // Iterates every data_<channelId>.json on disk; deletes the ones whose
    // channel resolves to this guild so stale files from old channels go too.
    const wipedChannels = [];
    for (const file of fs.readdirSync('.')) {
      if (!/^data_\d+\.json$/.test(file)) continue;
      const candidateId = file.slice('data_'.length, -'.json'.length);
      try {
        const ch = await client.channels.fetch(candidateId).catch(() => null);
        if (ch && ch.guildId === nukeGuildId) {
          fs.unlinkSync(file);
          wipedChannels.push(candidateId);
        }
      } catch { /* skip inaccessible channels */ }
    }
    const currentDataFile = `./data_${nukeChannelId}.json`;
    if (fs.existsSync(currentDataFile) && !wipedChannels.includes(nukeChannelId)) fs.unlinkSync(currentDataFile);
    steps.push(`🗑️ Draft data wiped (${Math.max(wipedChannels.length, 1)} file(s) removed).`);

    // ── 3. Delete stale #frc-fantasy-updates if it still exists ───
    const oldConfig = loadGuildConfig(nukeGuildId);
    if (oldConfig.announcementChannelId) {
      const oldAnnCh = await interaction.guild.channels.fetch(oldConfig.announcementChannelId).catch(() => null);
      if (oldAnnCh) {
        await oldAnnCh.delete('FRC Fantasy /nuke — recreating announcements channel').catch(() => {});
        steps.push('🗑️ Old `#frc-fantasy-updates` channel deleted.');
      }
    }

    // ── 4. Reset guild config ──────────────────────────────────────
    // NOTE FOR FUTURE AGENTS: if new fields are added to guild_config, make sure
    // they are either covered by the fresh-defaults in loadGuildConfig(), or
    // explicitly reset here. The goal is that after /nuke the server is in the
    // exact same state as a brand-new install.
    const configFile = `./guild_config_${nukeGuildId}.json`;
    if (fs.existsSync(configFile)) fs.unlinkSync(configFile);
    steps.push('🔄 Server config reset (channel bindings, timer, trade lock, prediction message).');

    // ── 5. Permission check ────────────────────────────────────────
    const botMember = interaction.guild.members.me;
    const missingPerms = botMember
      ? REQUIRED_PERMISSIONS.filter(p => !botMember.permissions.has(p))
      : REQUIRED_PERMISSIONS;

    let permNote = '';
    if (missingPerms.length) {
      const missingList = missingPerms.map(p => `• **${PERMISSION_NAMES[p] ?? String(p)}**`).join('\n');
      const inviteLink = client.generateInvite({ scopes: ['bot', 'applications.commands'], permissions: REQUIRED_PERMISSIONS });
      permNote = `\n\n⚠️ **Missing permissions — some features won't work until these are granted:**\n${missingList}\n\nKick and re-invite the bot with all permissions: <${inviteLink}>`;
      steps.push('⚠️ Missing permissions detected (see below).');
    } else {
      steps.push('✅ All required permissions are present.');
    }

    // ── 6. Recreate #frc-fantasy-updates ──────────────────────────
    try {
      const annChannel = await interaction.guild.channels.create({
        name: 'frc-fantasy-updates',
        type: ChannelType.GuildText,
        topic: 'FRC Fantasy Draft announcements and weekly standings — managed by the bot',
        permissionOverwrites: [
          {
            id: interaction.guild.roles.everyone,
            deny: [PermissionFlagsBits.SendMessages],
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]
          },
          {
            id: client.user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.EmbedLinks,
              PermissionFlagsBits.AttachFiles,
              PermissionFlagsBits.ReadMessageHistory
            ]
          }
        ]
      });

      const freshConfig = loadGuildConfig(nukeGuildId); // blank defaults — file was just deleted
      freshConfig.announcementChannelId = annChannel.id;
      saveGuildConfig(freshConfig, nukeGuildId);

      await annChannel.send(
        '🔄 **FRC Fantasy Bot has been reconfigured for this server.**\n\n' +
        'This channel will receive:\n' +
        '• 📋 Full draft rosters when a draft completes\n' +
        '• 📅 Weekly standings as FRC event results come in\n' +
        '• 🔮 Live Statbotics predictions (updated every 3 hours during active events)\n' +
        '• ⚠️ Bot error alerts\n\n' +
        'A server admin should run `/admin setchannel` in whichever channel you want to use for draft commands.'
      );
      steps.push('✅ `#frc-fantasy-updates` recreated successfully.');
    } catch (err) {
      steps.push('❌ Could not create `#frc-fantasy-updates` — check that the bot has **Manage Channels** permission.');
      console.error('nuke: channel creation failed:', err);
    }

    return interaction.editReply({
      content:
        `☢️ **Server nuke complete.**\n\n` +
        steps.join('\n') +
        `\n\n**Next steps:** Run \`/admin setchannel\` in your draft channel, then \`/draft status open:true\` to begin.` +
        permNote,
      embeds: [],
      components: []
    });
  }

  // ── /help category buttons ──────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('help_')) {
    try {
      if (interaction.customId === 'help_home') {
        return await interaction.update({ embeds: [buildHelpHomeEmbed()], components: buildHelpHomeComponents() });
      }
      const cat = HELP_CATEGORIES.find(c => c.id === interaction.customId.slice('help_'.length));
      if (!cat) return await interaction.update({ embeds: [buildHelpHomeEmbed()], components: buildHelpHomeComponents() });
      return await interaction.update({ embeds: [buildHelpCategoryEmbed(cat)], components: buildHelpCategoryComponents() });
    } catch (err) {
      console.error('Help button error:', err);
    }
    return;
  }

  // ── Trade accept/decline buttons from DMs ──────────────────────
  // When a trade is proposed the recipient gets a DM with Accept/Decline buttons.
  // Those interactions arrive with no guild context (interaction.guildId is null),
  // so they must be handled before the guild guard below.
  // customId format: trade_accept_<guildId>_<channelId>
  //                  trade_decline_<guildId>_<channelId>
  if (interaction.isButton() && (interaction.customId.startsWith('trade_accept_') || interaction.customId.startsWith('trade_decline_'))) {
    const parts          = interaction.customId.split('_');
    const action         = parts[1];          // 'accept' or 'decline'
    const tradeGuildId   = parts[2];
    const tradeChannelId = parts[3];
    const responderId    = interaction.user.id;

    try { await interaction.deferUpdate(); } catch { return; }

    const tradeData = loadData(tradeChannelId);
    const trade     = tradeData.pendingTrade;

    if (!trade) {
      return interaction.editReply({ content: '❌ There is no longer a pending trade — it may have already been resolved in the server.', embeds: [], components: [] });
    }
    if (responderId !== trade.to) {
      return interaction.editReply({ content: '❌ This trade is not directed at you.', embeds: [], components: [] });
    }

    if (action === 'decline') {
      tradeData.pendingTrade = null;
      saveData(tradeData, tradeChannelId);
      const tradeCh = await client.channels.fetch(tradeChannelId).catch(() => null);
      if (tradeCh) await tradeCh.send(`❌ <@${responderId}> declined the trade proposed by <@${trade.from}>.`).catch(() => {});
      return interaction.editReply({ content: '❌ Trade declined.', embeds: [], components: [] });
    }

    // Accept — verify ownership is still valid (an undraft could have changed things
    // between when the proposal was sent and when the button was clicked), then swap.
    const fromTeams = tradeData.teamsDrafted[trade.from] ?? [];
    const toTeams   = tradeData.teamsDrafted[trade.to]   ?? [];
    if (!fromTeams.includes(trade.offering) || !toTeams.includes(trade.wanting)) {
      return interaction.editReply({
        content: '❌ This trade is no longer valid — one or both teams have changed hands since the proposal was sent.',
        embeds: [], components: []
      });
    }
    tradeData.teamsDrafted[trade.from] = fromTeams.filter(t => t !== trade.offering);
    tradeData.teamsDrafted[trade.to]   = toTeams.filter(t => t !== trade.wanting);
    tradeData.teamsDrafted[trade.from].push(trade.wanting);
    tradeData.teamsDrafted[trade.to].push(trade.offering);
    tradeData.pendingTrade = null;
    saveData(tradeData, tradeChannelId);

    const [offerName, wantName] = await Promise.all([getTeamName(trade.offering), getTeamName(trade.wanting)]);

    // Post the acceptance in the draft channel so all players see it
    const tradeCh = await client.channels.fetch(tradeChannelId).catch(() => null);
    if (tradeCh) {
      await tradeCh.send(
        `✅ **Trade accepted!**\n<@${trade.from}> receives **${wantName}**\n<@${trade.to}> receives **${offerName}**`
      ).catch(() => {});
    }
    return interaction.editReply({
      content: `✅ **Trade accepted!**\n**You receive:** ${offerName}\n**They receive:** ${wantName}`,
      embeds: [],
      components: []
    });
  }

  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guildId) return interaction.reply({ content: "This bot only works inside a server.", ephemeral: true });

  const guildId = interaction.guildId;
  const channelId = interaction.channelId;
  const userId = interaction.user.id;

  // ── NUKE ───────────────────────────────────────────────────────
  // First confirmation layer: verify Manage Server permission and the typed "NUKE"
  // string, then post an ephemeral warning embed with Confirm/Cancel buttons (second
  // layer). The actual destructive work runs in the nuke_confirm button handler above.
  // Placed before the draft-channel guard so it works even when the server is
  // misconfigured and the draft channel is unknown or inaccessible.
  if (interaction.commandName === 'nuke') {
    if (!isDiscordAdmin(interaction)) {
      return interaction.reply({ content: '❌ Only the server owner or a member with **Administrator** permission can run `/nuke`.', ephemeral: true });
    }
    if (interaction.options.getString('confirm') !== 'NUKE') {
      return interaction.reply({
        content: '⚠️ Type `NUKE` (all caps) as the `confirm` argument to proceed to the confirmation step.',
        ephemeral: true
      });
    }

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('☢️ Confirm Server Nuke')
          .setColor(0xFF0000)
          .setDescription(
            '**This will permanently wipe the following from this server:**\n\n' +
            '• All draft data (players, picks, rosters, pick log, standings)\n' +
            '• Server config (draft channel binding, pick timer, trade lock)\n' +
            '• The `#frc-fantasy-updates` channel *(will be recreated fresh)*\n\n' +
            '**This cannot be undone.** Click **Confirm Nuke** to proceed.'
          )
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('nuke_confirm').setLabel('☢️ Confirm Nuke').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('nuke_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
        )
      ],
      ephemeral: true
    });
  }

  // ── DRAFT CHANNEL GUARD ───────────────────────────────────────
  const guildConfig = loadGuildConfig(guildId);
  if (guildConfig.draftChannelId && channelId !== guildConfig.draftChannelId) {
    return interaction.reply({
      content: `❌ Draft commands must be used in <#${guildConfig.draftChannelId}>.`,
      ephemeral: true
    });
  }

  const data = loadData(channelId);

  try {

    // ── SET CHANNEL ────────────────────────────────────────────────
    if (interaction.commandName === 'admin' && interaction.options.getSubcommand() === 'setchannel') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: "❌ You need **Manage Server** permission to set the draft channel.", ephemeral: true });
      }
      guildConfig.draftChannelId = channelId;
      saveGuildConfig(guildConfig, guildId);
      return interaction.reply(
        `✅ **This channel is now the draft channel.**\nAll draft commands must be used here.\n` +
        (guildConfig.announcementChannelId ? `Announcements will be posted in <#${guildConfig.announcementChannelId}>.` : '')
      );
    }

    // ── DRAFT STATUS ──────────────────────────────────────────────
    if (interaction.commandName === 'draft' && interaction.options.getSubcommand() === 'status') {
      const setToOpen = interaction.options.getBoolean('open');
      if (data.players.length > 0 && !isEffectiveAdmin(data, interaction)) {
        return interaction.reply("❌ Only an admin can change draft status.");
      }
      if (setToOpen) {
        data.draftOpen = true;
        data.draftId = data.draftId || generateDraftId();
        saveData(data, channelId);
        return interaction.reply(`✅ **Draft is now OPEN** · ID: **${data.draftId}**\nPlayers can now join using \`/draft join\` or add a CPU with \`/draft addbot\``);
      } else {
        clearPickTimer(guildId);
        saveData(freshData(), channelId);
        // Bulk delete the bot's own recent messages in this channel
        try {
          const channel = await client.channels.fetch(interaction.channelId);
          const messages = await channel.messages.fetch({ limit: 50 });
          const botMessages = messages.filter(m => m.author.id === client.user.id);
          for (const msg of botMessages.values()) await msg.delete().catch(() => {});
        } catch {}
        return interaction.reply("🛑 **Draft has been CLOSED and RESET**\nBot messages cleared.");
      }
    }

    // ── JOIN DRAFT ────────────────────────────────────────────────
    if (interaction.commandName === 'draft' && interaction.options.getSubcommand() === 'join') {
      if (!data.draftOpen) return interaction.reply("❌ Draft joining is currently closed.\nAsk the host to run `/draft status open:true`");
      if (data.players.includes(userId)) return interaction.reply("You are already in the draft.");
      data.players.push(userId);
      // First player always becomes admin. Discord-level admins (server owner or
      // Administrator permission) are also auto-promoted so they always have draft
      // admin powers regardless of join order.
      if (!data.admins.length || isDiscordAdmin(interaction)) {
        if (!data.admins.includes(userId)) data.admins.push(userId);
      }
      saveData(data, channelId);
      return interaction.reply(`✅ <@${userId}> has joined the draft!`);
    }

    // ── ADD ADMIN ────────────────────────────────────────────────
    if (interaction.commandName === 'admin' && interaction.options.getSubcommand() === 'addadmin') {
      if (!isEffectiveAdmin(data, interaction)) return interaction.reply({ content: "❌ Only admins can promote others.", ephemeral: true });
      const target = interaction.options.getUser('user');
      if (data.admins.includes(target.id)) return interaction.reply({ content: `${target} is already an admin.`, ephemeral: true });
      data.admins.push(target.id);
      saveData(data, channelId);
      return interaction.reply(`✅ ${target} has been promoted to **admin**.`);
    }

    // ── ADD MANUAL PLAYER ───────────────────────────────────────────────
    if (interaction.commandName === 'admin' && interaction.options.getSubcommand() === 'addmanualplayer') {
      if (!isEffectiveAdmin(data, interaction)) return interaction.reply({ content: "❌ Only admins can add manual players.", ephemeral: true });
      if (!data.draftOpen) return interaction.reply({ content: "❌ Draft joining is currently closed.", ephemeral: true });
      const rawName = interaction.options.getString('name').trim();
      const mId = `MANUAL_${rawName}`;
      if (data.players.includes(mId)) return interaction.reply({ content: `❌ A player named "${rawName}" is already in the draft.`, ephemeral: true });
      data.players.push(mId);
      saveData(data, channelId);
      return interaction.reply(`👤 **${rawName}** has been added as a manual player!`);
    }

    // ── ADD BOT PLAYER ────────────────────────────────────────────
    if (interaction.commandName === 'draft' && interaction.options.getSubcommand() === 'addbot') {
      if (!data.draftOpen) return interaction.reply("❌ Draft joining is currently closed.");
      const currentBots = data.players.filter(isBotPlayer);
      if (currentBots.length >= MAX_BOTS) return interaction.reply(`🤖 Maximum of ${MAX_BOTS} CPU players are already in the draft.`);
      const nextBotId = BOT_PLAYER_IDS.find(id => !data.players.includes(id));
      data.players.push(nextBotId);
      saveData(data, channelId);
      return interaction.reply(`🤖 **CPU ${botNumber(nextBotId)} added to the draft!** It will auto-pick randomly when it's its turn. (${currentBots.length + 1}/${MAX_BOTS} CPU players)`);
    }

    // ── REMOVE BOT ─────────────────────────────────────────────────
    if (interaction.commandName === 'draft' && interaction.options.getSubcommand() === 'removebot') {
      if (!data.draftOpen) return interaction.reply("❌ Draft joining is currently closed.");
      const currentBots = data.players.filter(isBotPlayer);
      if (!currentBots.length) return interaction.reply("🤖 There are no CPU players in the draft to remove.");
      // Remove the highest-numbered bot (the most recently added one).
      const toRemove = currentBots[currentBots.length - 1];
      data.players = data.players.filter(p => p !== toRemove);
      saveData(data, channelId);
      return interaction.reply(`🤖 **CPU ${botNumber(toRemove)} removed from the draft.** (${currentBots.length - 1}/${MAX_BOTS} CPU players)`);
    }

    // ── START DRAFT (season or worlds) ─────────────────────────────
    if (interaction.commandName === 'draft' && interaction.options.getSubcommand() === 'start') {
      const mode = interaction.options.getString('mode');
      await interaction.deferReply();
      if (!data.players.length) return interaction.editReply("❌ No players have joined yet.");
      if (!isEffectiveAdmin(data, interaction)) return interaction.editReply("❌ Only an admin can start the draft.");

      if (mode === 'worlds') {
        await interaction.editReply("⏳ Calculating final season standings from TBA…");

        const year = getYear(data);
        const seasonStandings = await calcStandings(data, t => getTeamSeasonScore(t, year));
        data.lastSeasonStandings = seasonStandings.map(p => p.player);
        data.phase = "worlds";
        data.worldsTeams = await loadWorldsTeams(getYear(data));
        data.draftOrder = [...data.lastSeasonStandings].reverse();
        data.currentPick = 0;
        data.teamsDrafted = Object.fromEntries(data.players.map(p => [p, []]));
        data.draftStyle = guildConfig.draftStyle || 'snake';
        data.teamsPerPlayer = guildConfig.teamsPerPlayer || 6;
        data.pickOrder = generatePickOrder(data.draftOrder, data.teamsPerPlayer, data.draftStyle);
        data.draftOpen = false;
        data.pendingTrade = null;
        saveData(data, channelId);

        const medals = ['🥇', '🥈', '🥉'];
        const standingsText = seasonStandings
          .map((p, i) => `${medals[i] || `${i + 1}.`} ${playerDisplay(p.player)} — **${p.totalScore} pts**`)
          .join('\n');
        const styleLabel = data.draftStyle === 'popcorn' ? 'Popcorn 🍿' : 'Snake 🐍';

        await interaction.editReply(
          `🌍 **Worlds Draft Started!**\n\n**Final Season Standings:**\n${standingsText}\n\n**Draft Order** (worst → best):\n${data.draftOrder.map(playerDisplay).join(' → ')}\n\nStyle: **${styleLabel}** · **${data.teamsPerPlayer}** teams per player\n\nFirst pick: ${playerDisplay(getCurrentPlayer(data))}`
        );

        if (isBotPlayer(getCurrentPlayer(data))) {
          await doBotPick(data, channelId, interaction.channel, guildId);
        }
        return;
      }

      // mode === 'season'
      data.phase = "season";
      data.seasonTeams = await loadSeasonTeams(getYear(data));
      data.draftOrder = [...data.players].sort(() => Math.random() - 0.5);
      data.currentPick = 0;
      data.teamsDrafted = Object.fromEntries(data.players.map(p => [p, []]));
      data.draftStyle = guildConfig.draftStyle || 'snake';
      data.teamsPerPlayer = guildConfig.teamsPerPlayer || 6;
      data.pickOrder = generatePickOrder(data.draftOrder, data.teamsPerPlayer, data.draftStyle);
      data.draftOpen = false;
      data.pendingTrade = null;
      saveData(data, channelId);

      const first = getCurrentPlayer(data);
      const styleLabel = data.draftStyle === 'popcorn' ? 'Popcorn 🍿' : 'Snake 🐍';
      await interaction.editReply(
        `🚀 **Season Draft Started!**\nTeams loaded: ${data.seasonTeams.length} · Style: **${styleLabel}** · **${data.teamsPerPlayer}** teams per player\nFirst pick: ${playerDisplay(first)}`
      );

      // If CPU goes first, auto-pick immediately
      if (isBotPlayer(first)) {
        await doBotPick(data, channelId, interaction.channel, guildId);
      }
      return;
    }

    // ── PICK TEAM ─────────────────────────────────────────────────
    if (interaction.commandName === 'pick' && interaction.options.getSubcommand() === 'team') {
      if (data.phase === 'none') return interaction.reply({ content: "❌ The draft hasn't started yet.", ephemeral: true });
      if (data.phase === 'finished' || data.phase === 'worlds_finished') return interaction.reply({ content: "❌ The draft is already complete.", ephemeral: true });
      const team = interaction.options.getInteger('team');
      const forUser = interaction.options.getUser('for');
      const actingAdmin = forUser && isEffectiveAdmin(data, interaction);
      const pickerId = actingAdmin ? forUser.id : userId;
      const current = getCurrentPlayer(data);

      if (pickerId !== current) return interaction.reply({ content: "⛔ It's not your turn.", ephemeral: true });
      const pool = data.phase === "worlds" ? data.worldsTeams : data.seasonTeams;
      if (!pool.includes(team)) return interaction.reply({ content: `⛔ Team ${team} is not in the pool.`, ephemeral: true });
      if (findOwner(data, team)) return interaction.reply({ content: `⛔ Team ${team} has already been drafted.`, ephemeral: true });

      await interaction.deferReply();
      data.teamsDrafted[current].push(team);
      data.currentPick++;
      data.pickLog.push({ player: current, team, pickIndex: data.currentPick - 1 });

      const name = await getTeamName(team);
      const maxPicks = data.players.length * (data.teamsPerPlayer || 6);

      const actor = actingAdmin ? `<@${userId}> → ${playerDisplay(pickerId)}` : `<@${userId}>`;
      if (data.currentPick >= maxPicks) {
        data.phase = data.phase === "worlds" ? "worlds_finished" : "finished";
        if (data.phase === 'worlds_finished') data.worldsFinishedAt = Date.now();
        saveData(data, channelId);
        clearPickTimer(guildId);
        if (data.phase === "finished") postRosterAnnouncement(data, guildId).catch(() => {});
        dmDraftWinner(data, guildId).catch(() => {});
        return interaction.editReply(`✅ ${actor} picked **${name}**\n\n🏁 **Draft complete!** Run \`/stats standings\` to see the results!`);
      }

      saveData(data, channelId);
      const next = getCurrentPlayer(data);
      await interaction.editReply(`✅ ${actor} picked **${name}**\n\n👉 Next pick: ${playerDisplay(next)}`);

      if (isBotPlayer(next)) {
        clearPickTimer(guildId);
        await doBotPick(data, channelId, interaction.channel, guildId);
      } else {
        startPickTimer(guildId, channelId);
      }
      return;
    }

    // ── MANUAL PICK ────────────────────────────────────────────────────────
    if (interaction.commandName === 'pick' && interaction.options.getSubcommand() === 'manual') {
      if (!isEffectiveAdmin(data, interaction)) return interaction.reply({ content: "❌ Only admins can pick for manual players.", ephemeral: true });
      if (data.phase === 'none') return interaction.reply({ content: "❌ The draft hasn't started yet.", ephemeral: true });
      if (data.phase === 'finished' || data.phase === 'worlds_finished') return interaction.reply({ content: "❌ The draft is already complete.", ephemeral: true });
      const rawName = interaction.options.getString('player').trim();
      const mId = `MANUAL_${rawName}`;
      const current = getCurrentPlayer(data);

      if (!data.players.includes(mId)) return interaction.reply({ content: `❌ Manual player "${rawName}" is not in the draft.`, ephemeral: true });
      if (current !== mId) return interaction.reply({ content: `⛔ It is not ${rawName}'s turn right now.`, ephemeral: true });

      const team = interaction.options.getInteger('team');
      const pool = data.phase === "worlds" ? data.worldsTeams : data.seasonTeams;
      if (!pool.includes(team)) return interaction.reply({ content: `⛔ Team ${team} is not in the pool.`, ephemeral: true });
      if (findOwner(data, team)) return interaction.reply({ content: `⛔ Team ${team} has already been drafted.`, ephemeral: true });

      await interaction.deferReply();
      data.teamsDrafted[current].push(team);
      data.currentPick++;
      data.pickLog.push({ player: current, team, pickIndex: data.currentPick - 1 });

      const name = await getTeamName(team);
      const maxPicks = data.players.length * (data.teamsPerPlayer || 6);

      if (data.currentPick >= maxPicks) {
        data.phase = data.phase === "worlds" ? "worlds_finished" : "finished";
        if (data.phase === 'worlds_finished') data.worldsFinishedAt = Date.now();
        saveData(data, channelId);
        clearPickTimer(guildId);
        if (data.phase === "finished") postRosterAnnouncement(data, guildId).catch(() => {});
        dmDraftWinner(data, guildId).catch(() => {});
        return interaction.editReply(`✅ ${playerDisplay(current)} picked **${name}**\n\n🏁 **Draft complete!** Run \`/stats standings\` to see the results!`);
      }

      saveData(data, channelId);
      const next = getCurrentPlayer(data);
      await interaction.editReply(`✅ ${playerDisplay(current)} picked **${name}**\n\n👉 Next pick: ${playerDisplay(next)}`);

      if (isBotPlayer(next)) {
        clearPickTimer(guildId);
        await doBotPick(data, channelId, interaction.channel, guildId);
      } else {
        startPickTimer(guildId, channelId);
      }
      return;
    }

    // ── TRADE ─────────────────────────────────────────────────────
    if (interaction.commandName === 'trade' && interaction.options.getSubcommand() === 'propose') {
      const offering = interaction.options.getInteger('offer');
      const wanting  = interaction.options.getInteger('request');

      if (!data.players.includes(userId)) return interaction.reply({ content: "❌ You're not in this draft.", ephemeral: true });
      if (offering === wanting) return interaction.reply({ content: "❌ You can't trade a team for itself.", ephemeral: true });

      const myTeams = data.teamsDrafted[userId] || [];
      if (!myTeams.includes(offering)) return interaction.reply({ content: `❌ You don't own FRC ${offering}.`, ephemeral: true });

      const theirOwner = findOwner(data, wanting);
      if (!theirOwner) return interaction.reply({ content: `❌ FRC ${wanting} hasn't been drafted yet.`, ephemeral: true });
      if (theirOwner === userId) return interaction.reply({ content: "❌ You already own that team.", ephemeral: true });
      // Bot trades resolve immediately — no pendingTrade slot needed, so only block on
      // an existing pending trade when the recipient is a real (non-bot) player.
      if (!isBotPlayer(theirOwner) && data.pendingTrade) return interaction.reply({ content: "❌ There's already a pending trade. It must be accepted, declined, or cancelled first.", ephemeral: true });

      // Trade lock: an admin override always wins; otherwise the default rules apply —
      // locked after Week 5 concludes, and locked 24h after the worlds draft finishes.
      const WORLDS_TRADE_GRACE_MS = 24 * 60 * 60 * 1000;
      if (guildConfig.tradeLockOverride === true) {
        return interaction.reply({ content: "🔒 Trading has been manually locked by an admin (`/trade lock`).", ephemeral: true });
      }
      if (guildConfig.tradeLockOverride !== false) {
        if (guildConfig.lastPostedWeek >= 4) {
          return interaction.reply({ content: "🔒 Trading is closed — the trade deadline passed after Week 5.", ephemeral: true });
        }
        if (data.phase === "worlds_finished" && data.worldsFinishedAt && (Date.now() - data.worldsFinishedAt) >= WORLDS_TRADE_GRACE_MS) {
          return interaction.reply({ content: "🔒 Trading is closed — it's been more than 24 hours since the worlds draft finished.", ephemeral: true });
        }
      }

      // ── BOT TRADE: evaluate and resolve immediately ───────────────
      if (isBotPlayer(theirOwner) && !guildConfig.botTradingEnabled) {
        return interaction.reply({ content: "❌ Trading with CPU players is disabled. An admin can enable it with `/config bottrading enable`.", ephemeral: true });
      }
      if (isBotPlayer(theirOwner)) {
        const MAX_BOT_TRADE_ATTEMPTS = 2;
        const tradeKey = `${offering}-${wanting}`;
        if (!data.botTradeAttempts[theirOwner]) data.botTradeAttempts[theirOwner] = {};
        const priorAttempts = data.botTradeAttempts[theirOwner][tradeKey] || 0;

        if (priorAttempts >= MAX_BOT_TRADE_ATTEMPTS) {
          return interaction.reply({
            content: `❌ **${playerDisplay(theirOwner)} won't consider this trade anymore.** You've already proposed FRC ${offering} for FRC ${wanting} ${MAX_BOT_TRADE_ATTEMPTS} times.`,
            ephemeral: true
          });
        }

        // Record the attempt before evaluating so the penalty applies to this proposal.
        data.botTradeAttempts[theirOwner][tradeKey] = priorAttempts + 1;
        const attemptNumber = priorAttempts + 1;
        const attemptsLeft  = MAX_BOT_TRADE_ATTEMPTS - attemptNumber;

        await interaction.deferReply();
        const year = getYear(data);
        const [offerName, wantName] = await Promise.all([getTeamName(offering), getTeamName(wanting)]);
        const result = await evaluateBotTrade(theirOwner, offering, wanting, year, data.phase, attemptNumber);

        if (result.accepted) {
          data.teamsDrafted[userId]     = (data.teamsDrafted[userId]     || []).filter(t => t !== offering);
          data.teamsDrafted[theirOwner] = (data.teamsDrafted[theirOwner] || []).filter(t => t !== wanting);
          data.teamsDrafted[userId].push(wanting);
          data.teamsDrafted[theirOwner].push(offering);
          saveData(data, channelId);
          return interaction.editReply(
            `✅ **Trade accepted by ${playerDisplay(theirOwner)}!**\n` +
            `${playerDisplay(userId)} receives **${wantName}** (FRC ${wanting})\n` +
            `${playerDisplay(theirOwner)} receives **${offerName}** (FRC ${offering})\n\n` +
            `*Acceptance chance: ${(result.finalChance * 100).toFixed(1)}% · Roll: ${(result.roll * 100).toFixed(1)}*`
          );
        } else {
          saveData(data, channelId);
          const attemptsNote = attemptsLeft > 0
            ? `You can propose this trade ${attemptsLeft} more time${attemptsLeft === 1 ? '' : 's'} (−7% each time).`
            : `This was your last attempt — ${playerDisplay(theirOwner)} will no longer consider this trade.`;
          return interaction.editReply(
            `❌ **${playerDisplay(theirOwner)} declined the trade.**\n` +
            `*Acceptance chance was ${(result.finalChance * 100).toFixed(1)}% · Roll: ${(result.roll * 100).toFixed(1)}*\n\n` +
            attemptsNote
          );
        }
      }

      const tradeId = generateTradeId();
      data.pendingTrade = { from: userId, offering, wanting, to: theirOwner, tradeId };
      saveData(data, channelId);

      const [offerName, wantName] = await Promise.all([getTeamName(offering), getTeamName(wanting)]);

      const isManualRecipient = theirOwner.startsWith('MANUAL_');

      // DM the recipient with interactive Accept/Decline buttons.
      // Skipped for manual players — they have no Discord account to DM.
      if (!isManualRecipient) {
        client.users.fetch(theirOwner).then(async recipientUser => {
          const senderName = interaction.member?.displayName ?? interaction.user.username;
          await recipientUser.send({
            embeds: [
              new EmbedBuilder()
                .setTitle('🔄 Trade Proposal')
                .setDescription(
                  `**${senderName}** wants to trade with you on **${interaction.guild.name}**.\n\n` +
                  `**They offer:** FRC ${offering} — ${offerName}\n` +
                  `**They want from you:** FRC ${wanting} — ${wantName}\n\n` +
                  `Trade ID: \`${tradeId}\`\n\n` +
                  `Use the buttons below, or run \`/trade accept\` / \`/trade decline\` in the server.`
                )
                .setColor(0xF0A500)
            ],
            components: [
              new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setCustomId(`trade_accept_${guildId}_${channelId}`)
                  .setLabel('✅ Accept Trade')
                  .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                  .setCustomId(`trade_decline_${guildId}_${channelId}`)
                  .setLabel('❌ Decline Trade')
                  .setStyle(ButtonStyle.Danger)
              )
            ]
          });
        }).catch(() => {}); // silently ignore if DMs are disabled
      }

      const recipientLine = isManualRecipient
        ? `${playerDisplay(theirOwner)}: an admin must run \`/admin trade manualaccept\` with Trade ID \`${tradeId}\` to accept.`
        : `<@${theirOwner}>: run \`/trade accept\` to accept or \`/trade decline\` to decline *(a DM with buttons has been sent if your DMs are open)*.`;

      return interaction.reply({ embeds: [
        new EmbedBuilder()
          .setTitle("🔄 Trade Proposal")
          .setDescription(
            `${playerDisplay(userId)} wants to trade with ${playerDisplay(theirOwner)}\n\n` +
            `**Offering:** ${offerName}\n` +
            `**Requesting:** ${wantName}\n\n` +
            `Trade ID: \`${tradeId}\`\n\n` +
            recipientLine
          )
          .setColor(0xF0A500)
      ]});
    }

    // ── TRADE LOCK OVERRIDE ─────────────────────────────────────────
    if (interaction.commandName === 'trade' && interaction.options.getSubcommand() === 'lock') {
      if (!isEffectiveAdmin(data, interaction)) return interaction.reply({ content: "❌ Only admins can change the trade lock.", ephemeral: true });
      const mode = interaction.options.getString('mode');
      guildConfig.tradeLockOverride = mode === 'locked' ? true : mode === 'open' ? false : null;
      saveGuildConfig(guildConfig, guildId);
      const msg = mode === 'locked'
        ? "🔒 Trading is now **manually locked**, regardless of week or draft phase."
        : mode === 'open'
        ? "🔓 Trading is now **manually forced open**, ignoring the Week 5 and post-worlds deadlines."
        : "⚙️ Trade lock reset to **auto** — locked after Week 5, and 24h after the worlds draft finishes.";
      return interaction.reply({ content: msg, ephemeral: true });
    }

    // ── ACCEPT TRADE ──────────────────────────────────────────────
    if (interaction.commandName === 'trade' && interaction.options.getSubcommand() === 'accept') {
      const trade = data.pendingTrade;
      if (!trade) return interaction.reply({ content: "❌ There's no pending trade.", ephemeral: true });

      const recipientIsManual = trade.to.startsWith('MANUAL_');
      if (recipientIsManual) {
        return interaction.reply({
          content: `❌ This trade is directed at a manual player. An admin must use \`/admin trade manualaccept\` with Trade ID \`${trade.tradeId}\`.`,
          ephemeral: true
        });
      }
      if (userId !== trade.to) return interaction.reply({ content: "❌ This trade isn't directed at you.", ephemeral: true });

      // Verify ownership is still valid — an undo between proposal and acceptance
      // could have changed things (mirrors the DM-button handler's check).
      const fromTeams = data.teamsDrafted[trade.from] ?? [];
      const toTeams   = data.teamsDrafted[trade.to]   ?? [];
      if (!fromTeams.includes(trade.offering) || !toTeams.includes(trade.wanting)) {
        data.pendingTrade = null;
        saveData(data, channelId);
        return interaction.reply({ content: "❌ This trade is no longer valid — one or both teams have changed hands since the proposal was sent. The trade has been cancelled.", ephemeral: true });
      }

      data.teamsDrafted[trade.from] = fromTeams.filter(t => t !== trade.offering);
      data.teamsDrafted[trade.to]   = toTeams.filter(t => t !== trade.wanting);
      data.teamsDrafted[trade.from].push(trade.wanting);
      data.teamsDrafted[trade.to].push(trade.offering);
      data.pendingTrade = null;
      saveData(data, channelId);

      const [offerName, wantName] = await Promise.all([getTeamName(trade.offering), getTeamName(trade.wanting)]);
      return interaction.reply(
        `✅ **Trade accepted!**\n${playerDisplay(trade.from)} receives **${wantName}**\n${playerDisplay(trade.to)} receives **${offerName}**`
      );
    }

    // ── DECLINE TRADE ─────────────────────────────────────────────
    if (interaction.commandName === 'trade' && interaction.options.getSubcommand() === 'decline') {
      const trade = data.pendingTrade;
      if (!trade) return interaction.reply({ content: "❌ There's no pending trade.", ephemeral: true });

      const recipientIsManual = trade.to.startsWith('MANUAL_');
      if (recipientIsManual && userId !== trade.from) {
        return interaction.reply({
          content: `❌ This trade is directed at a manual player. An admin must use \`/admin trade manualdecline\` with Trade ID \`${trade.tradeId}\`.`,
          ephemeral: true
        });
      }
      if (!recipientIsManual && userId !== trade.to && userId !== trade.from) {
        return interaction.reply({ content: "❌ You're not part of this trade.", ephemeral: true });
      }

      data.pendingTrade = null;
      saveData(data, channelId);
      return interaction.reply("❌ Trade cancelled.");
    }

    // ── STANDINGS ─────────────────────────────────────────────────
    if (interaction.commandName === 'stats' && interaction.options.getSubcommand() === 'standings') {
      await interaction.deferReply();
      if (!data.players.length) return interaction.editReply("No players in the draft yet.");
      if (data.phase === "none") return interaction.editReply("The draft hasn't started yet.");

      const isWorlds = data.phase === "worlds" || data.phase === "worlds_finished";
      const year = getYear(data);
      const scoreFn  = isWorlds ? t => getTeamWorldsScore(t, year) : t => getTeamSeasonScore(t, year);
      const phaseLabel = isWorlds ? "Worlds" : "Season";

      const playerScores = await calcStandings(data, scoreFn);
      const medals = ['🥇', '🥈', '🥉'];

      const desc = playerScores.map(({ player, totalScore }, i) => {
        const teams = data.teamsDrafted[player] || [];
        const avg = teams.length ? (totalScore / teams.length).toFixed(1) : "0.0";
        const teamsLine = teams.length ? `Teams: ${teams.map(t => `FRC ${t}`).join(', ')}` : "No teams drafted yet.";
        return `${medals[i] || `**${i + 1}.**`} ${playerDisplay(player)} — **${totalScore} pts** *(avg ${avg}/team)*\n${teamsLine}`;
      }).join('\n\n');

      return interaction.editReply({ embeds: [
        new EmbedBuilder()
          .setTitle(`📊 Fantasy Standings — ${phaseLabel}`)
          .setDescription(desc)
          .setColor(0x00AE86)
          .setFooter({ text: isWorlds
            ? "Points: Championship division ranking, playoff, and award points via TBA"
            : "Points: First 2 event district/regional points via TBA (1 event = doubled)"
          })
      ]});
    }

    // ── CURRENT YEAR ──────────────────────────────────────────────
    if (interaction.commandName === 'season' && interaction.options.getSubcommand() === 'current') {
      const y = getYear(data);
      const src = data.year ? "overridden by admin" : "default (current calendar year)";
      return interaction.reply(`📅 The bot is using **${y}** for TBA data (${src}).`);
    }

    if (interaction.commandName === 'season' && interaction.options.getSubcommand() === 'set') {
      if (!isEffectiveAdmin(data, interaction)) return interaction.reply({ content: "❌ Only admins can set the year.", ephemeral: true });
      const y = interaction.options.getInteger('year');
      data.year = y;
      seasonTeamsCache = null;
      seasonTeamsCacheYear = null;
      saveData(data, channelId);
      return interaction.reply(`📅 Year set to **${y}**. Team cache cleared — next draft will load ${y} teams from TBA.`);
    }

    if (interaction.commandName === 'pick' && interaction.options.getSubcommand() === 'skip') {
      if (!guildConfig.botAutoPickEnabled) return interaction.reply({ content: "❌ Auto-pick is disabled on this server. You must pick a team manually with `/pick team`.", ephemeral: true });
      if (data.phase === 'none') return interaction.reply({ content: "❌ The draft hasn't started yet.", ephemeral: true });
      if (data.phase === 'finished' || data.phase === 'worlds_finished') return interaction.reply({ content: "❌ The draft is already complete.", ephemeral: true });
      const current = getCurrentPlayer(data);
      if (userId !== current && !isEffectiveAdmin(data, interaction)) return interaction.reply({ content: "⛔ It's not your turn (or you are not an admin).", ephemeral: true });
      const pool = data.phase === "worlds" ? data.worldsTeams : data.seasonTeams;
      const drafted = new Set(Object.values(data.teamsDrafted).flat());
      const available = pool.filter(t => !drafted.has(t));
      if (!available.length) return interaction.reply({ content: "❌ No teams left in the pool.", ephemeral: true });

      await interaction.deferReply();
      const year = getYear(data);
      const scoreFn = data.phase === "worlds"
        ? t => getTeamWorldsScore(t, year)
        : t => getTeamHistoricalSeasonScore(t, year);
      const scored = await Promise.all(available.map(async t => ({ team: t, score: await scoreFn(t) })));
      const team = (await pickWithRandomness(scored, 15, 0.9, '/skip', 5)).team;

      data.teamsDrafted[current].push(team);
      data.currentPick++;
      data.pickLog.push({ player: current, team, pickIndex: data.currentPick - 1 });

      const name = await getTeamName(team);
      const maxPicks = data.players.length * (data.teamsPerPlayer || 6);

      if (data.currentPick >= maxPicks) {
        data.phase = data.phase === "worlds" ? "worlds_finished" : "finished";
        if (data.phase === 'worlds_finished') data.worldsFinishedAt = Date.now();
        saveData(data, channelId);
        clearPickTimer(guildId);
        if (data.phase === "finished") postRosterAnnouncement(data, guildId).catch(() => {});
        dmDraftWinner(data, guildId).catch(() => {});
        return interaction.editReply(`⚡ ${playerDisplay(current)} skipped and picked **${name}**\n\n🏁 **Draft complete!**`);
      }

      saveData(data, channelId);
      const next = getCurrentPlayer(data);
      await interaction.editReply(`⚡ ${playerDisplay(current)} skipped and picked **${name}**\n\n👉 Next pick: ${playerDisplay(next)}`);

      if (isBotPlayer(next)) {
        clearPickTimer(guildId);
        await doBotPick(data, channelId, interaction.channel, guildId);
      } else {
        startPickTimer(guildId, channelId);
      }
      return;
    }

    // ── SCORE BREAKDOWN ───────────────────────────────────────────
    if (interaction.commandName === 'team' && interaction.options.getSubcommand() === 'score') {
      await interaction.deferReply();
      const teamNumber = interaction.options.getInteger('team');

      const year = getYear(data);
      const [teamName, events] = await Promise.all([
        getTeamName(teamNumber),
        safeFetch(`https://www.thebluealliance.com/api/v3/team/frc${teamNumber}/events/${year}`, TBA)
      ]);

      if (!events?.length) return interaction.editReply(`No ${year} events found for FRC ${teamNumber}.`);

      const regularEvents = events
        .filter(e => e.event_type === 0 || e.event_type === 1)
        .sort((a, b) => new Date(a.start_date) - new Date(b.start_date))
        .slice(0, 2);

      if (!regularEvents.length) return interaction.editReply(`No regular season events found for **${teamName}** in ${year}.`);

      const dpResults = await Promise.all(
        regularEvents.map(ev => safeFetch(`https://www.thebluealliance.com/api/v3/event/${ev.key}/district_points`, TBA))
      );

      let grandTotal = 0, eventCount = 0;
      let desc = `**${teamName}**\n\n`;

      for (let i = 0; i < regularEvents.length; i++) {
        const ev  = regularEvents[i];
        const pts = dpResults[i]?.points?.[`frc${teamNumber}`];
        const typeLabel = ev.event_type === 0 ? 'Regional' : 'District';
        desc += `**${ev.name}** *(${typeLabel} — ${ev.start_date})*\n`;
        if (pts) {
          desc += `> Qual points:     **${pts.qual_points}**\n`;
          desc += `> Alliance points: **${pts.alliance_points}**\n`;
          desc += `> Playoff points:  **${pts.elim_points}**\n`;
          desc += `> Award points:    **${pts.award_points}**\n`;
          desc += `> **Event total: ${pts.total} pts**\n\n`;
          grandTotal += pts.total;
          eventCount++;
        } else {
          desc += `> *No results yet*\n\n`;
        }
      }

      if (eventCount === 1) { desc += `*Only 1 event played — points doubled*\n`; grandTotal *= 2; }
      desc += `\n**Fantasy Season Total: ${grandTotal} pts**`;

      return interaction.editReply({ embeds: [
        new EmbedBuilder().setTitle(`📋 Score Breakdown`).setDescription(desc).setColor(0x00AE86)
      ]});
    }

    if (interaction.commandName === 'stats' && interaction.options.getSubcommand() === 'breakdown') {
      await interaction.deferReply();
      const rawTarget = interaction.options.getString('player').trim();

      let playerIds;
      if (rawTarget.toUpperCase() === 'ALL') {
        playerIds = data.players;
      } else {
        // Accept a raw id, an @mention, or a manual player's plain name.
        const mentionMatch = rawTarget.match(/^<@!?(\d+)>$/);
        const resolvedId = mentionMatch ? mentionMatch[1]
          : data.players.includes(`MANUAL_${rawTarget}`) ? `MANUAL_${rawTarget}`
          : rawTarget;
        playerIds = data.players.filter(p => p === resolvedId);
      }

      if (!playerIds.length) return interaction.editReply("No matching fantasy player found. Use `ALL`, an @mention, or a manual player's exact name.");

      const year = getYear(data);
      const scoreFn = data.phase === "worlds" || data.phase === "worlds_finished" ? t => getTeamWorldsScore(t, year) : t => getTeamSeasonScore(t, year);
      const blocks = await Promise.all(playerIds.map(async player => {
        const teams = data.teamsDrafted[player] || [];
        const teamLines = await Promise.all(teams.map(async team => {
          const pts = await scoreFn(team);
          return `- FRC ${team}: **${pts} pts**`;
        }));
        const total = (await Promise.all(teams.map(scoreFn))).reduce((a, b) => a + b, 0);
        return `**${playerDisplay(player)}**\nTotal: **${total} pts**\n${teamLines.join('\n') || 'No teams drafted yet.'}`;
      }));

      return interaction.editReply({
        embeds: [new EmbedBuilder().setTitle("Fantasy Team Breakdown").setDescription(blocks.join('\n\n')).setColor(0x00AE86)]
      });
    }

    // ── UNDRAFT ─────────────────────────────────────────────────
    if (interaction.commandName === 'pick' && interaction.options.getSubcommand() === 'undo') {
      if (!isEffectiveAdmin(data, interaction)) return interaction.reply({ content: "❌ Only an admin can undraft.", ephemeral: true });
      if (!data.pickLog?.length) return interaction.reply({ content: "❌ No picks have been made yet.", ephemeral: true });

      const targetTeam = interaction.options.getInteger('team');
      let entry;

      if (targetTeam != null) {
        entry = data.pickLog.slice().reverse().find(p => p.team === targetTeam);
        if (!entry) return interaction.reply({ content: `❌ Team ${targetTeam} was never picked.`, ephemeral: true });
      } else {
        entry = data.pickLog[data.pickLog.length - 1];
      }

      data.teamsDrafted[entry.player] = (data.teamsDrafted[entry.player] || []).filter(t => t !== entry.team);
      data.pickLog = data.pickLog.filter(p => p.pickIndex !== entry.pickIndex);
      data.currentPick = entry.pickIndex;
      // "finished" only ever comes from the season draft completing (doBotPick/pick/skip/
      // manualpick/auto-skip only set it that way), so reopening it always means "season".
      if (data.phase === "finished") data.phase = "season";
      if (data.phase === "worlds_finished") { data.phase = "worlds"; data.worldsFinishedAt = null; }
      saveData(data, channelId);

      const name = await getTeamName(entry.team);
      const current = getCurrentPlayer(data);
      return interaction.reply(`⏪ Undrafted **${name}** (was pick #${entry.pickIndex + 1} by ${playerDisplay(entry.player)})\n\n👉 Current pick: ${playerDisplay(current)}`);
    }

    // ── PODIUM ───────────────────────────────────────────────────────
    if (interaction.commandName === 'stats' && interaction.options.getSubcommand() === 'podium') {
      if (!data.players.length) return interaction.reply("No players in the draft yet.");
      await interaction.deferReply();

      const year = getYear(data);
      const scoreFn = data.phase === "worlds" || data.phase === "worlds_finished" ? t => getTeamWorldsScore(t, year) : t => getTeamSeasonScore(t, year);
      const medals = ['🥇', '🥈', '🥉'];

      const standings = await calcStandings(data, scoreFn);
      const top3 = standings.slice(0, 3);

      let desc = "**Top 3 Fantasy Players**\n\n";
      for (let i = 0; i < top3.length; i++) {
        const p = top3[i];
        desc += `${medals[i]} ${playerDisplay(p.player)} — **${p.totalScore} pts**\n`;
      }

      const viewerRank = standings.findIndex(s => s.player === userId);
      if (viewerRank >= 0) {
        const place = viewerRank + 1;
        const suffix = (place % 10 === 1 && place !== 11) ? 'st' : (place % 10 === 2 && place !== 12) ? 'nd' : (place % 10 === 3 && place !== 13) ? 'rd' : 'th';
        const viewer = standings[viewerRank];
        desc += `\n👤 **Your placement:** ${place}${suffix} place — **${viewer.totalScore} pts**`;
      } else {
        desc += "\n👤 You are not in this draft.";
      }

      return interaction.editReply({ embeds: [
        new EmbedBuilder().setTitle("🏆 Fantasy Podium").setDescription(desc).setColor(0xFFD700)
      ]});
    }

    // ── EXPORT CSV ────────────────────────────────────────────────
    if (interaction.commandName === 'stats' && interaction.options.getSubcommand() === 'export') {
      await interaction.deferReply({ ephemeral: true });
      if (!data.players.length) return interaction.editReply("No players in the draft yet.");

      const year = getYear(data);
      const n = data.draftOrder.length || data.players.length;

      // ── FILE 1: picks_YYYY.csv ──────────────────────────────────────────────
      // One row per pick in draft order. Calculates round + position from pickIndex.
      const pickRows = [['Overall Pick', 'Round', 'Round Pick', 'Player', 'Team Number', 'Team Name', 'Is CPU']];
      const sortedLog = [...(data.pickLog || [])].sort((a, b) => a.pickIndex - b.pickIndex);
      const pickNames = await Promise.all(sortedLog.map(e => getTeamName(e.team)));
      const pickPlayerNames = await Promise.all(sortedLog.map(e => playerNameForExport(e.player, interaction.guild)));
      for (let i = 0; i < sortedLog.length; i++) {
        const entry = sortedLog[i];
        const round = n > 0 ? Math.floor(entry.pickIndex / n) + 1 : '?';
        const posInRound = n > 0 ? (entry.pickIndex % n) + 1 : '?';
        pickRows.push([
          entry.pickIndex + 1,
          round,
          posInRound,
          pickPlayerNames[i],
          entry.team,
          pickNames[i],
          isBotPlayer(entry.player) ? 'Yes' : 'No'
        ]);
      }
      const csvPicks = pickRows
        .map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))
        .join('\n');

      // ── FILE 2: standings_YYYY.csv ─────────────────────────────────────────
      // One row per (player, team). Fetches live TBA points for each team,
      // includes per-event breakdown, doubled flag, and player fantasy total.
      const standingRows = [['Rank', 'Player', 'Player Total Pts', 'Team Number', 'Team Name',
        'Event 1 Key', 'Event 1 Pts', 'Event 2 Key', 'Event 2 Pts', 'Raw Total', 'Doubled']];

      // Fetch all breakdowns in parallel per player
      const playerBreakdowns = await Promise.all(data.players.map(async player => {
        const teams = data.teamsDrafted[player] || [];
        const breakdowns = await Promise.all(teams.map(t => getTeamEventBreakdown(t, year)));
        const playerTotal = breakdowns.reduce((sum, b) => sum + (b.total || 0), 0);
        return { player, teams, breakdowns, playerTotal };
      }));

      // Sort by descending fantasy total for ranking
      playerBreakdowns.sort((a, b) => b.playerTotal - a.playerTotal);

      const standingsPlayerNames = {};
      await Promise.all(playerBreakdowns.map(async ({ player }) => {
        standingsPlayerNames[player] = await playerNameForExport(player, interaction.guild);
      }));

      let rank = 1;
      for (const { player, teams, breakdowns, playerTotal } of playerBreakdowns) {
        if (!teams.length) {
          standingRows.push([rank, standingsPlayerNames[player], 0, '', 'No teams drafted', '', '', '', '', '', '']);
          rank++;
          continue;
        }
        for (let i = 0; i < teams.length; i++) {
          const b = breakdowns[i];
          const ev1 = b.events[0];
          const ev2 = b.events[1];
          standingRows.push([
            i === 0 ? rank : '',                           // rank only on first row per player
            i === 0 ? standingsPlayerNames[player] : '',   // name only on first row per player
            i === 0 ? playerTotal : '',                    // total only on first row per player
            teams[i],
            await getTeamName(teams[i]),
            ev1?.eventKey ?? '',
            ev1?.rawPoints ?? '',
            ev2?.eventKey ?? '',
            ev2?.rawPoints ?? '',
            b.events.reduce((s, e) => s + (e.rawPoints || 0), 0),
            b.doubled ? 'Yes' : 'No'
          ]);
        }
        rank++;
      }

      const csvStandings = standingRows
        .map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))
        .join('\n');

      const attPicks = new AttachmentBuilder(Buffer.from(csvPicks, 'utf-8'), { name: `picks_${year}.csv` });
      const attStandings = new AttachmentBuilder(Buffer.from(csvStandings, 'utf-8'), { name: `standings_${year}.csv` });

      return interaction.editReply({
        content: `📄 **${year} FRC Fantasy Export** — two files attached:\n• \`picks_${year}.csv\` — full draft pick log with round/position\n• \`standings_${year}.csv\` — live standings with per-team event point breakdown`,
        files: [attPicks, attStandings]
      });
    }

    // ── ROSTER ────────────────────────────────────────────────────
    if (interaction.commandName === 'stats' && interaction.options.getSubcommand() === 'roster') {
      if (!data.players.length) return interaction.reply("No players in the draft yet.");
      await interaction.deferReply();

      const lines = await Promise.all(data.players.map(async player => {
        const owned = data.teamsDrafted[player] || [];
        const names = await Promise.all(owned.map(getTeamName));
        return `**${playerDisplay(player)}**\n` +
          (names.length ? names.map(n => `• ${n}`).join('\n') : "No teams drafted yet.");
      }));

      return interaction.editReply({ embeds: [
        new EmbedBuilder().setTitle("📋 Fantasy Draft Roster").setDescription(lines.join('\n\n')).setColor(0x00AE86)
      ]});
    }

    // ── SHOW ALL FANTASY TEAMS ────────────────────────────────────
    if (interaction.commandName === 'stats' && interaction.options.getSubcommand() === 'teams') {
      if (!data.players.length) return interaction.reply("No players in the draft yet.");
      await interaction.deferReply();

      const lines = await Promise.all(data.players.map(async player => {
        const owned = data.teamsDrafted[player] || [];
        const names = await Promise.all(owned.map(getTeamName));
        return `**${playerDisplay(player)}** (${owned.length} teams)\n` +
          (names.length ? names.map(n => `• ${n}`).join('\n') : "No teams drafted yet.");
      }));

      return interaction.editReply({ embeds: [
        new EmbedBuilder().setTitle("Fantasy Draft Teams").setDescription(lines.join('\n\n')).setColor(0x00AE86)
      ]});
    }

    // ── SEARCH TEAM BY NAME ───────────────────────────────────────
    if (interaction.commandName === 'team' && interaction.options.getSubcommand() === 'search') {
      await interaction.deferReply();
      const search = interaction.options.getString('name').toLowerCase();
      const allTeams = await loadSeasonTeams(getYear(data));
      const matches = [];
      for (const num of allTeams) {
        const name = await getTeamName(num);
        if (name.toLowerCase().includes(search)) { matches.push(name); if (matches.length >= 15) break; }
      }
      if (!matches.length) return interaction.editReply(`No teams found for "${search}".`);
      return interaction.editReply({ embeds: [
        new EmbedBuilder().setTitle(`Teams matching "${search}"`).setDescription(matches.join('\n')).setColor(0x00AE86)
      ]});
    }

    // ── IDENTIFY TEAM BY NUMBER ───────────────────────────────────
    if (interaction.commandName === 'team' && interaction.options.getSubcommand() === 'identify') {
      await interaction.deferReply();
      return interaction.editReply(`🔍 **${await getTeamName(interaction.options.getInteger('number'))}**`);
    }

    // ── RESET DRAFT ───────────────────────────────────────────────
    if (interaction.commandName === 'draft' && interaction.options.getSubcommand() === 'reset') {
      if (interaction.options.getString('confirm') !== "RESET") return interaction.reply("Type `RESET` to confirm.");
      if (!isEffectiveAdmin(data, interaction)) return interaction.reply("❌ Only an admin can reset.");
      clearPickTimer(guildId);
      saveData(freshData(), channelId);
      return interaction.reply("🧹 Draft fully reset.");
    }

    // ── HARD RESET (nuclear option for corrupted/unrecoverable server data) ──
    if (interaction.commandName === 'draft' && interaction.options.getSubcommand() === 'hardreset') {
      // Uses Discord's native Manage Server permission rather than the bot's own
      // admin list, since that list itself may be part of what's corrupted.
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: "❌ You need **Manage Server** permission to hard reset.", ephemeral: true });
      }
      if (interaction.options.getString('confirm') !== "HARDRESET") {
        return interaction.reply({
          content: "⚠️ This wipes **all** draft data, admins, the draft channel binding, pick timer, and trade lock settings for this server — not just the current draft. Type `HARDRESET` to confirm.",
          ephemeral: true
        });
      }

      clearPickTimer(guildId);

      // Wipe every per-channel draft data file for this guild (in case the channel
      // binding itself is stale/wrong), not just the current channel.
      const wipedChannels = [];
      for (const file of fs.readdirSync('.')) {
        if (!/^data_\d+\.json$/.test(file)) continue;
        const candidateChannelId = file.slice('data_'.length, -'.json'.length);
        try {
          const channel = await client.channels.fetch(candidateChannelId).catch(() => null);
          if (channel && channel.guildId === guildId) {
            fs.unlinkSync(file);
            wipedChannels.push(candidateChannelId);
          }
        } catch { /* skip unreadable/inaccessible channel */ }
      }
      // Always ensure the current channel's data is gone even if the fetch above failed.
      const currentFile = `./data_${channelId}.json`;
      if (fs.existsSync(currentFile)) fs.unlinkSync(currentFile);

      // Reset guild-level config (channel binding, admins live in data not config, timer, trade lock, etc.)
      const configFile = `./guild_config_${guildId}.json`;
      if (fs.existsSync(configFile)) fs.unlinkSync(configFile);

      return interaction.reply(
        `☢️ **Hard reset complete.** Wiped draft data for ${wipedChannels.length || 1} channel(s) and reset this server's configuration ` +
        `(draft channel binding, admins, pick timer, trade lock override).\n\nRun \`/admin setchannel\` to pick a draft channel, then \`/draft status open:true\` to reopen the draft.`
      );
    }

    // ── RESTORE FROM MESSAGE HISTORY ─────────────────────────────
    if (interaction.commandName === 'draft' && interaction.options.getSubcommand() === 'restore') {
      if (!isEffectiveAdmin(data, interaction)) {
        return interaction.reply({ content: "❌ Only admins can restore from message history.", ephemeral: true });
      }
      if (interaction.options.getString('confirm') !== "RESTORE") {
        return interaction.reply({
          content: "⚠️ This will **overwrite** the current draft data with a version rebuilt from this channel's message history.\n\nType `RESTORE` to confirm.",
          ephemeral: true
        });
      }
      if (!guildConfig.draftChannelId) {
        return interaction.reply({ content: "❌ No draft channel is configured. Run `/admin setchannel` first.", ephemeral: true });
      }

      await interaction.deferReply();

      let rebuilt;
      try {
        rebuilt = await rebuildDataFromChannelHistory(guildConfig.draftChannelId);
      } catch (err) {
        console.error('Manual restore failed:', err);
        return interaction.editReply("❌ Restore failed with an unexpected error. Check the console for details.");
      }

      if (!rebuilt) {
        return interaction.editReply(
          "❌ Couldn't rebuild from message history. This usually means the scan hit the 1 000-message limit without finding a reset boundary — the history may be too long or the channel hasn't had a recent `/draft status open:false` or `/draft reset`.\n\n" +
          "If the draft is truly lost, use `/draft status open:true` to start fresh."
        );
      }

      if (!rebuilt.players.length && rebuilt.phase === 'none' && !rebuilt.pickLog.length) {
        return interaction.editReply("ℹ️ Message history was scanned but no draft activity was found. Nothing was changed.");
      }

      saveData(rebuilt, guildConfig.draftChannelId);

      const phaseLabel = {
        none: 'none',
        season: 'Season draft in progress',
        finished: 'Season draft complete',
        worlds: 'Worlds draft in progress',
        worlds_finished: 'Worlds draft complete',
      }[rebuilt.phase] || rebuilt.phase;

      const playerCount = rebuilt.players.length;
      const pickCount = rebuilt.pickLog?.length ?? 0;
      const teamCount = Object.values(rebuilt.teamsDrafted).reduce((n, teams) => n + teams.length, 0);

      return interaction.editReply(
        `✅ **Draft state restored from message history.**\n` +
        `• **Phase:** ${phaseLabel}\n` +
        `• **Players:** ${playerCount}\n` +
        `• **Picks logged:** ${pickCount} (${teamCount} teams assigned)\n` +
        `• **Year:** ${rebuilt.year ?? 'auto'}\n\n` +
        `If anything looks wrong, use \`/stats roster\` to verify rosters, or \`/draft reset\` to start over.`
      );
    }

    // ── SET PICK TIMER ────────────────────────────────────────────
    if (interaction.commandName === 'draft' && interaction.options.getSubcommand() === 'timer') {
      if (!isEffectiveAdmin(data, interaction)) return interaction.reply({ content: "❌ Only admins can set the pick timer.", ephemeral: true });
      const minutes = interaction.options.getInteger('minutes');
      guildConfig.pickTimerMinutes = minutes;
      saveGuildConfig(guildConfig, guildId);
      if (minutes === 0) {
        clearPickTimer(guildId);
        return interaction.reply({ content: "⏱️ Pick timer **disabled**.", ephemeral: true });
      }
      const grace = graceMinutesFor(minutes);
      return interaction.reply({
        content: `⏱️ Pick timer set to **${minutes} minute${minutes === 1 ? '' : 's'}**.\n` +
          `If a player doesn't pick in time, they'll be pinged and get an extra **${formatMinutes(grace)} minute${grace === 1 ? '' : 's'}** grace period before being auto-picked.`,
        ephemeral: true
      });
    }

    // ── DRAFT ORDER ───────────────────────────────────────────────
    if (interaction.commandName === 'draft' && interaction.options.getSubcommand() === 'order') {
      if (!data.players.length) return interaction.reply({ content: "No players in the draft yet.", ephemeral: true });
      if (data.phase === 'none') return interaction.reply({ content: "The draft hasn't started yet.", ephemeral: true });
      if (data.phase === 'finished' || data.phase === 'worlds_finished') return interaction.reply({ content: "The draft is already complete.", ephemeral: true });

      const count = Math.min(interaction.options.getInteger('picks') ?? 10, 20);
      const n = data.draftOrder.length;
      const maxPicks = data.players.length * (data.teamsPerPlayer || 6);
      const lines = [];

      for (let i = 0; i < count; i++) {
        const idx = data.currentPick + i;
        if (idx >= maxPicks) break;
        const player = data.pickOrder.length > 0
          ? data.pickOrder[idx]
          : (() => { const r = Math.floor(idx / n); const p = idx % n; return r % 2 === 0 ? data.draftOrder[p] : data.draftOrder[n - 1 - p]; })();
        const marker = i === 0 ? ' ← **now**' : '';
        lines.push(`\`Pick ${idx + 1}\` — ${playerDisplay(player)}${marker}`);
      }

      const timerNote = guildConfig.pickTimerMinutes > 0
        ? `\n⏱️ Auto-skip timer: **${guildConfig.pickTimerMinutes} min** (+ **${formatMinutes(graceMinutesFor(guildConfig.pickTimerMinutes))} min** grace period)`
        : '';
      return interaction.reply({ embeds: [
        new EmbedBuilder()
          .setTitle('📋 Upcoming Draft Order')
          .setDescription((lines.join('\n') || '*No picks remaining.*') + timerNote)
          .setColor(0x5865F2)
          .setFooter({ text: `Snake draft • showing next ${lines.length} pick${lines.length === 1 ? '' : 's'}` })
      ]});
    }

    // ── MY TEAMS ──────────────────────────────────────────────────
    if (interaction.commandName === 'stats' && interaction.options.getSubcommand() === 'myteams') {
      await interaction.deferReply({ ephemeral: true });
      if (!data.players.includes(userId)) return interaction.editReply("❌ You're not in this draft.");
      if (data.phase === 'none') return interaction.editReply("The draft hasn't started yet.");

      const myTeams = data.teamsDrafted[userId] || [];
      if (!myTeams.length) return interaction.editReply("You haven't drafted any teams yet.");

      const isWorlds = data.phase === 'worlds' || data.phase === 'worlds_finished';
      const year = getYear(data);
      const scoreFn = isWorlds ? t => getTeamWorldsScore(t, year) : t => getTeamSeasonScore(t, year);

      const breakdowns = await Promise.all(myTeams.map(async team => {
        const [name, score, bd] = await Promise.all([
          getTeamName(team),
          scoreFn(team),
          isWorlds ? Promise.resolve(null) : getTeamEventBreakdown(team, year)
        ]);
        return { team, name, score, bd };
      }));

      const myTotal = breakdowns.reduce((s, b) => s + b.score, 0);

      const lines = breakdowns.map(({ team, name, score, bd }) => {
        const doubled = bd?.doubled ? ' *(doubled)*' : '';
        const evLines = bd?.events.map(e => `  → ${e.eventKey}: **${e.rawPoints ?? '?'} pts**`).join('\n') ?? '';
        return `**FRC ${team} — ${name.split(' (')[0]}**\n${evLines ? evLines + '\n' : ''}  Total: **${score} pts**${doubled}`;
      });

      // Compute rank among all players
      const allTotals = await Promise.all(data.players.map(async p => ({
        player: p,
        total: (await Promise.all((data.teamsDrafted[p] || []).map(scoreFn))).reduce((a, b) => a + b, 0)
      })));
      allTotals.sort((a, b) => b.total - a.total);
      const rank = allTotals.findIndex(s => s.player === userId) + 1;

      const desc = lines.join('\n\n');
      return interaction.editReply({ embeds: [
        new EmbedBuilder()
          .setTitle(`🏅 Your Teams — ${year}`)
          .setDescription(desc.length > 4000 ? desc.slice(0, 3997) + '…' : desc)
          .addFields({ name: 'Your Total', value: `**${myTotal} pts** — rank **${rank}** of ${data.players.length}` })
          .setColor(0x00AE86)
          .setFooter({ text: 'First 2 qualifying events only • doubled if only 1 event played' })
      ]});
    }

    // ── SCHEDULE ──────────────────────────────────────────────────
    if (interaction.commandName === 'stats' && interaction.options.getSubcommand() === 'schedule') {
      await interaction.deferReply();
      if (!data.players.length) return interaction.editReply("No players in the draft yet.");

      const year = getYear(data);
      const today = new Date();
      const twoWeeks = new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000);
      const todayStr = today.toISOString().split('T')[0];
      const twoWeeksStr = twoWeeks.toISOString().split('T')[0];

      const allEvents = await safeFetch(`https://www.thebluealliance.com/api/v3/events/${year}/simple`, TBA);
      if (!allEvents) return interaction.editReply("❌ Couldn't reach The Blue Alliance right now. Try again shortly.");

      const upcoming = allEvents.filter(e =>
        (e.event_type === 0 || e.event_type === 1) &&
        e.start_date > todayStr && e.start_date <= twoWeeksStr
      );
      if (!upcoming.length) return interaction.editReply("📅 No qualifying events starting in the next 2 weeks.");

      const allDraftedTeams = [...new Set(Object.values(data.teamsDrafted).flat())];
      const fields = [];

      for (const ev of upcoming) {
        const eventTeams = await safeFetch(`https://www.thebluealliance.com/api/v3/event/${ev.key}/teams/simple`, TBA);
        if (!eventTeams) continue;
        const eventTeamNums = new Set(eventTeams.map(t => t.team_number));
        const draftedHere = allDraftedTeams.filter(t => eventTeamNums.has(t));
        if (!draftedHere.length) continue;

        const lines = await Promise.all(draftedHere.map(async teamNum => {
          const name = await getTeamName(teamNum);
          const owner = findOwner(data, teamNum);
          const ownerLabel = isBotPlayer(owner) ? `🤖 CPU ${botNumber(owner)}`
            : owner?.startsWith('MANUAL_') ? `👤 ${owner.replace('MANUAL_', '')}`
            : owner ? `<@${owner}>` : '—';
          return `• FRC ${teamNum} — ${name.split(' (')[0]} (${ownerLabel})`;
        }));

        const weekLabel = `Week ${resolveEventWeek(ev) + 1}`;
        let fieldValue = `📆 ${ev.start_date} → ${ev.end_date}\n${lines.join('\n')}`;
        if (fieldValue.length > 1024) fieldValue = fieldValue.slice(0, 1020) + '\n…';
        fields.push({ name: `📍 ${ev.name} (${weekLabel})`, value: fieldValue });
      }

      if (!fields.length) return interaction.editReply("📅 No drafted teams are competing in events over the next 2 weeks.");

      return interaction.editReply({ embeds: [
        new EmbedBuilder()
          .setTitle('📅 Upcoming Events — Next 2 Weeks')
          .addFields(fields.slice(0, 25))
          .setColor(0x3498DB)
          .setFooter({ text: 'Qualifying events (Regionals & Districts) only' })
          .setTimestamp()
      ]});
    }

    // ── HELP ──────────────────────────────────────────────────────
    if (interaction.commandName === 'help') {
      return interaction.reply({
        ephemeral: true,
        embeds: [buildHelpHomeEmbed()],
        components: buildHelpHomeComponents()
      });
    }

    // ── RULES ─────────────────────────────────────────────────────
    if (interaction.commandName === 'rules') {
      return interaction.reply({ embeds: [
        new EmbedBuilder()
          .setTitle('📜 FRC Fantasy Scoring Rules')
          .setColor(0xE67E22)
          .addFields(
            {
              name: 'Which events count?',
              value: [
                '• **Regionals** (type 0) and **District events** (type 1) only',
                '• Only the **first 2** qualifying events per team are scored',
                '• **District Championships** (DCMP, type 2) are **excluded**',
              ].join('\n')
            },
            {
              name: 'How are points calculated?',
              value: [
                '• Points are pulled live from TBA district point totals',
                '• If a team only competes at **1** qualifying event, their points are **doubled**',
                '• The doubling is applied automatically',
              ].join('\n')
            },
            {
              name: 'Draft & Trades',
              value: [
                '• Each manager drafts **6 teams** in a snake order',
                '• Worlds draft is separate with its own scoring',
                '• Trades are open through **Week 5** and close automatically after it concludes',
                '• Trades also close **24 hours** after the worlds draft finishes',
                '• Admins can override the trade lock with `/trade lock`',
              ].join('\n')
            }
          )
          .setFooter({ text: 'Scores update live from The Blue Alliance' })
      ]});
    }

    // ── CONFIG BOTTRADING ─────────────────────────────────────────
    if (interaction.commandName === 'config' && interaction.options.getSubcommandGroup() === 'bottrading') {
      if (!isEffectiveAdmin(data, interaction)) return interaction.reply({ content: "❌ Only admins can change server configuration.", ephemeral: true });
      const enabling = interaction.options.getSubcommand() === 'enable';
      guildConfig.botTradingEnabled = enabling;
      saveGuildConfig(guildConfig, guildId);
      return interaction.reply({
        content: enabling
          ? "✅ CPU player trading **enabled** — players can now propose trades to CPU players."
          : "🚫 CPU player trading **disabled** — players can no longer propose trades to CPU players.",
        ephemeral: true
      });
    }

    // ── CONFIG BOTPICKSFORPLAYERS ──────────────────────────────────
    if (interaction.commandName === 'config' && interaction.options.getSubcommandGroup() === 'botpicksforplayers') {
      if (!isEffectiveAdmin(data, interaction)) return interaction.reply({ content: "❌ Only admins can change server configuration.", ephemeral: true });
      const enabling = interaction.options.getSubcommand() === 'enable';
      guildConfig.botAutoPickEnabled = enabling;
      saveGuildConfig(guildConfig, guildId);
      return interaction.reply({
        content: enabling
          ? "✅ Auto-pick **enabled** — `/pick skip` works and the bot will auto-pick for players whose timer expires."
          : "🚫 Auto-pick **disabled** — players must always pick manually. `/pick skip` is blocked and the timer will only warn, not auto-pick.",
        ephemeral: true
      });
    }

    // ── CONFIG PICK TEAMSPICKABLE ─────────────────────────────────
    if (interaction.commandName === 'config' && interaction.options.getSubcommandGroup() === 'pick' && interaction.options.getSubcommand() === 'teamspickable') {
      if (!isEffectiveAdmin(data, interaction)) return interaction.reply({ content: "❌ Only admins can change server configuration.", ephemeral: true });
      const count = interaction.options.getInteger('count');
      guildConfig.teamsPerPlayer = count;
      saveGuildConfig(guildConfig, guildId);
      return interaction.reply({
        content: `✅ Teams per player set to **${count}**. Takes effect on the next \`/draft start\`.`,
        ephemeral: true
      });
    }

    // ── CONFIG DRAFT STYLE ────────────────────────────────────────
    if (interaction.commandName === 'config' && interaction.options.getSubcommandGroup() === 'draft' && interaction.options.getSubcommand() === 'style') {
      if (!isEffectiveAdmin(data, interaction)) return interaction.reply({ content: "❌ Only admins can change server configuration.", ephemeral: true });
      const mode = interaction.options.getString('mode');
      guildConfig.draftStyle = mode;
      saveGuildConfig(guildConfig, guildId);
      return interaction.reply({
        content: mode === 'popcorn'
          ? "🍿 Draft style set to **Popcorn** — each round uses a fresh random pick order. Takes effect on the next `/draft start`."
          : "🐍 Draft style set to **Snake** — pick order reverses each round (default). Takes effect on the next `/draft start`.",
        ephemeral: true
      });
    }

    // ── ADMIN MANUAL ACCEPT TRADE ─────────────────────────────────
    if (interaction.commandName === 'admin' && interaction.options.getSubcommandGroup() === 'trade' && interaction.options.getSubcommand() === 'manualaccept') {
      if (!isEffectiveAdmin(data, interaction)) return interaction.reply({ content: "❌ Only admins can use this command.", ephemeral: true });
      const trade = data.pendingTrade;
      if (!trade) return interaction.reply({ content: "❌ There's no pending trade.", ephemeral: true });
      const inputId = interaction.options.getString('tradeid');
      if (inputId !== trade.tradeId) return interaction.reply({ content: `❌ Trade ID \`${inputId}\` doesn't match the pending trade (\`${trade.tradeId}\`).`, ephemeral: true });

      // Verify ownership is still valid — an undo between proposal and acceptance
      // could have changed things (mirrors the DM-button handler's check).
      const fromTeamsM = data.teamsDrafted[trade.from] ?? [];
      const toTeamsM   = data.teamsDrafted[trade.to]   ?? [];
      if (!fromTeamsM.includes(trade.offering) || !toTeamsM.includes(trade.wanting)) {
        data.pendingTrade = null;
        saveData(data, channelId);
        return interaction.reply({ content: "❌ This trade is no longer valid — one or both teams have changed hands since the proposal was sent. The trade has been cancelled.", ephemeral: true });
      }

      data.teamsDrafted[trade.from] = fromTeamsM.filter(t => t !== trade.offering);
      data.teamsDrafted[trade.to]   = toTeamsM.filter(t => t !== trade.wanting);
      data.teamsDrafted[trade.from].push(trade.wanting);
      data.teamsDrafted[trade.to].push(trade.offering);
      data.pendingTrade = null;
      saveData(data, channelId);

      const [offerName, wantName] = await Promise.all([getTeamName(trade.offering), getTeamName(trade.wanting)]);
      return interaction.reply(
        `✅ **Trade accepted!**\n${playerDisplay(trade.from)} receives **${wantName}**\n${playerDisplay(trade.to)} receives **${offerName}**`
      );
    }

    // ── ADMIN MANUAL DECLINE TRADE ────────────────────────────────
    if (interaction.commandName === 'admin' && interaction.options.getSubcommandGroup() === 'trade' && interaction.options.getSubcommand() === 'manualdecline') {
      if (!isEffectiveAdmin(data, interaction)) return interaction.reply({ content: "❌ Only admins can use this command.", ephemeral: true });
      const trade = data.pendingTrade;
      if (!trade) return interaction.reply({ content: "❌ There's no pending trade.", ephemeral: true });
      const inputId = interaction.options.getString('tradeid');
      if (inputId !== trade.tradeId) return interaction.reply({ content: `❌ Trade ID \`${inputId}\` doesn't match the pending trade (\`${trade.tradeId}\`).`, ephemeral: true });

      data.pendingTrade = null;
      saveData(data, channelId);
      return interaction.reply("❌ Trade declined by admin.");
    }

    // ── ANNOUNCE ──────────────────────────────────────────────────
    if (interaction.commandName === 'admin' && interaction.options.getSubcommand() === 'announce') {
      if (!isEffectiveAdmin(data, interaction)) return interaction.reply({ content: "❌ Only admins can post announcements.", ephemeral: true });
      const message = interaction.options.getString('message');
      if (!guildConfig.announcementChannelId) return interaction.reply({ content: "❌ No announcements channel is configured. Re-invite the bot or check that `#frc-fantasy-updates` exists.", ephemeral: true });
      const annChannel = await client.channels.fetch(guildConfig.announcementChannelId).catch(() => null);
      if (!annChannel) return interaction.reply({ content: "❌ Couldn't find the announcements channel.", ephemeral: true });
      await annChannel.send({ embeds: [
        new EmbedBuilder()
          .setDescription(message)
          .setColor(0x5865F2)
          .setFooter({ text: `Posted by ${interaction.user.username}` })
          .setTimestamp()
      ]});
      return interaction.reply({ content: "✅ Announcement posted.", ephemeral: true });
    }

  } catch (err) {
    console.error(err);
    const errMsg = `❌ An error occurred: \`${String(err?.message || err).slice(0, 500)}\``;
    if (interaction.deferred) interaction.editReply(errMsg).catch(() => {});
    else if (!interaction.replied) interaction.reply({ content: errMsg, ephemeral: true }).catch(() => {});
    // Send alert to the guild's announcements channel so the admin is notified
    sendBotAlert(guildId,
      `Command Error: \`/${interaction.commandName}\``,
      `An error occurred while handling this command.\n\`\`\`${String(err?.message || err).slice(0, 800)}\`\`\``
    ).catch(() => {});
  }
});

// Only connect to Discord when run directly (`node index.js`, i.e. the real bot process).
// Requiring this file from a test script (e.g. to exercise exported helpers) must not
// open a second gateway session against the live bot token.
if (require.main === module) {
  client.login(process.env.TOKEN);
}

// Exported for local testing only (e.g. exercising the auto-pick scoring logic without
// spinning up the full Discord client). Does not affect runtime behavior.
module.exports = {
  client, // exported so offline test harnesses can drive the interactionCreate handler via client.emit(...)
  getTeamHistoricalSeasonScore,
  getTeamWorldsScore,
  pickWithRandomness,
  loadSeasonTeams,
  getTeamName,
  getTeamEventBreakdown,
  playerName,
  getYear,
  DEFAULT_YEAR,
  BOT_PLAYER_ID,
  BOT_PLAYER_IDS,
  MAX_BOTS,
  isBotPlayer,
  botNumber,
  playerDisplay,
  resolvePlayerIdentityFromText,
  ensureRecoveredPlayer,
  applyRecoveredMessage,
  freshData,
};
