require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder
} = require('discord.js');

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
    pickLog: []
  };
}

function loadData(guildId) {
  try {
    const d = JSON.parse(fs.readFileSync(`./data_${guildId}.json`));
    if (!d.pendingTrade) d.pendingTrade = null;
    return d;
  } catch {
    return freshData();
  }
}

function saveData(data, guildId) {
  fs.writeFileSync(`./data_${guildId}.json`, JSON.stringify(data, null, 2));
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
const CURRENT_YEAR = new Date().getFullYear();

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

async function loadSeasonTeams() {
  if (seasonTeamsCache) return seasonTeamsCache;
  const allTeams = [];
  let page = 0;
  while (true) {
    const teams = await safeFetch(`https://www.thebluealliance.com/api/v3/teams/${CURRENT_YEAR}/${page}`, TBA);
    if (!teams || teams.length === 0) break;
    allTeams.push(...teams.map(t => t.team_number));
    page++;
  }
  seasonTeamsCache = allTeams;
  return allTeams;
}

async function loadWorldsTeams() {
  const [events, allTeams] = await Promise.all([
    safeFetch(`https://www.thebluealliance.com/api/v3/events/${CURRENT_YEAR}`, TBA),
    loadSeasonTeams()
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
  return id === BOT_PLAYER_ID ? "🤖 **CPU**" : `<@${id}>`;
}

// ---------------- SCORING ----------------
async function getTeamSeasonScore(teamNumber) {
  const events = await safeFetch(`https://www.thebluealliance.com/api/v3/team/frc${teamNumber}/events/${CURRENT_YEAR}`, TBA);
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

async function getTeamWorldsScore(teamNumber) {
  const events = await safeFetch(`https://www.thebluealliance.com/api/v3/team/frc${teamNumber}/events/${CURRENT_YEAR}`, TBA);
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
async function doBotPick(data, guildId, channel) {
  if (data.phase === "finished" || data.phase === "worlds_finished") return;
  if (getCurrentPlayer(data) !== BOT_PLAYER_ID) return;

  const pool = data.phase === "worlds" ? data.worldsTeams : data.seasonTeams;
  const drafted = new Set(Object.values(data.teamsDrafted).flat());
  const available = pool.filter(t => !drafted.has(t));
  if (!available.length) return;

  // Score all available teams and pick the highest-scoring one
  const scoreFn = data.phase === "worlds" ? getTeamWorldsScore : getTeamSeasonScore;
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
    saveData(data, guildId);
    await channel.send(`🤖 **CPU** picked **${name}**\n\n🏁 **Draft complete!** Run \`/standings\` to see the results!`);
    return;
  }

  saveData(data, guildId);
  const next = getCurrentPlayer(data);
  await channel.send(`🤖 **CPU** picked **${name}**\n\n👉 Next pick: ${playerDisplay(next)}`);

  // If it's still the bot's turn (consecutive picks in snake), keep going
  if (next === BOT_PLAYER_ID) {
    await new Promise(r => setTimeout(r, 1500)); // small delay so it doesn't feel instant
    await doBotPick(data, guildId, channel);
  }
}

// ---------------- GLOBAL ERROR SAFETY ----------------
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (bot kept alive):', err);
});

// ---------------- READY ----------------
client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// ---------------- COMMAND HANDLER ----------------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guildId) return interaction.reply({ content: "This bot only works inside a server.", ephemeral: true });

  const guildId = interaction.guildId;
  const data = loadData(guildId);
  const userId = interaction.user.id;

  try {

    // ── DRAFT STATUS ──────────────────────────────────────────────
    if (interaction.commandName === 'draftstatus') {
      const setToOpen = interaction.options.getBoolean('open');
      if (data.players.length > 0 && userId !== data.players[0]) {
        return interaction.reply("❌ Only the draft host can change draft status.");
      }
      const { REST, Routes } = require('discord.js');
      const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
      const { fullCommands, closedCommands } = require('./commands.js');
      if (setToOpen) {
        data.draftOpen = true;
        saveData(data, guildId);
        // Guild commands update instantly (vs global = up to 1 hour)
        await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId), { body: fullCommands });
        return interaction.reply("✅ **Draft is now OPEN**\nPlayers can now join using `/join_draft` or add a CPU with `/addbot`");
      } else {
        saveData(freshData(), guildId);
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
      saveData(data, guildId);
      return interaction.reply(`✅ <@${userId}> has joined the draft!`);
    }

    // ── ADD BOT PLAYER ────────────────────────────────────────────
    if (interaction.commandName === 'addbot') {
      if (!data.draftOpen) return interaction.reply("❌ Draft joining is currently closed.");
      if (data.players.includes(BOT_PLAYER_ID)) return interaction.reply("🤖 CPU is already in the draft.");
      data.players.push(BOT_PLAYER_ID);
      saveData(data, guildId);
      return interaction.reply("🤖 **CPU player added to the draft!** It will auto-pick randomly when it's its turn.");
    }

    // ── START SEASON DRAFT ────────────────────────────────────────
    if (interaction.commandName === 'start_draft') {
      await interaction.deferReply();
      if (!data.players.length) return interaction.editReply("❌ No players have joined yet.");
      if (userId !== data.players[0]) return interaction.editReply("❌ Only the host can start the draft.");

      data.phase = "season";
      data.seasonTeams = await loadSeasonTeams();
      data.draftOrder = [...data.players].sort(() => Math.random() - 0.5);
      data.currentPick = 0;
      data.teamsDrafted = Object.fromEntries(data.players.map(p => [p, []]));
      data.draftOpen = false;
      data.pendingTrade = null;
      saveData(data, guildId);

      const first = getCurrentPlayer(data);
      await interaction.editReply(
        `🚀 **Season Draft Started!**\nTeams loaded: ${data.seasonTeams.length}\nFirst pick: ${playerDisplay(first)}`
      );

      // If CPU goes first, auto-pick immediately
      if (first === BOT_PLAYER_ID) {
        await doBotPick(data, guildId, interaction.channel);
      }
      return;
    }

    // ── START WORLDS DRAFT ────────────────────────────────────────
    if (interaction.commandName === 'start_worlds_draft') {
      await interaction.deferReply();
      if (!data.players.length) return interaction.editReply("❌ No players have joined yet.");
      if (userId !== data.players[0]) return interaction.editReply("❌ Only the host can start the draft.");

      await interaction.editReply("⏳ Calculating final season standings from TBA…");

      const seasonStandings = await calcStandings(data, getTeamSeasonScore);
      data.lastSeasonStandings = seasonStandings.map(p => p.player);
      data.phase = "worlds";
      data.worldsTeams = await loadWorldsTeams();
      data.draftOrder = [...data.lastSeasonStandings].reverse();
      data.currentPick = 0;
      data.teamsDrafted = Object.fromEntries(data.players.map(p => [p, []]));
      data.draftOpen = false;
      data.pendingTrade = null;
      saveData(data, guildId);

      const medals = ['🥇', '🥈', '🥉'];
      const standingsText = seasonStandings
        .map((p, i) => `${medals[i] || `${i + 1}.`} ${playerDisplay(p.player)} — **${p.totalScore} pts**`)
        .join('\n');

      await interaction.editReply(
        `🌍 **Worlds Draft Started!**\n\n**Final Season Standings:**\n${standingsText}\n\n**Draft Order** (worst → best):\n${data.draftOrder.map(playerDisplay).join(' → ')}\n\nFirst pick: ${playerDisplay(data.draftOrder[0])}`
      );

      if (getCurrentPlayer(data) === BOT_PLAYER_ID) {
        await doBotPick(data, guildId, interaction.channel);
      }
      return;
    }

    // ── PICK TEAM ─────────────────────────────────────────────────
    if (interaction.commandName === 'pick') {
      const team = interaction.options.getInteger('team');
      const current = getCurrentPlayer(data);

      if (userId !== current) return interaction.reply({ content: "⛔ It's not your turn.", ephemeral: true });
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
        saveData(data, guildId);
        return interaction.editReply(`✅ <@${userId}> picked **${name}**\n\n🏁 **Draft complete!** Run \`/standings\` to see the results!`);
      }

      saveData(data, guildId);
      const next = getCurrentPlayer(data);
      await interaction.editReply(`✅ <@${userId}> picked **${name}**\n\n👉 Next pick: ${playerDisplay(next)}`);

      // Trigger CPU auto-pick if it's now the bot's turn
      if (next === BOT_PLAYER_ID) {
        await doBotPick(data, guildId, interaction.channel);
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
      saveData(data, guildId);

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
      saveData(data, guildId);

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
      saveData(data, guildId);
      return interaction.reply("❌ Trade cancelled.");
    }

    // ── STANDINGS ─────────────────────────────────────────────────
    if (interaction.commandName === 'standings') {
      await interaction.deferReply();
      if (!data.players.length) return interaction.editReply("No players in the draft yet.");
      if (data.phase === "none") return interaction.editReply("The draft hasn't started yet.");

      const isWorlds = data.phase === "worlds" || data.phase === "worlds_finished";
      const scoreFn  = isWorlds ? getTeamWorldsScore : getTeamSeasonScore;
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
      return interaction.reply(`📅 The bot is currently using **${CURRENT_YEAR}** as the FRC season year.\nAll team lists, events, and scores are pulled from the ${CURRENT_YEAR} TBA database.`);
    }

    // ── SCORE BREAKDOWN ───────────────────────────────────────────
    if (interaction.commandName === 'score') {
      await interaction.deferReply();
      const teamNumber = interaction.options.getInteger('team');

      const [teamName, events] = await Promise.all([
        getTeamName(teamNumber),
        safeFetch(`https://www.thebluealliance.com/api/v3/team/frc${teamNumber}/events/${CURRENT_YEAR}`, TBA)
      ]);

      if (!events?.length) return interaction.editReply(`No ${CURRENT_YEAR} events found for FRC ${teamNumber}.`);

      const regularEvents = events
        .filter(e => e.event_type === 0 || e.event_type === 1)
        .sort((a, b) => new Date(a.start_date) - new Date(b.start_date))
        .slice(0, 2);

      if (!regularEvents.length) return interaction.editReply(`No regular season events found for **${teamName}** in ${CURRENT_YEAR}.`);

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

      const scoreFn = data.phase === "worlds" || data.phase === "worlds_finished" ? getTeamWorldsScore : getTeamSeasonScore;
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
      if (data.players.length && userId !== data.players[0]) return interaction.reply({ content: "❌ Only the host can undraft.", ephemeral: true });
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
      saveData(data, guildId);

      const name = await getTeamName(entry.team);
      const current = getCurrentPlayer(data);
      return interaction.reply(`⏪ Undrafted **${name}** (was pick #${entry.pickIndex + 1} by ${playerDisplay(entry.player)})\n\n👉 Current pick: ${playerDisplay(current)}`);
    }

    // ── PODIUM ───────────────────────────────────────────────────────
    if (interaction.commandName === 'podium') {
      if (!data.players.length) return interaction.reply("No players in the draft yet.");
      await interaction.deferReply();

      const scoreFn = data.phase === "worlds" || data.phase === "worlds_finished" ? getTeamWorldsScore : getTeamSeasonScore;
      const medals = ['🥇', '🥈', '🥉'];

      const blocks = await Promise.all(data.players.map(async player => {
        const teams = data.teamsDrafted[player] || [];
        const scored = await Promise.all(teams.map(async t => ({ team: t, score: await scoreFn(t) })));
        scored.sort((a, b) => b.score - a.score);
        const top3 = scored.slice(0, 3);

        const draftPos = data.draftOrder.indexOf(player) + 1;
        const posLabel = draftPos ? `Draft position: **#${draftPos}**` : "Draft position: unknown";

        const lines = await Promise.all(top3.map(async (s, i) => {
          const name = await getTeamName(s.team);
          return `${medals[i] || '⭐'} **${name}** — ${s.score} pts`;
        }));

        return `**${playerDisplay(player)}** (${posLabel})\n${lines.join('\n') || 'No teams drafted yet.'}`;
      }));

      return interaction.editReply({ embeds: [
        new EmbedBuilder().setTitle("🏆 Fantasy Podium — Top 3 Teams Per Player").setDescription(blocks.join('\n\n')).setColor(0xFFD700)
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
      if (data.players.length && userId !== data.players[0]) return interaction.reply("❌ Only the host can reset.");
      saveData(freshData(), guildId);
      return interaction.reply("🧹 Draft fully reset.");
    }

  } catch (err) {
    console.error(err);
    if (interaction.deferred) interaction.editReply("❌ An error occurred.").catch(() => {});
    else if (!interaction.replied) interaction.reply("❌ An error occurred.").catch(() => {});
  }
});

client.login(process.env.TOKEN);
