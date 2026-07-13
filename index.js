require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  AttachmentBuilder,
  ChannelType,
  PermissionFlagsBits
} = require('discord.js');
const cron = require('node-cron');

const fs = require('fs');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// Special ID for the CPU bot player
const BOT_PLAYER_ID = "BOT_PLAYER";

// ---------------- DATA (per-server) ----------------
function freshData() {
  return {
    players: [],
    draftOrder: [],
    teamsDrafted: {},
    currentPick: 0,
    phase: "none",
    draftOpen: false,
    lastSeasonStandings: [],
    worldsTeams: [],
    seasonTeams: [],
    pendingTrade: null,
    pickLog: [],
    admins: [],
    year: null
  };
}

function loadData(channelId) {
  try {
    const d = JSON.parse(fs.readFileSync(`./data_${channelId}.json`));
    if (!d.pendingTrade) d.pendingTrade = null;
    if (!d.admins) d.admins = d.players.length ? [d.players[0]] : [];
    if (!d.year) d.year = null;
    return d;
  } catch {
    return freshData();
  }
}

function getYear(data) {
  return data.year || new Date().getFullYear();
}

function saveData(data, channelId) {
  fs.writeFileSync(`./data_${channelId}.json`, JSON.stringify(data, null, 2));
}

// ---------------- GUILD CONFIG (per-server) ----------------
function loadGuildConfig(guildId) {
  try {
    const cfg = JSON.parse(fs.readFileSync(`./guild_config_${guildId}.json`));
    if (!('predictionMessageId' in cfg)) cfg.predictionMessageId = null;
    return cfg;
  } catch {
    return { draftChannelId: null, announcementChannelId: null, lastPostedWeek: -1, predictionMessageId: null };
  }
}

function saveGuildConfig(config, guildId) {
  fs.writeFileSync(`./guild_config_${guildId}.json`, JSON.stringify(config, null, 2));
}

// ---------------- TBA CACHE ----------------
const teamNameCache = new Map();
let seasonTeamsCache = null;

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
const CURRENT_YEAR = DEFAULT_YEAR; // compat alias, will be phased out by per-guild year

// Per-year cache for season teams
let seasonTeamsCacheYear = null;

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
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
  if (id === BOT_PLAYER_ID) return "🤖 **CPU**";
  if (id.startsWith("MANUAL_")) return `👤 **${id.replace("MANUAL_", "")}**`;
  return `<@${id}>`;
}

function playerName(id) {
  if (id === BOT_PLAYER_ID) return "CPU";
  if (id.startsWith("MANUAL_")) return id.replace("MANUAL_", "");
  return `<@${id}>`;
}

function isAdmin(data, userId) {
  return data.admins.includes(userId);
}

// ---------------- SCORING ----------------
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
      const q = Math.ceil((10 / 1.07) * erf((worldsEvents.length - 2 * ranking.rank + 2) / (1.07 * worldsEvents.length)) + 12);
      total += q;
    }

    const allianceIndex = alliances?.findIndex(a => a.picks?.includes(teamKey) || a.captain?.key === teamKey);
    if (allianceIndex != null && allianceIndex >= 0) total += Math.max(0, 17 - (allianceIndex + 1));

    const finals = matches?.filter(m => m.comp_level === 'f' && (m.winning_alliance === 'red' || m.winning_alliance === 'blue'));
    const playoffMatches = matches?.filter(m => ['qf', 'sf', 'f'].includes(m.comp_level) && (m.winning_alliance === 'red' || m.winning_alliance === 'blue')) || [];
    const teamMatches = playoffMatches.filter(m => m.alliances?.red?.team_keys?.includes(teamKey) || m.alliances?.blue?.team_keys?.includes(teamKey));
    const wonMatches = teamMatches.filter(m => m.alliances?.[m.winning_alliance]?.team_keys?.includes(teamKey));
    if (wonMatches.length) {
      const allianceWon = finals?.some(m => (m.alliances?.red?.team_keys?.includes(teamKey) || m.alliances?.blue?.team_keys?.includes(teamKey)) && m.alliances?.[m.winning_alliance]?.team_keys?.includes(teamKey));
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

    const lines = await Promise.all(data.players.map(async player => {
      const teams = data.teamsDrafted[player] || [];
      const names = await Promise.all(teams.map(getTeamName));
      return `**${playerDisplay(player)}**\n` +
        (names.length ? names.map((n, i) => `• FRC ${teams[i]} — ${n}`).join('\n') : 'No teams drafted.');
    }));

    await annChannel.send({ embeds: [
      new EmbedBuilder()
        .setTitle(`🏁 ${year} Fantasy Draft Complete — Full Rosters`)
        .setDescription(lines.join('\n\n'))
        .setColor(0x00AE86)
        .setFooter({ text: 'Weekly standings will be posted here as events conclude.' })
    ]});
  } catch (err) {
    console.error('postRosterAnnouncement error:', err);
  }
}

