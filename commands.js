require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const fullCommands = [
  new SlashCommandBuilder().setName('currentyear').setDescription('Show the current year the bot is using for TBA data'),
  new SlashCommandBuilder()
    .setName('undraft')
    .setDescription('Undo the last pick or remove a specific team (admin only)')
    .addIntegerOption(opt => opt.setName('team').setDescription('FRC team number to undraft (omit to undo last pick)').setRequired(false)),
  new SlashCommandBuilder().setName('podium').setDescription('Show the fantasy podium with personal placement'),
  new SlashCommandBuilder()
    .setName('addadmin')
    .setDescription('Promote a player to admin (admin only)')
    .addUserOption(opt => opt.setName('user').setDescription('Discord user to promote').setRequired(true)),
  new SlashCommandBuilder()
    .setName('addmanualplayer')
    .setDescription('Add a non-Discord player to the draft (admin only)')
    .addStringOption(opt => opt.setName('name').setDescription('Name for the manual player').setRequired(true)),
  new SlashCommandBuilder()
    .setName('manualpick')
    .setDescription('Pick a team for a manual player (admin only)')
    .addStringOption(opt => opt.setName('player').setDescription('Name of the manual player').setRequired(true))
    .addIntegerOption(opt => opt.setName('team').setDescription('FRC team number').setRequired(true)),
  new SlashCommandBuilder().setName('exportcsv').setDescription('Export a CSV backup of all rosters'),
  new SlashCommandBuilder().setName('roster').setDescription('Show all rosters as a clean team list (no scores)'),
  new SlashCommandBuilder().setName('join_draft').setDescription('Join the fantasy draft'),
  new SlashCommandBuilder().setName('addbot').setDescription('Add a CPU player to the draft that auto-picks randomly'),
  new SlashCommandBuilder().setName('start_draft').setDescription('Start the season draft'),
  new SlashCommandBuilder().setName('start_worlds_draft').setDescription('Start the worlds draft (calculates season standings automatically)'),
  new SlashCommandBuilder()
    .setName('pick')
    .setDescription('Pick a team')
    .addIntegerOption(opt => opt.setName('team').setDescription('FRC team number').setRequired(true))
    .addUserOption(opt => opt.setName('for').setDescription('Pick for this player instead of yourself (admin only)').setRequired(false)),
  new SlashCommandBuilder()
    .setName('standings')
    .setDescription('Show live fantasy standings with real scores from TBA'),
  new SlashCommandBuilder()
    .setName('trade')
    .setDescription('Propose a trade with another player')
    .addIntegerOption(opt => opt.setName('offer').setDescription('Team number you are giving away').setRequired(true))
    .addIntegerOption(opt => opt.setName('request').setDescription('Team number you want in return').setRequired(true)),
  new SlashCommandBuilder()
    .setName('accepttrade')
    .setDescription('Accept the trade proposed to you'),
  new SlashCommandBuilder()
    .setName('declinetrade')
    .setDescription('Decline or cancel the current pending trade'),
  new SlashCommandBuilder()
    .setName('score')
    .setDescription('Show a full point breakdown for any FRC team')
    .addIntegerOption(opt => opt.setName('team').setDescription('FRC team number').setRequired(true)),
  new SlashCommandBuilder()
    .setName('breakdown')
    .setDescription('Show a full breakdown for one fantasy team or all fantasy teams')
    .addStringOption(opt => {
      const option = opt.setName('player').setDescription('Pick a fantasy player or ALL').setRequired(true);
      option.addChoices({ name: 'ALL', value: 'ALL' });
      return option;
    }),
  new SlashCommandBuilder().setName('teams').setDescription('Show all fantasy teams and their owners'),
  new SlashCommandBuilder()
    .setName('team')
    .setDescription('Search for a team by name')
    .addStringOption(opt => opt.setName('name').setDescription('Team name or keyword').setRequired(true)),
  new SlashCommandBuilder()
    .setName('team_identify')
    .setDescription('Get team name by number')
    .addIntegerOption(opt => opt.setName('number').setDescription('Team number').setRequired(true)),
  new SlashCommandBuilder()
    .setName('reset_draft')
    .setDescription('Reset the draft')
    .addStringOption(opt => opt.setName('confirm').setDescription('Type RESET to confirm').setRequired(true)),
  new SlashCommandBuilder()
    .setName('draftstatus')
    .setDescription('Open or close + reset the draft')
    .addBooleanOption(option =>
      option.setName('open')
        .setDescription('true = open for joining | false = close and reset')
        .setRequired(true)
    ),
];

const closedCommands = [
  new SlashCommandBuilder().setName('draftstatus').setDescription('Open or close + reset the draft'),
  new SlashCommandBuilder().setName('standings').setDescription('Show live fantasy standings with real scores from TBA'),
  new SlashCommandBuilder()
    .setName('score')
    .setDescription('Show a full point breakdown for any FRC team')
    .addIntegerOption(opt => opt.setName('team').setDescription('FRC team number').setRequired(true)),
  new SlashCommandBuilder().setName('teams').setDescription('Show all fantasy teams and their owners'),
  new SlashCommandBuilder().setName('currentyear').setDescription('Show the current year the bot is using for TBA data'),
  new SlashCommandBuilder().setName('exportcsv').setDescription('Export a CSV backup of all rosters'),
  new SlashCommandBuilder().setName('roster').setDescription('Show all rosters as a clean team list (no scores)'),
];

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

module.exports = { fullCommands, closedCommands };
