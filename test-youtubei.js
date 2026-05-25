const { Innertube, UniversalCache } = require('youtubei.js');
const fs = require('fs');

async function test() {
  const yt = await Innertube.create({ cache: new UniversalCache(false) });
  
  console.log('Searching...');
  const search = await yt.search('never gonna give you up', { type: 'video' });
  const videoId = search.videos[0].id;
  const title = search.videos[0].title.text;
  console.log(`Found: ${title} (${videoId})`);
  
  console.log('Fetching stream...');
  const stream = await yt.download(videoId, {
    type: 'audio',
    quality: 'best',
    format: 'mp4' // mp4 for aac audio, which decodeAudioData easily supports
  });
  
  const file = fs.createWriteStream('test_audio.m4a');
  
  for await (const chunk of stream) {
    file.write(chunk);
  }
  file.end();
  
  console.log('Finished writing test file.');
}

test().catch(console.error);
