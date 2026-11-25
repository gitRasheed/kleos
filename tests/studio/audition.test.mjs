import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { auditionHtml } from '../../dist/io/auditionHtml.js';
import { encodeDitheredWav } from '../../dist/io/wav.js';

const sr = 16000;
function stem(id, hz, seconds) {
  const channel = Float64Array.from({ length: seconds * sr }, (_, i) => 0.1 * Math.sin(2 * Math.PI * hz * i / sr));
  return { id, wav: encodeDitheredWav({ sampleRate: sr, channels: [channel] }) };
}
test('standalone page decodes embedded audio, synchronizes transport and exports the audible mix', { timeout: 15000 }, async t => {
  const candidates = process.env.CHROME ? [process.env.CHROME] : ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'];
  const chrome = candidates.find(bin => spawnSync(bin, ['--version']).error?.code !== 'ENOENT');
  if (!chrome) return t.skip('Chrome or Chromium is unavailable. Set CHROME to its executable.');
  const dir = mkdtempSync(join(tmpdir(), 'aa-'));
  const file = join(dir, 'audition.html');
  const id = 'lead</script><strong>';
  const html = auditionHtml([stem(id, 440, 3), stem('pad', 220, 2)], [
    { timeS: 0.5, code: 'MASKED', trackId: id, maskers: ['pad'] }, { timeS: 2.25, code: 'BUS_OVER', id: 'group' }]);
  writeFileSync(file, html);
  assert.ok(!html.includes(id));
  const proc = spawn(chrome, [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-crash-reporter',
    '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--remote-debugging-pipe',
    '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--user-data-dir=' + join(dir, 'profile'),
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: dir, XDG_CACHE_HOME: dir, XDG_CONFIG_HOME: dir } });
  const closed = once(proc, 'close');
  t.after(async () => { proc.kill(); await closed; rmSync(dir, { recursive: true, force: true }); });
  let seq = 0, partial = '';
  const pending = new Map();
  proc.stdio[4].setEncoding('utf8').on('data', chunk => {
    const messages = (partial + chunk).split('\0');
    partial = messages.pop();
    for (const line of messages) {
      const packet = JSON.parse(line);
      const cb = pending.get(packet.id);
      if (cb) { pending.delete(packet.id); cb(packet); }
    }
  });
  function command(method, params = {}, sessionId) {
    const id = ++seq;
    return new Promise((ok, fail) => {
      pending.set(id, p => p.error ? fail(new Error(p.error.message)) : ok(p.result));
      proc.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    });
  }
  const { targetId } = await command('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
  const page = (method, params) => command(method, params, sessionId);
  async function evaluate(expression) {
    const r = await page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    assert.ok(!r.exceptionDetails, r.exceptionDetails?.exception?.description);
    return r.result.value;
  }
  await page('Page.enable');
  await page('Page.addScriptToEvaluateOnNewDocument', {
    source: `
    globalThis.started=[]; globalThis.stopped=0; globalThis.gains=[]; globalThis.copied='';
    globalThis.waitForStarts = n => new Promise(resolve => {
      function check() { if(started.length >= n) { removeEventListener('stemstart',check); resolve(true); } }
      addEventListener('stemstart',check); check();
    });
    const start = AudioBufferSourceNode.prototype.start, stop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.start = function(when, offset) { start.call(this,when,offset); started.push([when,offset,this.buffer.duration]); dispatchEvent(new Event('stemstart')); };
    AudioBufferSourceNode.prototype.stop = function() { stopped++; return stop.call(this); };
    const createGain=AudioContext.prototype.createGain;
    AudioContext.prototype.createGain=function(){const node=createGain.call(this); gains.push(node); return node;};
    Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{globalThis.copied=text;}}});
  `});
  await page('Page.navigate', { url: pathToFileURL(file).href });
  await evaluate(`new Promise(resolve=>{
    const check=()=>{if(document.querySelector('#play:enabled')){observer.disconnect();resolve(true)}};
    const observer=new MutationObserver(check);observer.observe(document,{subtree:true,childList:true,attributes:true});check();
  })`);
  assert.equal(await evaluate("document.querySelector('legend').textContent"), id);
  assert.equal(await evaluate("document.querySelectorAll('#findings button:enabled').length"), 2);
  await evaluate(`document.getElementById('play').click(); waitForStarts(2)`);
  const starts = await evaluate('started');
  assert.equal(starts.length, 2); assert.equal(starts[0][0], starts[1][0]); assert.equal(starts[1][1], 0);
  const mix = await evaluate(`
    const [lead,pad]=document.querySelectorAll('fieldset'), [,solo,gain]=lead.querySelectorAll('input');
    solo.click(); gain.value='-6'; gain.dispatchEvent(new Event('input'));
    document.getElementById('copy').click();
    ({params:JSON.parse(copied),levels:gains.map(g=>g.gain.value)})
  `);
  assert.deepEqual(mix.params, { tracks: [{ id, gainDb: -6, mute: false, solo: true }, { id: 'pad', gainDb: 0, mute: false, solo: false }] });
  assert.ok(Math.abs(mix.levels[0] - 10 ** (-6 / 20)) < 1e-6); assert.equal(mix.levels[1], 0);
  assert.deepEqual(await evaluate("lead.querySelector('input').click(); gains.map(g=>g.gain.value)"), [0, 0]);
  await evaluate(`document.querySelector('#findings button').click(); waitForStarts(4)`);
  assert.equal(await evaluate('stopped'), 2);
  assert.deepEqual(await evaluate('started.slice(-2).map(s=>s[1])'), [0.5, 0.5]);
  assert.equal(await evaluate('started.at(-2)[0]===started.at(-1)[0]'), true);
  await evaluate(`document.querySelectorAll('#findings button')[1].click(); waitForStarts(5)`);
  assert.equal(await evaluate('started.length'), 5);
  assert.deepEqual(await evaluate('started.at(-1).slice(1)'), [2.25, 3]);
  await evaluate("document.getElementById('play').click(); document.querySelector('#findings button').click()");
  assert.equal(await evaluate("document.getElementById('play').textContent"), 'Play');
  assert.equal(await evaluate("document.getElementById('clock').textContent"), '0.50 s');
  await evaluate(`navigator.clipboard.writeText=async()=>{throw Error('unavailable')};document.getElementById('copy').click();`);
  assert.equal(await evaluate("document.getElementById('json').hidden"), false);
});
