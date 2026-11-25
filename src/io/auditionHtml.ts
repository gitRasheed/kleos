import { Buffer } from 'node:buffer';

export interface AuditionStem {
  readonly id: string;
  readonly wav: Uint8Array;
  readonly gainDb?: number;
  readonly mute?: boolean;
  readonly solo?: boolean;
}
export interface AuditionFinding { readonly timeS: number; readonly code: string; readonly trackId?: string; readonly id?: string; readonly maskers?: readonly string[] }
interface Session {
  stems: { id: string; wav: string; gainDb: number; mute: boolean; solo: boolean }[];
  findings: readonly AuditionFinding[];
}

function audition() {
  function element<T extends HTMLElement>(id: string): T {
    const el = document.getElementById(id);
    if (!el) throw new Error('Missing audition control ' + id);
    return el as T;
  }
  const data: Session = JSON.parse(element('session').textContent ?? '');
  const ctx = new AudioContext();
  const play = element<HTMLButtonElement>('play');
  const scrub = element<HTMLInputElement>('time');
  const clock = element<HTMLOutputElement>('clock');
  const status = element('status');
  const fallback = element<HTMLTextAreaElement>('json');
  const gains = data.stems.map(() => ctx.createGain());
  for (const gain of gains) gain.connect(ctx.destination);
  let buffers: AudioBuffer[] = [], sources: AudioBufferSourceNode[] = [];
  let offset = 0, startTime = 0, duration = 0, running = false, revision = 0;

  function levels() {
    const solo = data.stems.some(s => s.solo);
    data.stems.forEach((s, i) => {
      const gain = gains[i];
      if (gain) gain.gain.value = s.mute || (solo && !s.solo) ? 0 : 10 ** (s.gainDb / 20);
    });
  }
  for (const s of data.stems) {
    const row = document.createElement('fieldset');
    const name = document.createElement('legend');
    name.textContent = s.id;
    row.append(name);
    for (const key of ['mute', 'solo'] as const) {
      const label = document.createElement('label'), input = document.createElement('input');
      input.type = 'checkbox'; input.checked = s[key];
      input.onchange = () => { s[key] = input.checked; levels(); };
      label.append(input, key === 'mute' ? ' Mute' : ' Solo'); row.append(label);
    }
    const label = document.createElement('label'), slider = document.createElement('input'), value = document.createElement('output');
    slider.type = 'range'; slider.min = '-60'; slider.max = '12'; slider.step = '0.1'; slider.value = String(s.gainDb);
    value.textContent = s.gainDb + ' dB';
    slider.oninput = () => { s.gainDb = Number(slider.value); value.textContent = s.gainDb + ' dB'; levels(); };
    label.append('Gain ', slider); row.append(label, value);
    element('stems').append(row);
  }
  levels();

  function position() {
    return Math.min(duration, offset + (running ? Math.max(0, ctx.currentTime - startTime) : 0));
  }
  function stop() {
    offset = position(); running = false; revision++;
    for (const source of sources) { source.stop(); source.disconnect(); }
    sources = []; play.textContent = 'Play';
  }
  async function start() {
    const ticket = ++revision;
    running = true;
    startTime = Infinity;
    play.textContent = 'Pause';
    try {
      await ctx.resume();
      if (ticket !== revision) return;
      if (offset >= duration) offset = 0;
      for (const [i, buffer] of buffers.entries()) {
        if (offset >= buffer.duration) continue;
        const source = ctx.createBufferSource();
        const gain = gains[i];
        if (!gain) continue;
        source.buffer = buffer; source.connect(gain); sources.push(source);
      }
      startTime = ctx.currentTime + 0.05;
      for (const source of sources) source.start(startTime, offset);
    } catch (e) {
      if (ticket === revision) { stop(); status.textContent = String(e); }
    }
  }
  function seek(t: number) {
    const resume = running;
    stop(); offset = Math.min(duration, Math.max(0, t));
    display();
    if (resume && offset < duration) void start();
  }
  function display() {
    const t = position();
    if (running && t >= duration) stop();
    scrub.value = String(t); clock.textContent = t.toFixed(2) + ' s';
  }
  play.onclick = () => running ? stop() : void start();
  scrub.oninput = () => seek(Number(scrub.value));
  const findingButtons = data.findings.map(f => {
    const button = document.createElement('button');
    const who = f.trackId ?? f.id;
    button.textContent = [f.timeS.toFixed(2) + ' s', f.code, who, ...(f.maskers ?? [])].filter(Boolean).join(' · ');
    button.onclick = () => seek(f.timeS); button.disabled = true;
    element('findings').append(button);
    return button;
  });
  element('copy').onclick = async () => {
    const tracks = data.stems.map(({ id, gainDb, mute, solo }) => ({ id, gainDb, mute, solo }));
    const json = JSON.stringify({ tracks }, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      fallback.hidden = true; status.textContent = 'Mix JSON copied.';
    } catch {
      fallback.value = json; fallback.hidden = false; fallback.select();
      status.textContent = 'Copy the selected mix JSON.';
    }
  };
  Promise.all(data.stems.map(async s => {
    const raw = atob(s.wav);
    return ctx.decodeAudioData(Uint8Array.from(raw, ch => ch.charCodeAt(0)).buffer);
  })).then(decoded => {
    buffers = decoded; duration = Math.max(...buffers.map(b => b.duration));
    scrub.max = String(duration); scrub.disabled = false; play.disabled = false;
    for (const b of findingButtons) b.disabled = false;
    status.textContent = '';
    function tick() { display(); requestAnimationFrame(tick); }
    tick();
  }).catch(e => { status.textContent = 'Could not decode the stems. ' + e; });
}

