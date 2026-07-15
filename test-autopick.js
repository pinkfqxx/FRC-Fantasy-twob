// Standalone test: exercises the auto-pick scoring + randomized selection logic
// (the same code path doBotPick uses) against real TBA data, without touching Discord.
const bot = require('./index.js');

async function main() {
  const year = bot.DEFAULT_YEAR;
  console.log(`Loading season team pool for ${year}...`);
  const allTeams = await bot.loadSeasonTeams(year);
  console.log(`Pool size: ${allTeams.length} teams`);

  // Sample a manageable pool of teams to score, so this finishes in reasonable time.
  const sampleSize = 150;
  const shuffled = [...allTeams].sort(() => Math.random() - 0.5);
  const sample = shuffled.slice(0, sampleSize);

  console.log(`Scoring ${sample.length} sampled teams (historical avg, best-2-events/year, last 3 years)...`);
  const scored = await Promise.all(
    sample.map(async t => ({ team: t, score: await bot.getTeamHistoricalSeasonScore(t, year) }))
  );

  const nonZero = scored.filter(s => s.score > 0).length;
  console.log(`Teams with a nonzero historical score: ${nonZero}/${scored.length}\n`);

  console.log('Simulating 10 sequential auto-picks (each pick removes that team from the pool,');
  console.log('so the pool of candidates regenerates from what is actually still available):\n');

  let remaining = [...scored]; // mirrors doBotPick's `available` shrinking as teams get drafted
  const picks = [];
  for (let i = 1; i <= 10; i++) {
    const winner = await bot.pickWithRandomness(remaining, 10);
    const name = await bot.getTeamName(winner.team).catch(() => `Team ${winner.team}`);
    picks.push(winner.team);
    remaining = remaining.filter(s => s.team !== winner.team); // this team can never be picked again
    console.log(`  Pick ${i}: ${name} — score ${winner.score.toFixed(1)}  (${remaining.length} teams left in sample pool)`);
  }

  const uniquePicks = new Set(picks).size;
  console.log(`\n${uniquePicks}/10 unique teams picked — each pick permanently removes that team, so the` +
    ` next pool of ~10 candidates is always drawn from the best of what's still actually available.`);
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
