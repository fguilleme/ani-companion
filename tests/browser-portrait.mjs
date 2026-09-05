import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const server = spawn('/home/francois/.hermes/hermes-agent/venv/bin/python', [
  '-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', '8793',
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
    try { if ((await fetch('http://127.0.0.1:8793/api/health')).ok) break; } catch {}
    await delay(100);
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 430, height: 850 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const ttsTexts = [];
  await page.route('**/api/tts', async route => {
    ttsTexts.push(route.request().postDataJSON().text);
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: silentWav() });
  });
  await page.addInitScript(() => {
    localStorage.setItem('ani.voice', 'on');
    localStorage.setItem('ani.microphone', 'off');
    localStorage.setItem('ani.session.generation', '2');
    localStorage.setItem('ani.session', 'bloated-session');
    localStorage.setItem('ani.session.turns', '12');
    window.__chatSessionIds = [];
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.endsWith('/api/chat/stream')) return nativeFetch(input, init);
      const request = JSON.parse(init.body || '{}');
      window.__chatSessionIds.push(request.session_id);
      const encoder = new TextEncoder();
      const events = request.message.includes('réveil lent') ? [
        [0, { type: 'start', session_id: 'portrait-test', turn_key: 'server-generated-slow-key' }],
        [6200, { type: 'phase', phase: 'compression' }],
        [6600, { type: 'phase', phase: 'llm' }],
        [7000, { type: 'delta', text: 'Me voilà.' }],
        [7010, { type: 'speech', text: 'Me voilà.', emotion: 'happy' }],
        [7300, { type: 'complete', reply: 'Me voilà.', emotion: 'happy', actions: [], session_id: 'portrait-test' }],
      ] : [
        [0, { type: 'start', session_id: 'portrait-test', turn_key: 'server-generated-portrait-key' }],
        [300, { type: 'phase', phase: 'compression' }],
        [1800, { type: 'delta', text: 'Je suis là, en rose et bien visible.' }],
        [1810, { type: 'speech', text: 'Je suis là, en rose et bien visible.', emotion: 'happy' }],
        [2200, { type: 'complete', reply: 'Je suis là, en rose et bien visible.', emotion: 'happy', actions: [], session_id: 'portrait-test' }],
      ];
      return new Response(new ReadableStream({ start(controller) {
        for (const [wait, event] of events) setTimeout(() => {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          if (event === events.at(-1)[1]) controller.close();
        }, wait);
      }}), { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    };
  });
  await page.goto('http://127.0.0.1:8793/', { waitUntil: 'domcontentloaded' });
  if (await page.locator('#speech').count()) fail('Le bandeau défilant est encore présent');
  const layout = await page.evaluate(() => {
    const stage = document.querySelector('.stage').getBoundingClientRect();
    const conversation = document.querySelector('.conversation');
    const indicator = document.querySelector('#phase-indicator').getBoundingClientRect();
    return {
      stage,
      conversationPosition: getComputedStyle(conversation).position,
      conversationBottom: conversation.getBoundingClientRect().bottom,
      indicatorRight: innerWidth - indicator.right,
    };
  });
  if (layout.stage.height < 840) fail(`Ani n'occupe pas le plein écran portrait: ${JSON.stringify(layout)}`);
  if (layout.conversationPosition !== 'absolute' || layout.conversationBottom < 840) fail(`Conversation non superposée: ${JSON.stringify(layout)}`);
  if (layout.indicatorRight > 24) fail(`Indicateur trop loin du coin supérieur droit: ${JSON.stringify(layout)}`);

  await page.fill('#message-input', 'Teste le portrait');
  await page.click('button.send');
  const waiting = await page.evaluate(() => ({
    phase: document.querySelector('#phase-indicator').dataset.phase,
    label: document.querySelector('#phase-indicator .phase-label').textContent,
    animation: getComputedStyle(document.querySelector('#phase-indicator i')).animationName,
  }));
  if (waiting.phase !== 'llm' || waiting.label !== 'Ani réfléchit' || waiting.animation === 'none') fail(`Attente LLM non animée: ${JSON.stringify(waiting)}`);
  await page.waitForFunction(() => document.querySelector('#phase-indicator').dataset.phase === 'compression');
  await page.waitForFunction(() => document.querySelector('.bubble.ani')?.textContent.includes('bien visible'));
  const colors = await page.evaluate(() => ({
    user: getComputedStyle(document.querySelector('.bubble.user')).color,
    ani: getComputedStyle(document.querySelector('.bubble.ani')).color,
    phase: document.querySelector('#phase-indicator').dataset.phase,
    phaseLabel: document.querySelector('#phase-indicator .phase-label').textContent,
    phaseAnimation: getComputedStyle(document.querySelector('#phase-indicator i')).animationName,
    phaseText: document.querySelector('#phase-indicator').textContent,
  }));
  if (colors.user !== 'rgb(255, 255, 255)') fail(`Transcription utilisateur non blanche: ${JSON.stringify(colors)}`);
  if (colors.ani !== 'rgb(255, 163, 196)') fail(`Réponse Ani non rose: ${JSON.stringify(colors)}`);
  if (colors.phase !== 'answering' || colors.phaseLabel !== 'Ani répond' || colors.phaseAnimation !== 'phase-answer') fail(`Réponse LLM non signalée: ${JSON.stringify(colors)}`);
  if (!ttsTexts.some(text => /idées|pensées|souvenirs/.test(text))) fail(`Aucune annonce vocale de compression: ${JSON.stringify(ttsTexts)}`);
  await page.screenshot({ path: '/tmp/ani-portrait-overlay.png' });
  await page.waitForFunction(() => document.querySelector('#phase-indicator').dataset.phase === 'idle');
  const lifecycle = await page.evaluate(() => ({
    firstSessionId: window.__chatSessionIds[0],
    turns: localStorage.getItem('ani.session.turns'),
  }));
  if (lifecycle.firstSessionId !== null || lifecycle.turns !== '1') fail(`Le contexte ancien n'a pas été renouvelé: ${JSON.stringify(lifecycle)}`);
  ttsTexts.length = 0;
  await page.fill('#message-input', 'Simule un réveil lent');
  await page.click('button.send');
  const currentOnly = await page.evaluate(() => [...document.querySelectorAll('.bubble')].map(node => ({who: node.className, text: node.textContent})));
  if (currentOnly.length !== 1 || !currentOnly[0].who.includes('user') || !currentOnly[0].text.includes('réveil lent')) fail(`L'ancien échange reste affiché: ${JSON.stringify(currentOnly)}`);
  await page.waitForFunction(() => document.querySelector('#phase-indicator').dataset.phase === 'compression', null, { timeout: 7000 });
  const slowPhase = await page.locator('#phase-indicator').getAttribute('data-phase');
  const slowTime = await page.locator('#phase-indicator time').textContent();
  if (slowPhase !== 'compression') fail(`Phase compression absente après le réveil lent: ${slowPhase}`);
  if (!/^00:0[01]$/.test(slowTime || '')) fail(`Chronomètre compression incorrect: ${slowTime}`);
  if (!ttsTexts.some(text => /réveille|cerveau|brouillard/.test(text))) fail(`Aucune annonce vocale de réveil lent: ${JSON.stringify(ttsTexts)}`);
  if (!ttsTexts.some(text => /idées|pensées|souvenirs/.test(text))) fail(`La compression n'a pas interrompu l'annonce de réveil: ${JSON.stringify(ttsTexts)}`);
  await page.waitForFunction(() => document.querySelector('#phase-indicator').dataset.phase === 'idle');
  ttsTexts.length = 0;
  await page.fill('#message-input', 'Simule un réveil lent une deuxième fois');
  await page.click('button.send');
  await page.waitForTimeout(6100);
  if (ttsTexts.some(text => /réveille|cerveau|brouillard/.test(text))) fail(`L'annonce de réveil s'est répétée: ${JSON.stringify(ttsTexts)}`);

  const tabletContext = await browser.newContext({ viewport: { width: 820, height: 1180 }, serviceWorkers: 'block' });
  const tablet = await tabletContext.newPage();
  await tablet.goto('http://127.0.0.1:8793/', { waitUntil: 'domcontentloaded' });
  const tabletLayout = await tablet.evaluate(() => {
    const stage = document.querySelector('.stage').getBoundingClientRect();
    return { stageWidth: stage.width, stageHeight: stage.height };
  });
  if (tabletLayout.stageWidth !== 820 || tabletLayout.stageHeight !== 1180) fail(`Portrait tablette remplacé par le desktop: ${JSON.stringify(tabletLayout)}`);
  console.log(JSON.stringify({ ok: true, layout, colors, ttsTexts, screenshot: '/tmp/ani-portrait-overlay.png' }));
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}