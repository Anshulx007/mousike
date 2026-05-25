const play = require('play-dl');

async function test() {
  const results = await play.search('never gonna give you up', { limit: 1 });
  console.log(results[0]);
}

test().catch(console.error);
