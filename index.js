require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder
} = require('discord.js');

const fs = require('fs');

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// ---------------- DATA ----------------
function loadData() {
  try {
    return JSON.parse(fs.readFileSync('./data.json'));
  } catch (err) {
    return {
      players: [],
      draftOrder: [],
      teamsDrafted: {},
      currentPick: 0,
      phase: "none",
      draftOpen: false,
      lastSeasonStandings: [],
      worldsTeams: [],
      seasonTeams: []
    };
  }
}

function saveData(data) {
  fs.writeFileSync('./data.json', JSON.stringify(data, null, 2));
}

// ---------------- SAFE FETCH ----------------
async function safeFetch(url, options = {}) {
  try {
    const res = await fetch(url, options);
    if (res.status === 404) return null;
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error(`Fetch error: ${url}`);
    return null;
  }
}

// ---------------- TBA HELPERS ----------------
async function getTeamName(teamNumber) {
  try {
    const res = await fetch(
      `https://www.thebluealliance.com/api/v3/team/frc${teamNumber}`,
      { headers: { 'X-TBA-Auth-Key': process.env.TBA_KEY } }
    );
    if (!res.ok) return `Team ${teamNumber}`;
    const data = await res.json();
    return `${data.nickname || 'Unknown'} (FRC ${teamNumber})`;
  } catch (err) {
    return `Team ${teamNumber}`;
  }
}

async function loadSeasonTeams() {
  const allTeams = [];
  let page = 0;
  while (true) {
    const teams = await safeFetch(
      `https://www.thebluealliance.com/api/v3/teams/2026/${page}`,
      { headers: { 'X-TBA-Auth-Key': process.env.TBA_KEY } }
    );
    if (!teams || teams.length === 0) break;
    allTeams.push(...teams.map(t => t.team_number));
    page++;
  }
  return allTeams;
}

async function loadWorldsTeams() {
  const teams = await safeFetch(
    'https://www.thebluealliance.com/api/v3/event/2026cmptx/teams',
    { headers: { 'X-TBA-Auth-Key': process.env.TBA_KEY } }
  );
  return teams?.map(t => t.team_number) || [];
}

// ---------------- SCORING ----------------

// Season: points from first 2 regular-season events (regional or district, type 0 or 1).
// If only 1 event has data, double it.
async function getTeamSeasonScore(teamNumber) {
  const tbaHeaders = { headers: { 'X-TBA-Auth-Key': process.env.TBA_KEY } };
  const events = await safeFetch(
    `https://www.thebluealliance.com/api/v3/team/frc${teamNumber}/events/2026`,
    tbaHeaders
  );
  if (!events || events.length === 0) return 0;

  // Keep only Regional (0) and District (1) events, sorted by start date
  const regularEvents = events
    .filter(e => e.event_type === 0 || e.event_type === 1)
    .sort((a, b) => new Date(a.start_date) - new Date(b.start_date))
    .slice(0, 2);

  if (regularEvents.length === 0) return 0;

  let total = 0;
  let counted = 0;
  for (const ev of regularEvents) {
    const dp = await safeFetch(
      `https://www.thebluealliance.com/api/v3/event/${ev.key}/district_points`,
      tbaHeaders
    );
    const pts = dp?.points?.[`frc${teamNumber}`]?.total;
    if (pts != null) {
      total += pts;
      counted++;
    }
  }

  // Only 1 event played (or only 1 has results yet) — double the points
  if (counted === 1) total *= 2;

  return total;
}

// Worlds: points from Championship Division events (type 3) and Finals (type 4).
async function getTeamWorldsScore(teamNumber) {
  const tbaHeaders = { headers: { 'X-TBA-Auth-Key': process.env.TBA_KEY } };
  const events = await safeFetch(
    `https://www.thebluealliance.com/api/v3/team/frc${teamNumber}/events/2026`,
    tbaHeaders
  );
  if (!events || events.length === 0) return 0;

  const cmpEvents = events.filter(e => e.event_type === 3 || e.event_type === 4);

  let total = 0;
  for (const ev of cmpEvents) {
    const dp = await safeFetch(
      `https://www.thebluealliance.com/api/v3/event/${ev.key}/district_points`,
      tbaHeaders
    );
    const pts = dp?.points?.[`frc${teamNumber}`]?.total;
    if (pts != null) total += pts;
  }
  return total;
}

// Calculate all player scores and return sorted array (highest first)
async function calcStandings(data, scoreFn) {
  const playerScores = [];
  for (const player of data.players) {
    const teams = data.teamsDrafted[player] || [];
    let totalScore = 0;
    for (const team of teams) {
      totalScore += await scoreFn(team);
    }
    playerScores.push({ player, totalScore });
  }
  playerScores.sort((a, b) => b.totalScore - a.totalScore);
  return playerScores;
}

// ---------------- DRAFT HELPERS ----------------
function getCurrentPlayer(data) {
  const n = data.draftOrder.length;
  const round = Math.floor(data.currentPick / n);
  const index = data.currentPick % n;
  return (round % 2 === 0) ? data.draftOrder[index] : data.draftOrder[n - 1 - index];
}

