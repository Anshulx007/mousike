const youtubedl = require('youtube-dl-exec');
const fs = require('fs');

async function test() {
  const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  console.log('Downloading audio...');
  
  // Return a readable stream
  const subprocess = youtubedl.exec(url, {
    f: 'bestaudio',
    o: '-' // output to stdout
  });
  
  const writeStream = fs.createWriteStream('test_audio_ytdl.m4a');
  subprocess.stdout.pipe(writeStream);
  
  subprocess.stdout.on('end', () => {
    console.log('Finished downloading audio stream.');
  });
  
  subprocess.stderr.on('data', (data) => {
    console.log(`yt-dlp error: ${data}`);
  });
}

test().catch(console.error);
