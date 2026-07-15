require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

// Commands are grouped into a small set of top-level slash commands with
// subcommands, e.g. `/draft status`, `/draft join`, `/pick team`, etc.
// This keeps Discord's command list short while still being discoverable —
// typing `/draft` shows every draft-related action as an autocomplete option.
const fullCommands = [
  new SlashCommandBuilder()
    .setName('draft')
    .setDescription('Draft setup, lifecycle, and admin controls')
    .addSubcommand(sub => sub
      .setName('status')
      .setDescription('Open or close + reset the draft')
      .addBooleanOption(opt => opt.setName('open').setDescription('true = open for joining | false = close and reset').setRequired(true)))
    .addSubcommand(sub => sub
      .setName('join')
      .setDescription('Join the fantasy draft'))
    .addSubcommand(sub => sub
      .setName('addbot')
      .setDescription('Add a CPU player to the draft that auto-picks randomly (up to 3)'))
    .addSubcommand(sub => sub
      .setName('removebot')
      .setDescription('Remove the most recently added CPU player from the draft'))
    .addSubcommand(sub => sub
      .setName('start')
      .setDescription('Start the season or worlds draft')
      .addStringOption(opt => opt
        .setName('mode')
        .setDescription('Which draft to start')
        .setRequired(true)
        .addChoices(
          { name: 'season', value: 'season' },
          { name: 'worlds (calculates season standings automatically)', value: 'worlds' }
        )))
    .addSubcommand(sub => sub
      .setName('order')
      .setDescription('Show the upcoming pick order in the snake draft')
      .addIntegerOption(opt => opt.setName('picks').setDescription('Number of upcoming picks to show (default 10, max 20)').setRequired(false).setMinValue(1).setMaxValue(20)))
    .addSubcommand(sub => sub
      .setName('timer')
      .setDescription('Set the auto-skip timer for picks; 0 = disabled (admin only)')
      .addIntegerOption(opt => opt.setName('minutes').setDescription('Minutes before auto-skip; 0 to disable').setRequired(true).setMinValue(0)))
    .addSubcommand(sub => sub
      .setName('reset')
      .setDescription('Reset the draft')
      .addStringOption(opt => opt.setName('confirm').setDescription('Type RESET to confirm').setRequired(true)))
    .addSubcommand(sub => sub
      .setName('hardreset')
      .setDescription('Nuclear option: wipe all data if things are bugged beyond repair (Manage Server)')
      .addStringOption(opt => opt.setName('confirm').setDescription('Type HARDRESET to confirm').setRequired(true))),

  new SlashCommandBuilder()
    .setName('pick')
    .setDescription('Make, undo, or auto-resolve a draft pick')
    .addSubcommand(sub => sub
      .setName('team')
      .setDescription('Pick a team')
      .addIntegerOption(opt => opt.setName('team').setDescription('FRC team number').setRequired(true))
      .addUserOption(opt => opt.setName('for').setDescription('Pick for this player instead of yourself (admin only)').setRequired(false)))
    .addSubcommand(sub => sub
      .setName('manual')
      .setDescription('Pick a team for a manual player (admin only)')
      .addStringOption(opt => opt.setName('player').setDescription('Name of the manual player').setRequired(true))
      .addIntegerOption(opt => opt.setName('team').setDescription('FRC team number').setRequired(true)))
    .addSubcommand(sub => sub
      .setName('skip')
      .setDescription('Auto-pick the highest-scoring available team for your turn'))
    .addSubcommand(sub => sub
      .setName('undo')
      .setDescription('Undo the last pick or remove a specific team (admin only)')
      .addIntegerOption(opt => opt.setName('team').setDescription('FRC team number to undraft (omit to undo last pick)').setRequired(false))),

  new SlashCommandBuilder()
    .setName('trade')
    .setDescription('Propose, accept, decline, or lock trades')
    .addSubcommand(sub => sub
      .setName('propose')
      .setDescription('Propose a trade with another player')
      .addIntegerOption(opt => opt.setName('offer').setDescription('Team number you are giving away').setRequired(true))
      .addIntegerOption(opt => opt.setName('request').setDescription('Team number you want in return').setRequired(true)))
    .addSubcommand(sub => sub
      .setName('accept')
      .setDescription('Accept the trade proposed to you'))
    .addSubcommand(sub => sub
      .setName('decline')
      .setDescription('Decline or cancel the current pending trade'))
    .addSubcommand(sub => sub
      .setName('lock')
      .setDescription('Override the automatic trade lock rules (admin only)')
      .addStringOption(opt => opt
        .setName('mode')
        .setDescription('auto = default rules, locked = force closed, open = force allow')
        .setRequired(true)
        .addChoices(
          { name: 'auto (default: Week 5 deadline + 24h after worlds)', value: 'auto' },
          { name: 'locked (force trading closed)', value: 'locked' },
          { name: 'open (force trading allowed)', value: 'open' }
        ))),

  new SlashCommandBuilder()
    .setName('team')
    .setDescription('Look up FRC teams and their fantasy scores')
    .addSubcommand(sub => sub
      .setName('search')
      .setDescription('Search for a team by name')
      .addStringOption(opt => opt.setName('name').setDescription('Team name or keyword').setRequired(true)))
    .addSubcommand(sub => sub
      .setName('identify')
      .setDescription('Get team name by number')
      .addIntegerOption(opt => opt.setName('number').setDescription('Team number').setRequired(true)))
    .addSubcommand(sub => sub
      .setName('score')
      .setDescription('Show a full point breakdown for any FRC team')
      .addIntegerOption(opt => opt.setName('team').setDescription('FRC team number').setRequired(true))),

  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Standings, rosters, and exports')
    .addSubcommand(sub => sub
      .setName('standings')
      .setDescription('Show live fantasy standings with real scores from TBA'))
    .addSubcommand(sub => sub
      .setName('podium')
      .setDescription('Show the fantasy podium with personal placement'))
    .addSubcommand(sub => sub
      .setName('roster')
      .setDescription('Show all rosters as a clean team list (no scores)'))
    .addSubcommand(sub => sub
      .setName('teams')
      .setDescription('Show all fantasy teams and their owners'))
    .addSubcommand(sub => sub
      .setName('myteams')
      .setDescription('Show your personal team scores and breakdown (private)'))
    .addSubcommand(sub => sub
      .setName('breakdown')
      .setDescription('Show a full breakdown for one fantasy team or all fantasy teams')
      .addStringOption(opt => opt
        .setName('player')
        .setDescription('@mention a player, a manual player\'s name, or ALL')
        .setRequired(true)))
    .addSubcommand(sub => sub
      .setName('schedule')
      .setDescription('Show upcoming events for all drafted teams in the next 2 weeks'))
    .addSubcommand(sub => sub
      .setName('export')
      .setDescription('Export a CSV backup of all rosters')),

  new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Server/admin configuration')
    .addSubcommand(sub => sub
      .setName('setchannel')
      .setDescription('Set this channel as the draft channel (requires Manage Server permission)'))
    .addSubcommand(sub => sub
      .setName('addadmin')
      .setDescription('Promote a player to admin (admin only)')
      .addUserOption(opt => opt.setName('user').setDescription('Discord user to promote').setRequired(true)))
    .addSubcommand(sub => sub
      .setName('addmanualplayer')
      .setDescription('Add a non-Discord player to the draft (admin only)')
      .addStringOption(opt => opt.setName('name').setDescription('Name for the manual player').setRequired(true)))
    .addSubcommand(sub => sub
      .setName('announce')
      .setDescription('Post a custom message to #frc-fantasy-updates (admin only)')
      .addStringOption(opt => opt.setName('message').setDescription('Message to post').setRequired(true).setMaxLength(2000))),

  new SlashCommandBuilder()
    .setName('season')
    .setDescription('FRC season year used for TBA data')
    .addSubcommand(sub => sub
      .setName('current')
      .setDescription('Show the current year the bot is using for TBA data'))
    .addSubcommand(sub => sub
      .setName('set')
      .setDescription('Set the FRC season year for TBA data (admin only)')
      .addIntegerOption(opt => opt.setName('year').setDescription('e.g. 2027').setRequired(true))),

  new SlashCommandBuilder()
    .setName('nuke')
    .setDescription('Reconfigure this server from scratch — wipes all draft data (Manage Server)')
    .addStringOption(opt => opt
      .setName('confirm')
      .setDescription('Type NUKE to proceed to the confirmation step')
      .setRequired(true)),

  new SlashCommandBuilder().setName('help').setDescription('Show a full command reference'),
  new SlashCommandBuilder().setName('rules').setDescription('Show the fantasy scoring rules'),
];

// Historically a separate, trimmed command set was registered while the draft was
// closed. All commands now live under a handful of grouped top-level commands, and
// each subcommand's handler already checks `data.draftOpen`/`data.phase` at runtime
// (e.g. `/draft join`, `/draft addbot`), so a single always-registered list is used
// for both states — no more re-registering commands on every `/draft status` toggle.
const closedCommands = fullCommands;

// Only register commands when this file is run directly (`node commands.js`).
// index.js also `require`s this file for its exported command lists — without this
// guard, that require would trigger an unwanted global command registration as a
// side effect.
if (require.main === module) {
  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
  (async () => {
    try {
      console.log('Registering global slash commands...');
      await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: fullCommands });
      console.log('✅ All commands registered globally! (may take up to 1 hour to appear in servers)');
    } catch (error) {
      console.error('Error:', error);
    }
  })();
}

module.exports = { fullCommands, closedCommands };