// ---------------- GLOBAL ERROR SAFETY ----------------
// Prevent a single bad interaction from crashing the entire bot process
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

  const data = loadData();
  const userId = interaction.user.id;

  try {

    // ── DRAFT STATUS ──────────────────────────────────────────────
    if (interaction.commandName === 'draftstatus') {
      const setToOpen = interaction.options.getBoolean('open');

      if (data.players.length > 0 && userId !== data.players[0]) {
        return interaction.reply("❌ Only the draft host can change draft status.");
      }

      if (setToOpen === true) {
        data.draftOpen = true;
        saveData(data);
        return interaction.reply("✅ **Draft is now OPEN**\nPlayers can now join using `/join_draft`");
      } else {
        const freshData = {
          players: [],
          draftOrder: [],
          teamsDrafted: {},
          currentPick: 0,
          phase: "none",
          draftOpen: false,
          lastSeasonStandings: [],
          worldsTeams: [],
          seasonTeams: []
        };
        saveData(freshData);
        return interaction.reply("🛑 **Draft has been CLOSED and RESET**");
      }
    }

    // ── JOIN DRAFT ────────────────────────────────────────────────
    if (interaction.commandName === 'join_draft') {
      if (!data.draftOpen) {
        return interaction.reply("❌ Draft joining is currently closed.\nAsk the host to run `/draftstatus open:true`");
      }
      if (!data.players.includes(userId)) {
        data.players.push(userId);
        saveData(data);
        return interaction.reply(`✅ <@${userId}> has joined the draft!`);
      }
      return interaction.reply("You are already in the draft.");
    }

    // ── START SEASON DRAFT ────────────────────────────────────────
    if (interaction.commandName === 'start_draft') {
      await interaction.deferReply();

      if (data.players.length === 0) return interaction.editReply("❌ No players have joined yet.");
      if (userId !== data.players[0]) return interaction.editReply("❌ Only the host can start the draft.");

      data.phase = "season";
      data.seasonTeams = await loadSeasonTeams();
      data.draftOrder = [...data.players].sort(() => Math.random() - 0.5);
      data.currentPick = 0;
      data.teamsDrafted = Object.fromEntries(data.players.map(p => [p, []]));
      data.draftOpen = false;
      saveData(data);

      const first = getCurrentPlayer(data);
      return interaction.editReply(
        `🚀 **Season Draft Started!**\nTeams loaded: ${data.seasonTeams.length}\nFirst pick: <@${first}>`
      );
    }

    // ── START WORLDS DRAFT ────────────────────────────────────────
    // Calculates final season standings live, then reverses them for draft order
    if (interaction.commandName === 'start_worlds_draft') {
      await interaction.deferReply();

      if (data.players.length === 0) return interaction.editReply("❌ No players have joined yet.");
      if (userId !== data.players[0]) return interaction.editReply("❌ Only the host can start the draft.");

      await interaction.editReply("⏳ Calculating final season standings from TBA… this may take a moment.");

      const seasonStandings = await calcStandings(data, getTeamSeasonScore);
      // Store best→worst; draft order will reverse it (worst picks first)
      data.lastSeasonStandings = seasonStandings.map(p => p.player);

      data.phase = "worlds";
      data.worldsTeams = await loadWorldsTeams();
      data.draftOrder = [...data.lastSeasonStandings].reverse(); // worst to best picks first
      data.currentPick = 0;
      data.teamsDrafted = Object.fromEntries(data.players.map(p => [p, []]));
      data.draftOpen = false;
      saveData(data);

      const medals = ['🥇', '🥈', '🥉'];
      const standingsText = seasonStandings
        .map((p, i) => `${medals[i] || `${i + 1}.`} <@${p.player}> — **${p.totalScore} pts**`)
        .join('\n');

      const draftOrderText = data.draftOrder.map(p => `<@${p}>`).join(' → ');

      return interaction.editReply(
        `🌍 **Worlds Draft Started!**\n\n**Final Season Standings:**\n${standingsText}\n\n**Worlds Draft Order** (worst → best):\n${draftOrderText}\n\nFirst pick: <@${data.draftOrder[0]}>`
      );
    }

    // ── PICK TEAM ─────────────────────────────────────────────────
    if (interaction.commandName === 'pick') {
      const team = interaction.options.getInteger('team');
      const current = getCurrentPlayer(data);

      // Validate synchronously before deferring so errors are fast
      if (userId !== current) return interaction.reply({ content: "⛔ It's not your turn.", ephemeral: true });

      const pool = data.phase === "worlds" ? data.worldsTeams : data.seasonTeams;
      if (!pool.includes(team)) return interaction.reply({ content: `⛔ Team ${team} is not in the pool.`, ephemeral: true });

      for (const picks of Object.values(data.teamsDrafted)) {
        if (picks.includes(team)) return interaction.reply({ content: `⛔ Team ${team} has already been drafted.`, ephemeral: true });
      }

      // Defer now — getTeamName is a network call that can exceed 3s
      await interaction.deferReply();

      data.teamsDrafted[current].push(team);
      data.currentPick++;

      const name = await getTeamName(team);
      const maxPicks = data.players.length * 6;

      if (data.currentPick >= maxPicks) {
        data.phase = data.phase === "worlds" ? "worlds_finished" : "finished";
        saveData(data);
        return interaction.editReply(`🏁 **Draft complete!**\n✅ <@${userId}> picked **${name}**\n\nRun \`/standings\` to see the final results!`);
      }

      const next = getCurrentPlayer(data);
      saveData(data);
      return interaction.editReply(`✅ <@${userId}> picked **${name}**\n\n👉 Next pick: <@${next}>`);
    }

    // ── STANDINGS ─────────────────────────────────────────────────
    if (interaction.commandName === 'standings') {
      await interaction.deferReply();

      if (data.players.length === 0) return interaction.editReply("No players in the draft yet.");
      if (data.phase === "none") return interaction.editReply("The draft hasn't started yet.");

      // "worlds" or "worlds_finished" = worlds scoring; everything else = season scoring
      const isWorlds = data.phase === "worlds" || data.phase === "worlds_finished";
      const scoreFn = isWorlds ? getTeamWorldsScore : getTeamSeasonScore;
      const phaseLabel = isWorlds ? "Worlds" : "Season";

      const playerScores = await calcStandings(data, scoreFn);
      const medals = ['🥇', '🥈', '🥉'];

      let desc = "";
      for (let i = 0; i < playerScores.length; i++) {
        const { player, totalScore } = playerScores[i];
        const teams = data.teamsDrafted[player] || [];
        const medal = medals[i] || `**${i + 1}.**`;
        desc += `${medal} <@${player}> — **${totalScore} pts**\n`;
        if (teams.length > 0) {
          desc += `Teams: ${teams.map(t => `FRC ${t}`).join(', ')}\n`;
        } else {
          desc += `No teams drafted yet.\n`;
        }
        desc += "\n";
      }

      const embed = new EmbedBuilder()
        .setTitle(`📊 Fantasy Standings — ${phaseLabel}`)
        .setDescription(desc)
        .setColor(0x00AE86)
        .setFooter({ text: isWorlds
          ? "Points: Championship division ranking, playoff, and award points via TBA"
          : "Points: First 2 event district/regional points via TBA (1 event = doubled)"
        });

      return interaction.editReply({ embeds: [embed] });
    }

    // ── SHOW ALL FANTASY TEAMS ────────────────────────────────────
    if (interaction.commandName === 'teams') {
      if (data.players.length === 0) return interaction.reply("No players in the draft yet.");

      const embed = new EmbedBuilder().setTitle("Fantasy Draft Teams").setColor(0x00AE86);
      let desc = "";

      for (const player of data.players) {
        const owned = data.teamsDrafted[player] || [];
        desc += `**<@${player}>** (${owned.length} teams)\n`;
        if (owned.length > 0) {
          for (const t of owned) {
            desc += `• ${await getTeamName(t)}\n`;
          }
        } else {
          desc += "No teams drafted yet.\n";
        }
        desc += "\n";
      }

      embed.setDescription(desc);
      return interaction.reply({ embeds: [embed] });
    }

    // ── SEARCH TEAM BY NAME ───────────────────────────────────────
    if (interaction.commandName === 'team') {
      await interaction.deferReply();
      const search = interaction.options.getString('name').toLowerCase();

      const allTeams = await loadSeasonTeams();
      const matches = [];

      for (const num of allTeams) {
        const name = await getTeamName(num);
        if (name.toLowerCase().includes(search)) {
          matches.push(name);
          if (matches.length >= 15) break;
        }
      }

      if (matches.length === 0) return interaction.editReply(`No teams found for "${search}".`);

      const embed = new EmbedBuilder()
        .setTitle(`Teams matching "${search}"`)
        .setDescription(matches.join('\n'))
        .setColor(0x00AE86);

      return interaction.editReply({ embeds: [embed] });
    }

    // ── IDENTIFY TEAM BY NUMBER ───────────────────────────────────
    if (interaction.commandName === 'team_identify') {
      await interaction.deferReply();
      const number = interaction.options.getInteger('number');
      const name = await getTeamName(number);
      return interaction.editReply(`🔍 **${name}**`);
    }

    // ── RESET DRAFT (backup) ──────────────────────────────────────
    if (interaction.commandName === 'reset_draft') {
      const confirm = interaction.options.getString('confirm');
      if (confirm !== "RESET") return interaction.reply("Type `RESET` to confirm.");
      if (data.players.length && userId !== data.players[0]) {
        return interaction.reply("❌ Only the host can reset.");
      }

      const freshData = {
        players: [], draftOrder: [], teamsDrafted: {}, currentPick: 0,
        phase: "none", draftOpen: false, lastSeasonStandings: [], worldsTeams: [], seasonTeams: []
      };
      saveData(freshData);
      return interaction.reply("🧹 Draft fully reset.");
    }

  } catch (err) {
    console.error(err);
    if (interaction.deferred) interaction.editReply("❌ An error occurred.").catch(() => {});
    else if (!interaction.replied) interaction.reply("❌ An error occurred.").catch(() => {});
  }
});

client.login(process.env.TOKEN);
