import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const server = spawn('/home/francois/.hermes/hermes-agent/venv/bin/python', [
  '-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', '8792',
], { cwd: '/home/francois/projects/ani-companion', stdio: ['ignore', 'pipe', 'pipe'] });

const fail = message => { throw new Error(message); };
const silentWav = (duration = 0.12, sampleRate = 8000) => {
  const samples = Math.floor(duration * sampleRate);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + samples * 2, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
};

let browser;
try {
  for (let attempt = 0; attempt < 50; attempt++) {
    try { if ((await fetch('http://127.0.0.1:8792/api/health')).ok) break; } catch {}
    await delay(100);
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 430, height: 850 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const ttsRequests = [];
  await page.route('**/api/tts', async route => {
    ttsRequests.push(route.request().postDataJSON().text);
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: silentWav() });
  });
  await page.addInitScript(() => {
    localStorage.setItem('ani.profile', 'francois');
    localStorage.setItem('ani.voice', 'on');
    localStorage.setItem('ani.microphone', 'off');
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.endsWith('/api/chat/stream')) return nativeFetch(input, init);
      const encoder = new TextEncoder();
      const events = [
        [0, { type: 'start', session_id: 'stream-browser-test', turn_key: 'server-generated-browser-key' }],
        [10, { type: 'delta', text: 'Premier segment. ' }],
        [20, { type: 'speech', text: 'Premier segment.', emotion: 'happy' }],
        [70, { type: 'phase', phase: 'compression' }],
        [100, { type: 'phase', phase: 'llm' }],
        [180, { type: 'delta', text: 'Deuxième segment. ' }],
        [190, { type: 'speech', text: 'Deuxième segment.', emotion: 'happy' }],
        [350, { type: 'delta', text: 'Troisième segment.' }],
        [360, { type: 'speech', text: 'Troisième segment.', emotion: 'happy' }],
        [3000, { type: 'complete', reply: 'Premier segment. Deuxième segment. Troisième segment.', speech: 'Premier segment. Deuxième segment. Troisième segment.', emotion: 'happy', actions: [], session_id: 'stream-browser-test' }],
      ];
      return new Response(new ReadableStream({
        start(controller) {
          for (const [delayMs, event] of events) setTimeout(() => {
            if (event.type === 'complete') window.__aniCompleteAt = performance.now();
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
            if (event === events.at(-1)[1]) controller.close();
          }, delayMs);
        },
      }), { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    };
  });
  await page.goto('http://127.0.0.1:8792/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    window.__aniPlayTimes = [];
    document.querySelector('#voice-player').addEventListener('play', () => {
      if (document.querySelector('#voice-player').dataset.turnId) window.__aniPlayTimes.push(performance.now());
    });
  });
  await page.fill('#message-input', 'Lis les trois segments');
  await page.click('button.send');
  try {
    await page.waitForFunction(() => window.__aniPlayTimes.length === 3, null, { timeout: 10000 });
  } catch (error) {
    const debug = await page.evaluate(() => ({
      playTimes: window.__aniPlayTimes,
      completeAt: window.__aniCompleteAt,
      bubbles: [...document.querySelectorAll('.bubble')].map(element => element.textContent),
    }));
    fail(`Lecture streaming incomplète: ${JSON.stringify({ ttsRequests, debug, cause: error.message })}`);
  }
  await page.waitForFunction(() => window.__aniCompleteAt > 0, null, { timeout: 3000 });
  for (let attempt = 0; attempt < 50 && ttsRequests.length < 4; attempt++) await delay(50);
  const state = await page.evaluate(() => ({
    playTimes: window.__aniPlayTimes,
    completeAt: window.__aniCompleteAt,
    reply: [...document.querySelectorAll('.bubble.ani')].at(-1)?.textContent,
  }));
  if (ttsRequests.slice(0, 3).join('|') !== 'Premier segment.|Deuxième segment.|Troisième segment.') {
    fail(`La compression s'est insérée dans la parole principale: ${JSON.stringify(ttsRequests)}`);
  }
  if (ttsRequests.length !== 4 || /segment/i.test(ttsRequests[3])) {
    fail(`L'annonce de compression n'a pas été reportée après la réponse: ${JSON.stringify(ttsRequests)}`);
  }
  if (!state.playTimes[0] || state.playTimes[0] >= state.completeAt) {
    fail(`Le premier audio n'a pas commencé avant la fin du LLM: ${JSON.stringify(state)}`);
  }
  if (state.reply !== 'Premier segment. Deuxième segment. Troisième segment.') {
    fail(`Réponse progressive incorrecte: ${JSON.stringify(state)}`);
  }
  console.log(JSON.stringify({ ok: true, audioSegments: ttsRequests.length, firstAudioBeforeCompleteMs: Math.round(state.completeAt - state.playTimes[0]) }));
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}
