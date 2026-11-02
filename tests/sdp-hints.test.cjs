'use strict';
// withBitrateHints (public/app.js): acrescenta x-google-min/start-bitrate só aos codecs de vídeo.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const start = code.indexOf('function withBitrateHints');
const fn = code.slice(start, code.indexOf('\n}\n', start) + 3);
const context = vm.createContext({});
vm.runInContext(`${fn}; this.withBitrateHints = withBitrateHints;`, context);

const sdp = [
  'v=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 97 102 103',
  'a=rtpmap:96 VP8/90000', 'a=rtpmap:97 rtx/90000', 'a=fmtp:97 apt=96',
  'a=rtpmap:102 H264/90000', 'a=fmtp:102 packetization-mode=1',
  'a=rtpmap:103 VP9/90000', ''
].join('\r\n');

test('adiciona o piso de bitrate aos codecs de vídeo', () => {
  const out = context.withBitrateHints(sdp, 6300, 10500);
  const hint = 'x-google-min-bitrate=6300;x-google-start-bitrate=10500';
  assert.match(out, new RegExp(`a=fmtp:96 ${hint}`));            // VP8 não tinha fmtp: linha criada
  assert.match(out, new RegExp(`a=fmtp:102 packetization-mode=1;${hint}`)); // H.264: acrescentado
  assert.match(out, new RegExp(`a=fmtp:103 ${hint}`));
});

test('não mexe em áudio nem em rtx', () => {
  const out = context.withBitrateHints(sdp, 6300, 10500);
  assert.match(out, /a=fmtp:111 minptime=10\r\n/);
  assert.match(out, /a=fmtp:97 apt=96\r\n/);
});