export function auditionHtml(stems: readonly AuditionStem[], findings: readonly AuditionFinding[] = []): string {
  if (!stems.length || new Set(stems.map(s => s.id)).size !== stems.length) throw new Error('Provide uniquely named WAV stems');
  if (findings.some(f => !Number.isFinite(f.timeS) || f.timeS < 0)) throw new RangeError('Invalid finding timestamp');
  const session: Session = {
    stems: stems.map(s => {
      const gainDb = s.gainDb ?? 0;
      if (!(gainDb >= -60 && gainDb <= 12)) throw new RangeError('Gain must be between -60 and +12 dB');
      return { id: s.id, wav: Buffer.from(s.wav).toString('base64'), gainDb, mute: s.mute ?? false, solo: s.solo ?? false };
    }), findings
  };
  const payload = JSON.stringify(session).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stem audition</title><style>
:root{color-scheme:dark;font:16px system-ui;background:#15191c;color:#f5f1e9}body{max-width:54rem;margin:auto;padding:2rem 1rem}
h1{font-size:2rem}fieldset{margin:1rem 0;border:1px solid #586265;border-radius:.4rem;padding:1rem}legend{padding:0 .4rem}
label,button,output{margin-right:.75rem}label{display:inline-flex;align-items:center;gap:.3rem}input{accent-color:#a3d9bb}
button{padding:.45rem .75rem}#findings{display:flex;flex-wrap:wrap;gap:.4rem;margin:1rem 0}textarea{width:100%;height:10rem}
</style><h1>Stem audition</h1><button id="play" disabled>Play</button><label>Position <input id="time" type="range" min="0" value="0" step=".001" disabled></label><output id="clock">0.00 s</output>
<section id="stems" aria-label="Stems"></section><section id="findings" aria-label="Findings"></section>
<button id="copy">Copy Mix JSON</button><p id="status" role="status">Loading stems…</p><textarea hidden readonly id="json" aria-label="Mix JSON"></textarea>
<script type="application/json" id="session">${payload}</script><script>(${audition.toString()})();</script></html>`;
}