// Posts Week N standings to the guild's announcements channel.
// weekNum is 0-indexed (TBA's week field); displayed as "Week N+1".
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

  await annChannel.send({ embeds: [
    new EmbedBuilder()
      .setTitle(`📅 Week ${weekNum + 1} Standings`)
      .addFields(
        { name: `Week ${weekNum + 1} Event Results (drafted teams)`, value: weekLine || '*None*' },
        { name: 'Overall Fantasy Standings', value: standingsLine || '*No data yet*' }
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
      eventSections.push({ name: `📍 ${ev.name} (${weekLabel})`, value: teamLines.join('\n') });
    }

    if (!eventSections.length) continue;

    const embed = new EmbedBuilder()
      .setTitle('🔮 Live Event Predictions')
      .setDescription(
        'Statbotics EPA predictions for drafted teams at active events.\n' +
        '🏳️ = predicted alliance captain (rank ≤ 8)'
      )
      .addFields(eventSections)
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

// ---------------- DRAFT HELPERS ----------------
function getCurrentPlayer(data) {
  const n = data.draftOrder.length;
  const round = Math.floor(data.currentPick / n);
  const index = data.currentPick % n;
  return (round % 2 === 0) ? data.draftOrder[index] : data.draftOrder[n - 1 - index];
}

function findOwner(data, team) {
  for (const [player, teams] of Object.entries(data.teamsDrafted)) {
    if (teams.includes(team)) return player;
  }
  return null;
}

async function buildTeamBreakdown(teamNumber, scoreFn) {
  const teamName = await getTeamName(teamNumber);
  const score = await scoreFn(teamNumber);
  return `**FRC ${teamNumber} — ${teamName}**\nTotal: **${score} pts**`;
}

async function buildFantasyBreakdown(data, scoreFn, player) {
  const players = player === 'ALL' ? data.players : data.players.filter(p => p === player);
  const blocks = [];

  for (const p of players) {
    const teams = data.teamsDrafted[p] || [];
    const teamParts = await Promise.all(teams.map(async team => {
      const score = await scoreFn(team);
      const name = await getTeamName(team);
      return `- FRC ${team} — ${name}: **${score} pts**`;
    }));
    const total = teams.length ? (await Promise.all(teams.map(scoreFn))).reduce((a, b) => a + b, 0) : 0;
    blocks.push(`**${playerDisplay(p)}**\nTotal: **${total} pts**\n${teamParts.join('\n') || 'No teams drafted yet.'}`);
  }

  return blocks.join('\n\n');
}

// ---------------- CPU AUTO-PICK ----------------
// Called recursively until a human's turn or draft ends
async function doBotPick(data, channelId, channel, guildId) {
  if (data.phase === "finished" || data.phase === "worlds_finished") return;
  if (getCurrentPlayer(data) !== BOT_PLAYER_ID) return;

  const pool = data.phase === "worlds" ? data.worldsTeams : data.seasonTeams;
  const drafted = new Set(Object.values(data.teamsDrafted).flat());
  const available = pool.filter(t => !drafted.has(t));
  if (!available.length) return;

  const year = getYear(data);
  const scoreFn = data.phase === "worlds"
    ? t => getTeamWorldsScore(t, year)
    : t => getTeamSeasonScore(t, year);
  const scored = await Promise.all(available.map(async t => ({ team: t, score: await scoreFn(t) })));
  scored.sort((a, b) => b.score - a.score);
  const team = scored[0].team;
  data.teamsDrafted[BOT_PLAYER_ID].push(team);
  data.currentPick++;
  data.pickLog.push({ player: BOT_PLAYER_ID, team, pickIndex: data.currentPick - 1 });

  const name = await getTeamName(team);
  const maxPicks = data.players.length * 6;

  if (data.currentPick >= maxPicks) {
    data.phase = data.phase === "worlds" ? "worlds_finished" : "finished";
    saveData(data, channelId);
    await channel.send(`🤖 **CPU** picked **${name}**\n\n🏁 **Draft complete!** Run \`/standings\` to see the results!`);
    if (data.phase === "finished" && guildId) postRosterAnnouncement(data, guildId).catch(() => {});
    return;
  }

  saveData(data, channelId);
  const next = getCurrentPlayer(data);
  await channel.send(`🤖 **CPU** picked **${name}**\n\n👉 Next pick: ${playerDisplay(next)}`);

  // If it's still the bot's turn (consecutive picks in snake), keep going
  if (next === BOT_PLAYER_ID) {
    await new Promise(r => setTimeout(r, 1500)); // small delay so it doesn't feel instant
    await doBotPick(data, channelId, channel, guildId);
  }
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

  // Every 3 hours: update Statbotics prediction embed + catch any newly completed event weeks.
  // Running every 3 hours (instead of daily) also ensures midweek events (e.g. Turkey, Israel)
  // are picked up within hours of completion rather than waiting for the next morning.
  cron.schedule('0 */3 * * *', () => {
    checkAndPostPredictions().catch(err => console.error('Predictions cron error:', err));
    checkAndPostWeeklyUpdate().catch(err => console.error('Weekly update cron error:', err));
  });
});

// ---------------- GUILD JOIN — create announcements channel ----------------
client.on('guildCreate', async (guild) => {
  try {
    const config = loadGuildConfig(guild.id);
    if (config.announcementChannelId) return; // already set up

    const channel = await guild.channels.create({
      name: 'frc-fantasy-updates',
      type: ChannelType.GuildText,
      topic: 'FRC Fantasy Draft announcements and weekly standings — managed by the bot',
      permissionOverwrites: [
        {
          id: guild.roles.everyone,
          deny: [PermissionFlagsBits.SendMessages],
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]
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
      'A server admin should run `/setchannel` in whichever channel you want to use for draft commands.'
    );
  } catch (err) {
    console.error('guildCreate error:', err);
  }
});

// ---------------- COMMAND HANDLER ----------------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guildId) return interaction.reply({ content: "This bot only works inside a server.", ephemeral: true });

  const guildId = interaction.guildId;
  const channelId = interaction.channelId;
  const userId = interaction.user.id;

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
    if (interaction.commandName === 'setchannel') {
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
    if (interaction.commandName === 'draftstatus') {
      const setToOpen = interaction.options.getBoolean('open');
      if (data.players.length > 0 && !isAdmin(data, userId)) {
        return interaction.reply("❌ Only an admin can change draft status.");
      }
      const { REST, Routes } = require('discord.js');
      const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
      const { fullCommands, closedCommands } = require('./commands.js');
      if (setToOpen) {
        data.draftOpen = true;
        saveData(data, channelId);
        // Guild commands update instantly (vs global = up to 1 hour)
        await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId), { body: fullCommands });
        return interaction.reply("✅ **Draft is now OPEN**\nPlayers can now join using `/join_draft` or add a CPU with `/addbot`");
      } else {
        saveData(freshData(), channelId);
        await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId), { body: closedCommands });
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
    if (interaction.commandName === 'join_draft') {
      if (!data.draftOpen) return interaction.reply("❌ Draft joining is currently closed.\nAsk the host to run `/draftstatus open:true`");
      if (data.players.includes(userId)) return interaction.reply("You are already in the draft.");
      data.players.push(userId);
      if (!data.admins.length) data.admins.push(userId);
      saveData(data, channelId);
      return interaction.reply(`✅ <@${userId}> has joined the draft!`);
    }

    // ── ADD ADMIN ────────────────────────────────────────────────
    if (interaction.commandName === 'addadmin') {
      if (!isAdmin(data, userId)) return interaction.reply({ content: "❌ Only admins can promote others.", ephemeral: true });
      const target = interaction.options.getUser('user');
      if (data.admins.includes(target.id)) return interaction.reply({ content: `${target} is already an admin.`, ephemeral: true });
      data.admins.push(target.id);
      saveData(data, channelId);
      return interaction.reply(`✅ ${target} has been promoted to **admin**.`);
    }

    // ── ADD MANUAL PLAYER ───────────────────────────────────────────────
    if (interaction.commandName === 'addmanualplayer') {
      if (!isAdmin(data, userId)) return interaction.reply({ content: "❌ Only admins can add manual players.", ephemeral: true });
      if (!data.draftOpen) return interaction.reply({ content: "❌ Draft joining is currently closed.", ephemeral: true });
      const rawName = interaction.options.getString('name').trim();
      const mId = `MANUAL_${rawName}`;
      if (data.players.includes(mId)) return interaction.reply({ content: `❌ A player named "${rawName}" is already in the draft.`, ephemeral: true });
      data.players.push(mId);
      saveData(data, channelId);
      return interaction.reply(`👤 **${rawName}** has been added as a manual player!`);
    }

    // ── ADD BOT PLAYER ────────────────────────────────────────────
    if (interaction.commandName === 'addbot') {
      if (!data.draftOpen) return interaction.reply("❌ Draft joining is currently closed.");
      if (data.players.includes(BOT_PLAYER_ID)) return interaction.reply("🤖 CPU is already in the draft.");
      data.players.push(BOT_PLAYER_ID);
      saveData(data, channelId);
      return interaction.reply("🤖 **CPU player added to the draft!** It will auto-pick randomly when it's its turn.");
    }

    // ── START SEASON DRAFT ────────────────────────────────────────
    if (interaction.commandName === 'start_draft') {
      await interaction.deferReply();
      if (!data.players.length) return interaction.editReply("❌ No players have joined yet.");
      if (!isAdmin(data, userId)) return interaction.editReply("❌ Only an admin can start the draft.");

      data.phase = "season";
      data.seasonTeams = await loadSeasonTeams(getYear(data));
      data.draftOrder = [...data.players].sort(() => Math.random() - 0.5);
      data.currentPick = 0;
      data.teamsDrafted = Object.fromEntries(data.players.map(p => [p, []]));
      data.draftOpen = false;
      data.pendingTrade = null;
      saveData(data, channelId);

      const first = getCurrentPlayer(data);
      await interaction.editReply(
        `🚀 **Season Draft Started!**\nTeams loaded: ${data.seasonTeams.length}\nFirst pick: ${playerDisplay(first)}`
      );

      // If CPU goes first, auto-pick immediately
      if (first === BOT_PLAYER_ID) {
        await doBotPick(data, channelId, interaction.channel, guildId);
      }
      return;
    }

    // ── START WORLDS DRAFT ────────────────────────────────────────
    if (interaction.commandName === 'start_worlds_draft') {
      await interaction.deferReply();
      if (!data.players.length) return interaction.editReply("❌ No players have joined yet.");
      if (!isAdmin(data, userId)) return interaction.editReply("❌ Only an admin can start the draft.");

      await interaction.editReply("⏳ Calculating final season standings from TBA…");

      const year = getYear(data);
      const seasonStandings = await calcStandings(data, t => getTeamSeasonScore(t, year));
      data.lastSeasonStandings = seasonStandings.map(p => p.player);
      data.phase = "worlds";
      data.worldsTeams = await loadWorldsTeams(getYear(data));
      data.draftOrder = [...data.lastSeasonStandings].reverse();
      data.currentPick = 0;
      data.teamsDrafted = Object.fromEntries(data.players.map(p => [p, []]));
      data.draftOpen = false;
      data.pendingTrade = null;
      saveData(data, channelId);

      const medals = ['🥇', '🥈', '🥉'];
      const standingsText = seasonStandings
        .map((p, i) => `${medals[i] || `${i + 1}.`} ${playerDisplay(p.player)} — **${p.totalScore} pts**`)
        .join('\n');

      await interaction.editReply(
        `🌍 **Worlds Draft Started!**\n\n**Final Season Standings:**\n${standingsText}\n\n**Draft Order** (worst → best):\n${data.draftOrder.map(playerDisplay).join(' → ')}\n\nFirst pick: ${playerDisplay(data.draftOrder[0])}`
      );

      if (getCurrentPlayer(data) === BOT_PLAYER_ID) {
        await doBotPick(data, channelId, interaction.channel, guildId);
      }
      return;
    }

    // ── PICK TEAM ─────────────────────────────────────────────────
    if (interaction.commandName === 'pick') {
      const team = interaction.options.getInteger('team');
      const forUser = interaction.options.getUser('for');
      const actingAdmin = forUser && isAdmin(data, userId);
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
      const maxPicks = data.players.length * 6;

      const actor = actingAdmin ? `<@${userId}> → ${playerDisplay(pickerId)}` : `<@${userId}>`;
      if (data.currentPick >= maxPicks) {
        data.phase = data.phase === "worlds" ? "worlds_finished" : "finished";
        saveData(data, channelId);
        if (data.phase === "finished") postRosterAnnouncement(data, guildId).catch(() => {});
        return interaction.editReply(`✅ ${actor} picked **${name}**\n\n🏁 **Draft complete!** Run \`/standings\` to see the results!`);
      }

      saveData(data, channelId);
      const next = getCurrentPlayer(data);
      await interaction.editReply(`✅ ${actor} picked **${name}**\n\n👉 Next pick: ${playerDisplay(next)}`);

      // Trigger CPU auto-pick if it's now the bot's turn
      if (next === BOT_PLAYER_ID) {
        await doBotPick(data, channelId, interaction.channel, guildId);
      }
      return;
    }

    // ── MANUAL PICK ────────────────────────────────────────────────────────
    if (interaction.commandName === 'manualpick') {
      if (!isAdmin(data, userId)) return interaction.reply({ content: "❌ Only admins can pick for manual players.", ephemeral: true });
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
      const maxPicks = data.players.length * 6;

      if (data.currentPick >= maxPicks) {
        data.phase = data.phase === "worlds" ? "worlds_finished" : "finished";
        saveData(data, channelId);
        if (data.phase === "finished") postRosterAnnouncement(data, guildId).catch(() => {});
        return interaction.editReply(`✅ ${playerDisplay(current)} picked **${name}**\n\n🏁 **Draft complete!** Run \`/standings\` to see the results!`);
      }

      saveData(data, channelId);
      const next = getCurrentPlayer(data);
      await interaction.editReply(`✅ ${playerDisplay(current)} picked **${name}**\n\n👉 Next pick: ${playerDisplay(next)}`);

      if (next === BOT_PLAYER_ID) {
        await doBotPick(data, channelId, interaction.channel, guildId);
      }
      return;
    }

    // ── TRADE ─────────────────────────────────────────────────────
    if (interaction.commandName === 'trade') {
      const offering = interaction.options.getInteger('offer');
      const wanting  = interaction.options.getInteger('request');

      if (!data.players.includes(userId)) return interaction.reply({ content: "❌ You're not in this draft.", ephemeral: true });
      if (offering === wanting) return interaction.reply({ content: "❌ You can't trade a team for itself.", ephemeral: true });

      const myTeams = data.teamsDrafted[userId] || [];
      if (!myTeams.includes(offering)) return interaction.reply({ content: `❌ You don't own FRC ${offering}.`, ephemeral: true });

      const theirOwner = findOwner(data, wanting);
      if (!theirOwner) return interaction.reply({ content: `❌ FRC ${wanting} hasn't been drafted yet.`, ephemeral: true });
      if (theirOwner === userId) return interaction.reply({ content: "❌ You already own that team.", ephemeral: true });
      if (theirOwner === BOT_PLAYER_ID) return interaction.reply({ content: "❌ You can't trade with the CPU.", ephemeral: true });
      if (data.pendingTrade) return interaction.reply({ content: "❌ There's already a pending trade. It must be accepted, declined, or cancelled first.", ephemeral: true });

      data.pendingTrade = { from: userId, offering, wanting, to: theirOwner };
      saveData(data, channelId);

      const [offerName, wantName] = await Promise.all([getTeamName(offering), getTeamName(wanting)]);
      return interaction.reply({ embeds: [
        new EmbedBuilder()
          .setTitle("🔄 Trade Proposal")
          .setDescription(
            `<@${userId}> wants to trade with <@${theirOwner}>\n\n` +
            `**Offering:** ${offerName}\n` +
            `**Requesting:** ${wantName}\n\n` +
            `<@${theirOwner}>: run \`/accepttrade\` to accept or \`/declinetrade\` to decline.`
          )
          .setColor(0xF0A500)
      ]});
    }

    // ── ACCEPT TRADE ──────────────────────────────────────────────
    if (interaction.commandName === 'accepttrade') {
      const trade = data.pendingTrade;
      if (!trade) return interaction.reply({ content: "❌ There's no pending trade.", ephemeral: true });
      if (userId !== trade.to) return interaction.reply({ content: "❌ This trade isn't directed at you.", ephemeral: true });

      data.teamsDrafted[trade.from] = data.teamsDrafted[trade.from].filter(t => t !== trade.offering);
      data.teamsDrafted[trade.to]   = data.teamsDrafted[trade.to].filter(t => t !== trade.wanting);
      data.teamsDrafted[trade.from].push(trade.wanting);
      data.teamsDrafted[trade.to].push(trade.offering);
      data.pendingTrade = null;
      saveData(data, channelId);

      const [offerName, wantName] = await Promise.all([getTeamName(trade.offering), getTeamName(trade.wanting)]);
      return interaction.reply(
        `✅ **Trade accepted!**\n<@${trade.from}> receives **${wantName}**\n<@${trade.to}> receives **${offerName}**`
      );
    }

    // ── DECLINE TRADE ─────────────────────────────────────────────
    if (interaction.commandName === 'declinetrade') {
      const trade = data.pendingTrade;
      if (!trade) return interaction.reply({ content: "❌ There's no pending trade.", ephemeral: true });
      if (userId !== trade.to && userId !== trade.from) return interaction.reply({ content: "❌ You're not part of this trade.", ephemeral: true });
      data.pendingTrade = null;
      saveData(data, channelId);
      return interaction.reply("❌ Trade cancelled.");
    }

    // ── STANDINGS ─────────────────────────────────────────────────
    if (interaction.commandName === 'standings') {
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
    if (interaction.commandName === 'currentyear') {
      const y = getYear(data);
      const src = data.year ? "overridden by admin" : "default (current calendar year)";
      return interaction.reply(`📅 The bot is using **${y}** for TBA data (${src}).`);
    }

    if (interaction.commandName === 'setyear') {
      if (!isAdmin(data, userId)) return interaction.reply({ content: "❌ Only admins can set the year.", ephemeral: true });
      const y = interaction.options.getInteger('year');
      data.year = y;
      seasonTeamsCache = null;
      seasonTeamsCacheYear = null;
      saveData(data, channelId);
      return interaction.reply(`📅 Year set to **${y}**. Team cache cleared — next draft will load ${y} teams from TBA.`);
    }

    if (interaction.commandName === 'skip') {
      const current = getCurrentPlayer(data);
      if (userId !== current && !isAdmin(data, userId)) return interaction.reply({ content: "⛔ It's not your turn (or you are not an admin).", ephemeral: true });
      const pool = data.phase === "worlds" ? data.worldsTeams : data.seasonTeams;
      const drafted = new Set(Object.values(data.teamsDrafted).flat());
      const available = pool.filter(t => !drafted.has(t));
      if (!available.length) return interaction.reply({ content: "❌ No teams left in the pool.", ephemeral: true });

      await interaction.deferReply();
      const year = getYear(data);
      const scoreFn = data.phase === "worlds"
        ? t => getTeamWorldsScore(t, year)
        : t => getTeamSeasonScore(t, year);
      const scored = await Promise.all(available.map(async t => ({ team: t, score: await scoreFn(t) })));
      scored.sort((a, b) => b.score - a.score);
      const team = scored[0].team;

      data.teamsDrafted[current].push(team);
      data.currentPick++;
      data.pickLog.push({ player: current, team, pickIndex: data.currentPick - 1 });

      const name = await getTeamName(team);
      const maxPicks = data.players.length * 6;

      if (data.currentPick >= maxPicks) {
        data.phase = data.phase === "worlds" ? "worlds_finished" : "finished";
        saveData(data, channelId);
        if (data.phase === "finished") postRosterAnnouncement(data, guildId).catch(() => {});
        return interaction.editReply(`⚡ ${playerDisplay(current)} skipped and picked **${name}**\n\n🏁 **Draft complete!**`);
      }

      saveData(data, channelId);
      const next = getCurrentPlayer(data);
      await interaction.editReply(`⚡ ${playerDisplay(current)} skipped and picked **${name}**\n\n👉 Next pick: ${playerDisplay(next)}`);

      if (next === BOT_PLAYER_ID) {
        await doBotPick(data, channelId, interaction.channel, guildId);
      }
      return;
    }

    // ── SCORE BREAKDOWN ───────────────────────────────────────────
    if (interaction.commandName === 'score') {
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

    if (interaction.commandName === 'breakdown') {
      await interaction.deferReply();
      const target = interaction.options.getString('player').trim();
      const playerIds = target === 'ALL' ? data.players : data.players.filter(p => p === target);

      if (!playerIds.length) return interaction.editReply("No matching fantasy player found.");

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
    if (interaction.commandName === 'undraft') {
      if (!isAdmin(data, userId)) return interaction.reply({ content: "❌ Only an admin can undraft.", ephemeral: true });
      if (!data.pickLog?.length) return interaction.reply({ content: "❌ No picks have been made yet.", ephemeral: true });

      const targetTeam = interaction.options.getInteger('team');
      let entry;

      if (targetTeam != null) {
        entry = data.pickLog.slice().reverse().find(p => p.team === targetTeam);
        if (!entry) return interaction.reply({ content: `❌ Team ${targetTeam} was never picked.`, ephemeral: true });
      } else {
        entry = data.pickLog[data.pickLog.length - 1];
      }

      data.teamsDrafted[entry.player] = data.teamsDrafted[entry.player].filter(t => t !== entry.team);
      data.pickLog = data.pickLog.filter(p => p.pickIndex !== entry.pickIndex);
      data.currentPick = entry.pickIndex;
      if (data.phase === "finished") data.phase = data.seasonTeams.length ? "season" : "worlds";
      if (data.phase === "worlds_finished") data.phase = "worlds";
      saveData(data, channelId);

      const name = await getTeamName(entry.team);
      const current = getCurrentPlayer(data);
      return interaction.reply(`⏪ Undrafted **${name}** (was pick #${entry.pickIndex + 1} by ${playerDisplay(entry.player)})\n\n👉 Current pick: ${playerDisplay(current)}`);
    }

    // ── PODIUM ───────────────────────────────────────────────────────
    if (interaction.commandName === 'podium') {
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
      } else if (data.players.includes(BOT_PLAYER_ID) && userId !== BOT_PLAYER_ID) {
        desc += "\n👤 You are not in this draft.";
      }

      return interaction.editReply({ embeds: [
        new EmbedBuilder().setTitle("🏆 Fantasy Podium").setDescription(desc).setColor(0xFFD700)
      ]});
    }

    // ── EXPORT CSV ────────────────────────────────────────────────
    if (interaction.commandName === 'exportcsv') {
      await interaction.deferReply({ ephemeral: true });
      if (!data.players.length) return interaction.editReply("No players in the draft yet.");

      const year = getYear(data);
      const n = data.draftOrder.length || data.players.length;

      // ── FILE 1: picks_YYYY.csv ──────────────────────────────────────────────
      // One row per pick in draft order. Calculates round + position from pickIndex.
      const pickRows = [['Overall Pick', 'Round', 'Round Pick', 'Player', 'Team Number', 'Team Name', 'Is CPU']];
      const sortedLog = [...(data.pickLog || [])].sort((a, b) => a.pickIndex - b.pickIndex);
      const pickNames = await Promise.all(sortedLog.map(e => getTeamName(e.team)));
      for (let i = 0; i < sortedLog.length; i++) {
        const entry = sortedLog[i];
        const round = n > 0 ? Math.floor(entry.pickIndex / n) + 1 : '?';
        const posInRound = n > 0 ? (entry.pickIndex % n) + 1 : '?';
        pickRows.push([
          entry.pickIndex + 1,
          round,
          posInRound,
          playerName(entry.player),
          entry.team,
          pickNames[i],
          entry.player === BOT_PLAYER_ID ? 'Yes' : 'No'
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

      let rank = 1;
      for (const { player, teams, breakdowns, playerTotal } of playerBreakdowns) {
        if (!teams.length) {
          standingRows.push([rank, playerName(player), 0, '', 'No teams drafted', '', '', '', '', '', '']);
          rank++;
          continue;
        }
        for (let i = 0; i < teams.length; i++) {
          const b = breakdowns[i];
          const ev1 = b.events[0];
          const ev2 = b.events[1];
          standingRows.push([
            i === 0 ? rank : '',                           // rank only on first row per player
            i === 0 ? playerName(player) : '',             // name only on first row per player
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
    if (interaction.commandName === 'roster') {
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
    if (interaction.commandName === 'teams') {
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
    if (interaction.commandName === 'team') {
      await interaction.deferReply();
      const search = interaction.options.getString('name').toLowerCase();
      const allTeams = await loadSeasonTeams();
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
    if (interaction.commandName === 'team_identify') {
      await interaction.deferReply();
      return interaction.editReply(`🔍 **${await getTeamName(interaction.options.getInteger('number'))}**`);
    }

    // ── RESET DRAFT ───────────────────────────────────────────────
    if (interaction.commandName === 'reset_draft') {
      if (interaction.options.getString('confirm') !== "RESET") return interaction.reply("Type `RESET` to confirm.");
      if (!isAdmin(data, userId)) return interaction.reply("❌ Only an admin can reset.");
      saveData(freshData(), channelId);
      return interaction.reply("🧹 Draft fully reset.");
    }

  } catch (err) {
    console.error(err);
    if (interaction.deferred) interaction.editReply("❌ An error occurred.").catch(() => {});
    else if (!interaction.replied) interaction.reply("❌ An error occurred.").catch(() => {});
    // Send alert to the guild's announcements channel so the admin is notified
    sendBotAlert(guildId,
      `Command Error: \`/${interaction.commandName}\``,
      `An error occurred while handling this command.\n\`\`\`${String(err?.message || err).slice(0, 800)}\`\`\``
    ).catch(() => {});
  }
});

client.login(process.env.TOKEN);
