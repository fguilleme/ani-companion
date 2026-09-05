import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const server = spawn('/home/francois/.hermes/hermes-agent/venv/bin/python', [
  '-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', '8794',
], { cwd: '/home/francois/ani-companion', stdio: ['ignore', 'pipe', 'pipe'] });
const fail = message => { throw new Error(message); };
const silentWav = (duration = 2, sampleRate = 8000) => {
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
    try { if ((await fetch('http://127.0.0.1:8794/api/health')).ok) break; } catch {}
    await delay(100);
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  await page.route('**/api/tts', async route => {
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: silentWav() });
  });
  await page.addInitScript(() => {
    localStorage.setItem('ani.voice', 'off');
    localStorage.setItem('ani.microphone', 'off');
    window.__chatEvents = [];
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.endsWith('/api/chat/stream')) return nativeFetch(input, init);
      const request = JSON.parse(init.body || '{}');
      window.__chatEvents.push(request.message);
      const encoder = new TextEncoder();
      const events = [
        [0, { type: 'start', session_id: 'landscape-test', turn_key: 'landscape-key' }],
        [300, { type: 'delta', text: 'Je suis là, à gauche.' }],
        [310, { type: 'speech', text: 'Je suis là, à gauche.', emotion: 'happy' }],
        [600, { type: 'complete', reply: 'Je suis là, à gauche.', emotion: 'happy', actions: [], session_id: 'landscape-test' }],
      ];
      return new Response(new ReadableStream({ start(controller) {
        for (const [wait, event] of events) setTimeout(() => {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          if (event === events.at(-1)[1]) controller.close();
        }, wait);
      }}), { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    };
  });
  await page.goto('http://127.0.0.1:8794/', { waitUntil: 'domcontentloaded' });

  const layout = await page.evaluate(() => {
    const shell = document.querySelector('.companion-shell').getBoundingClientRect();
    const stage = document.querySelector('.stage').getBoundingClientRect();
    const conversation = document.querySelector('.conversation').getBoundingClientRect();
    const history = document.querySelector('.history');
    return {
      shellWidth: shell.width,
      stageWidth: stage.width,
      stageLeft: stage.left,
      conversationWidth: conversation.width,
      conversationLeft: conversation.left,
      historyDisplay: getComputedStyle(history).display,
      historyOverflowY: getComputedStyle(history).overflowY,
    };
  });
  if (layout.stageWidth >= layout.conversationWidth) fail(`Ani ne devrait pas être plus large que la conversation: ${JSON.stringify(layout)}`);
  if (layout.stageLeft !== 0) fail(`Ani devrait être collée à gauche: ${JSON.stringify(layout)}`);
  if (layout.conversationLeft < layout.stageWidth) fail(`La conversation devrait être à droite d'Ani: ${JSON.stringify(layout)}`);
  if (layout.historyDisplay !== 'flex' || layout.historyOverflowY !== 'auto') fail(`L'historique devrait être scrollable en colonne: ${JSON.stringify(layout)}`);

  await page.fill('#message-input', 'Teste le paysage');
  await page.click('button.send');
  await page.waitForFunction(() => document.querySelector('.bubble.ani')?.textContent.includes('à gauche'));
  const bubbles = await page.evaluate(() => [...document.querySelectorAll('.bubble')].map(node => ({
    who: node.className,
    text: node.textContent,
    alignSelf: getComputedStyle(node).alignSelf,
  })));
  if (bubbles.length !== 2) fail(`Deux bulles attendues: ${JSON.stringify(bubbles)}`);
  if (!bubbles[0].who.includes('user') || bubbles[0].alignSelf !== 'flex-end') fail(`Bulle utilisateur mal alignée: ${JSON.stringify(bubbles)}`);
  if (!bubbles[1].who.includes('ani') || bubbles[1].alignSelf !== 'flex-start') fail(`Bulle Ani mal alignée: ${JSON.stringify(bubbles)}`);

  const lazy = await page.evaluate(() => {
    const history = document.querySelector('.history');
    const sentinel = document.querySelector('.history-sentinel');
    return {
      hasSentinel: Boolean(sentinel),
      historyScrollHeight: history.scrollHeight,
      historyClientHeight: history.clientHeight,
    };
  });
  if (!lazy.hasSentinel) fail(`Sentinelle de lazy loading absente: ${JSON.stringify(lazy)}`);

  console.log(JSON.stringify({ ok: true, layout, bubbles, lazy }));
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}