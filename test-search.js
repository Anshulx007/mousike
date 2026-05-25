const ytSearch = require('yt-search');

async function test() {
  const r = await ytSearch('rick roll');
  const videos = r.videos.slice(0, 1).map(v => ({
    title: v.title,
    url: v.url,
    author: v.author.name,
    duration: v.timestamp,
    image: v.image || v.thumbnail
  }));
  console.log(videos);
}

test().catch(console.error);
