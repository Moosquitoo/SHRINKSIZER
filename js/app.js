import { probe, compress, detectEncoders, CODEC_LABELS } from './engine.js';
import { planForTarget, scaledSize, formatBytes, formatDuration, MB } from './planner.js';

const $ = (sel, root = document) => root.querySelector(sel);

const els = {
  input: $('#file-input'),
  zone: $('#drop-zone'),
  items: $('#items'),
  template: $('#item-template'),
  queueHead: $('.queue-head'),
  runAll: $('#run-all'),
  clearDone: $('#clear-done'),
  target: $('#target-mb'),
  presets: [...document.querySelectorAll('.presets button')],
  quality: $('#quality'),
  maxRes: $('#max-res'),
  codec: $('#codec'),
  removeAudio: $('#remove-audio'),
  codecNote: $('#codec-note'),
  notice: $('#support-notice'),
};

const items = [];
let encoders = { avc: false, hevc: false, av1: false };
let running = false;

/* ---------------- Réglages ---------------- */

const STORAGE_KEY = 'shrinksizer:settings';

function readSettings() {
  return {
    mode: document.querySelector('input[name="mode"]:checked').value,
    targetMB: Math.max(0.1, parseFloat(String(els.target.value).replace(',', '.')) || 25),
    quality: +els.quality.value,
    maxRes: els.maxRes.value,
    codec: els.codec.value,
    removeAudio: els.removeAudio.checked,
  };
}

function saveSettings() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(readSettings())); } catch { /* stockage indisponible */ }
}

function restoreSettings() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { /* ignore */ }
  if (!s) return;
  const radio = document.querySelector(`input[name="mode"][value="${s.mode}"]`);
  if (radio) radio.checked = true;
  if (s.targetMB) els.target.value = s.targetMB;
  if (s.quality != null) els.quality.value = s.quality;
  if (s.maxRes) els.maxRes.value = s.maxRes;
  if (s.codec) els.codec.value = s.codec;
  els.removeAudio.checked = Boolean(s.removeAudio);
}

/** Largeur maximale de sortie pour une résolution « 1080p » donnée (côté court). */
function maxWidthFor(info, maxRes) {
  if (maxRes === 'auto') return Infinity;
  const shortSide = Math.min(info.width, info.height);
  const factor = Math.min(1, +maxRes / shortSide);
  return Math.round(info.width * factor);
}

function settingsFor(item) {
  const s = readSettings();
  return { ...s, maxWidth: maxWidthFor(item.info, s.maxRes) };
}

function effectiveCodec(wanted, item) {
  if (item.info?.engine === 'ffmpeg') return 'avc';
  return encoders[wanted] ? wanted : 'avc';
}

function fitTargetInput() {
  els.target.style.width = `${Math.max(1.6, String(els.target.value).length + 0.25)}ch`;
}

function onSettingsChange() {
  fitTargetInput();
  const { mode, targetMB } = readSettings();
  document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.dataset.mode !== mode; });
  els.presets.forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.mb === targetMB)));
  updateCodecNote();
  saveSettings();
  items.forEach((item) => { if (item.status !== 'encoding') renderItem(item); });
}

function updateCodecNote() {
  const wanted = els.codec.value;
  const notes = {
    hevc: "H.265 donne des fichiers plus légers, mais certains appareils et sites ne le lisent pas.",
    av1: "AV1 donne les fichiers les plus légers ; les appareils anciens ne le lisent pas toujours.",
  };
  if (wanted !== 'avc' && !encoders[wanted]) {
    els.codecNote.textContent = `Votre navigateur ne sait pas encoder en ${CODEC_LABELS[wanted]} : vos vidéos seront produites en H.264.`;
  } else {
    els.codecNote.textContent = notes[wanted] ?? '';
  }
}

/* ---------------- File d'attente ---------------- */

let nextId = 1;

function addFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith('video/') || /\.(mkv|avi|mov|mpe?g|wmv|flv|3gp|ts|m2ts|mts|webm|mp4|m4v)$/i.test(f.name));
  for (const file of files) {
    const node = els.template.content.firstElementChild.cloneNode(true);
    const item = { id: nextId++, file, node, status: 'probing', info: null, result: null, error: null, controller: null };
    items.push(item);
    els.items.append(node);
    wireItem(item);
    renderItem(item);
    probeItem(item);
  }
  els.queueHead.hidden = items.length === 0;
}

async function probeItem(item) {
  try {
    item.info = await probe(item.file, (x) => {
      item.engineLoading = x;
      renderItem(item);
    });
    item.engineLoading = null;
    item.status = 'ready';
  } catch (err) {
    item.status = 'error';
    item.error = "Impossible de lire cette vidéo. Le fichier est peut-être abîmé ou dans un format inconnu.";
    console.error(err);
  }
  renderItem(item);
}

function removeItem(item) {
  item.controller?.abort();
  if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);
  if (item.sourceUrl) URL.revokeObjectURL(item.sourceUrl);
  item.node.remove();
  items.splice(items.indexOf(item), 1);
  els.queueHead.hidden = items.length === 0;
  updateQueueButtons();
}

function wireItem(item) {
  const n = item.node;
  $('.remove', n).addEventListener('click', () => removeItem(item));
  $('.compress', n).addEventListener('click', () => runItem(item));
  $('.redo', n).addEventListener('click', () => runItem(item));
  $('.cancel', n).addEventListener('click', () => item.controller?.abort());
  $('.compare', n).addEventListener('click', () => toggleCompare(item));
}

function alreadyUnderTarget(item, s) {
  return s.mode === 'target' && item.file.size <= s.targetMB * MB;
}

/* ---------------- Rendu d'un fichier ---------------- */

function setText(el, text) { if (el.textContent !== text) el.textContent = text; }

function renderItem(item) {
  const n = item.node;
  const s = item.info ? settingsFor(item) : readSettings();
  n.dataset.status = item.status;
  n.classList.toggle('over', Boolean(item.result?.overTarget));

  setText($('.item-name', n), item.file.name);

  // Infos de la source
  const meta = $('.item-meta', n);
  const parts = [formatBytes(item.file.size)];
  if (item.info) {
    parts.push(`${item.info.width}×${item.info.height}`);
    parts.push(formatDuration(item.info.duration));
    parts.push(`${Math.round(item.info.fps)} i/s`);
    if (!item.info.hasAudio) parts.push('sans son');
  } else if (item.status === 'probing') {
    parts.push(item.engineLoading != null ? `chargement du lecteur universel, ${Math.round(item.engineLoading * 100)} %` : 'lecture…');
  }
  meta.replaceChildren(...parts.map((t) => Object.assign(document.createElement('span'), { textContent: t })));

  // Jauge
  const original = item.file.size;
  const fill = $('.gauge-fill', n);
  const marker = $('.gauge-target', n);
  $('.gauge-scale .from', n).textContent = '0';
  $('.gauge-scale .to', n).textContent = `Original ${formatBytes(original)}`;
  if (item.status === 'done' && item.result) {
    fill.style.width = `${Math.min(100, (item.result.blob.size / original) * 100)}%`;
  } else {
    fill.style.width = '100%';
  }
  const showMarker = s.mode === 'target' && s.targetMB * MB < original;
  const markerTarget = item.status === 'done' && item.result?.targetMB ? item.result.targetMB : s.targetMB;
  marker.hidden = !showMarker && !(item.status === 'done' && item.result?.targetMB);
  if (!marker.hidden) {
    const pct = Math.min(100, ((markerTarget * MB) / original) * 100);
    marker.style.left = `${pct}%`;
    marker.classList.toggle('edge-left', pct < 12);
    marker.classList.toggle('edge-right', pct > 88);
    $('span', marker).textContent = `Cible ${formatBytes(markerTarget * MB)}`;
  }

  // Plan prévu
  const planEl = $('.item-plan', n);
  if (item.status === 'ready' && item.info) {
    planEl.replaceChildren(...describePlan(item, s));
  } else if (item.status === 'encoding' && item.livePlan) {
    planEl.replaceChildren(...planTags(item.livePlan, item));
  } else if (item.status !== 'done') {
    planEl.replaceChildren();
  }

  // Boutons
  const busy = item.status === 'encoding';
  const done = item.status === 'done';
  const under = item.info && alreadyUnderTarget(item, s);
  const compressBtn = $('.compress', n);
  compressBtn.hidden = done || busy || item.status === 'error';
  compressBtn.disabled = item.status !== 'ready' || under || running;
  $('.cancel', n).hidden = !busy;
  $('.download', n).hidden = !done;
  $('.compare', n).hidden = !done;
  $('.redo', n).hidden = !done || running;
  $('.item-progress', n).hidden = !busy;

  if (item.status === 'error') setText($('.item-result', n), item.error);
  else if (!done) {
    setText($('.item-result', n), under && item.status === 'ready'
      ? 'Ce fichier est déjà sous la taille visée. Baissez la cible ou passez en « Régler la qualité » pour l\'alléger.'
      : '');
  }
  updateQueueButtons();
}

function tag(text) { return Object.assign(document.createElement('span'), { className: 'tag', textContent: text }); }

function planTags(plan, item) {
  const out = [tag(`${plan.width}×${plan.height}`)];
  if (plan.fps && plan.reducedFps) out.push(tag(`${plan.fps} i/s`));
  out.push(tag(CODEC_LABELS[plan.codec] ?? 'H.264'));
  if (plan.videoBps) out.push(tag(`${(plan.videoBps / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} Mb/s`));
  if (item.info?.engine === 'ffmpeg') out.push(tag('lecteur universel'));
  return out;
}

function describePlan(item, s) {
  const codec = effectiveCodec(s.codec, item);
  if (s.mode === 'quality') {
    const { width, height } = scaledSize(item.info.width, item.info.height, Math.min(item.info.width, s.maxWidth));
    return [document.createTextNode('Sortie : '), ...planTags({ width, height, codec }, item)];
  }
  if (alreadyUnderTarget(item, s)) return [];
  const plan = planForTarget({
    targetBytes: s.targetMB * MB,
    duration: item.info.duration,
    srcW: item.info.width,
    srcH: item.info.height,
    fps: item.info.fps,
    hasAudio: item.info.hasAudio,
    removeAudio: s.removeAudio,
    codec,
    maxWidth: s.maxWidth,
  });
  if (!plan.ok) {
    const min = Math.ceil((plan.minBytes / MB) * 10) / 10;
    return [document.createTextNode(`Cible trop petite pour ${formatDuration(item.info.duration)} de vidéo : visez au moins ${min.toLocaleString('fr-FR')} Mo.`)];
  }
  const nodes = [document.createTextNode('Prévu : '), ...planTags({ ...plan, codec }, item)];
  nodes.push(document.createTextNode(` qualité attendue ${plan.quality}.`));
  return nodes;
}

function updateQueueButtons() {
  const pending = items.filter((i) => i.status === 'ready' && !alreadyUnderTarget(i, readSettings()));
  els.runAll.disabled = running || pending.length === 0;
  els.runAll.textContent = running ? 'Compression en cours…' : pending.length > 1 ? `Tout compresser (${pending.length})` : 'Tout compresser';
  els.clearDone.hidden = !items.some((i) => i.status === 'done');
}

/* ---------------- Compression ---------------- */

async function runItem(item) {
  if (running || !item.info) return;
  running = true;
  items.forEach(renderItem);
  try {
    await compressItem(item);
  } finally {
    running = false;
    items.forEach(renderItem);
  }
}

async function runAll() {
  if (running) return;
  running = true;
  items.forEach(renderItem);
  try {
    for (const item of items.slice()) {
      if (item.status === 'ready' && items.includes(item) && !alreadyUnderTarget(item, readSettings())) {
        await compressItem(item);
      }
    }
  } finally {
    running = false;
    items.forEach(renderItem);
  }
}

async function compressItem(item) {
  const settings = settingsFor(item);
  item.controller = new AbortController();
  item.status = 'encoding';
  item.livePlan = null;
  if (item.resultUrl) { URL.revokeObjectURL(item.resultUrl); item.resultUrl = null; }
  closeCompare(item);
  renderItem(item);

  const n = item.node;
  const bar = $('.item-progress .bar div', n);
  const progressEl = $('.item-progress', n);
  const text = $('.progress-text', n);
  const started = performance.now();
  let passStarted = started;
  let lastPass = 0;

  const report = (e) => {
    if (e.phase === 'loading-engine') {
      bar.style.width = `${Math.round(e.progress * 100)}%`;
      text.textContent = `Chargement du lecteur universel (une seule fois) : ${Math.round(e.progress * 100)} %`;
      return;
    }
    if (e.phase === 'adjusting') {
      const over = e.size > e.targetBytes;
      text.textContent = over
        ? `${formatBytes(e.size)} : un peu au-dessus de ${formatBytes(e.targetBytes)}, nouvelle passe plus légère…`
        : `${formatBytes(e.size)} : il reste de la marge, nouvelle passe avec plus de qualité…`;
      return;
    }
    if (e.attempt !== lastPass) { lastPass = e.attempt; passStarted = performance.now(); }
    if (e.plan && e.plan !== item.livePlan) { item.livePlan = e.plan; renderItem(item); }
    const pct = Math.round(e.progress * 100);
    bar.style.width = `${pct}%`;
    progressEl.setAttribute('aria-valuenow', String(pct));
    const elapsed = (performance.now() - passStarted) / 1000;
    let eta = '';
    if (e.progress > 0.04 && elapsed > 2) {
      const remaining = (elapsed / e.progress) * (1 - e.progress);
      eta = remaining < 60 ? `, environ ${Math.max(1, Math.round(remaining))} s restantes` : `, environ ${Math.round(remaining / 60)} min restantes`;
    }
    text.textContent = `${e.attempt > 1 ? `Passe ${e.attempt} : ` : ''}${pct} %${eta}`;
  };

  try {
    const result = await compress(item.file, item.info, settings, report, item.controller.signal);
    item.result = { ...result, targetMB: settings.mode === 'target' ? settings.targetMB : null, seconds: (performance.now() - started) / 1000 };
    item.status = 'done';
    item.resultUrl = URL.createObjectURL(result.blob);
    showResult(item, settings);
  } catch (err) {
    if (err.name === 'CanceledError' || item.controller.signal.aborted) {
      item.status = 'ready';
    } else {
      console.error(err);
      item.status = 'error';
      item.error = err.minBytes
        ? err.message
        : `La compression a échoué : ${err.message || err}. Essayez le format H.264 ou une résolution plus basse.`;
    }
  } finally {
    item.controller = null;
    item.livePlan = null;
    renderItem(item);
  }
}

function outputName(file) {
  const base = file.name.replace(/\.[^.]+$/, '');
  return `${base}-shrink.mp4`;
}

function showResult(item, settings) {
  const n = item.node;
  const { blob, plan, overTarget } = item.result;
  const original = item.file.size;
  const saved = 1 - blob.size / original;

  const dl = $('.download', n);
  dl.href = item.resultUrl;
  dl.download = outputName(item.file);
  dl.textContent = `Télécharger (${formatBytes(blob.size)})`;

  const res = $('.item-result', n);
  res.replaceChildren();
  const strong = document.createElement('strong');
  strong.textContent = formatBytes(blob.size);
  res.append(strong);
  if (saved > 0) {
    res.append(document.createTextNode(` soit ${Math.round(saved * 100)} % de moins que l'original, en ${formatDuration(item.result.seconds)}.`));
  } else {
    res.append(document.createTextNode(' '));
    res.append(Object.assign(document.createElement('span'), { className: 'warn', textContent: "L'original était déjà plus léger : gardez-le, ou baissez la qualité." }));
  }
  if (overTarget) {
    res.append(document.createElement('br'));
    res.append(Object.assign(document.createElement('span'), {
      className: 'warn',
      textContent: `Impossible de descendre sous ${formatBytes(settings.targetMB * MB)} avec ces réglages. Essayez une résolution plus basse ou retirez le son.`,
    }));
  }

  $('.item-plan', n).replaceChildren(document.createTextNode('Sortie : '), ...planTags(plan, item));
}

/* ---------------- Comparaison avant / après ---------------- */

function closeCompare(item) {
  const n = item.node;
  const panel = $('.compare-panel', n);
  if (panel.hidden) return;
  panel.hidden = true;
  $('.compare', n).setAttribute('aria-expanded', 'false');
  $('.compare', n).textContent = 'Comparer avant / après';
  for (const v of panel.querySelectorAll('video')) { v.pause(); v.removeAttribute('src'); v.load(); }
}

function toggleCompare(item) {
  const n = item.node;
  const panel = $('.compare-panel', n);
  if (!panel.hidden) { closeCompare(item); return; }

  panel.hidden = false;
  $('.compare', n).setAttribute('aria-expanded', 'true');
  $('.compare', n).textContent = 'Fermer la comparaison';

  const before = $('.v-before', panel);
  const after = $('.v-after', panel);
  const stage = $('.compare-stage', panel);
  const slider = $('.compare-slider input', panel);
  const play = $('.play', panel);

  if (!item.sourceUrl) item.sourceUrl = URL.createObjectURL(item.file);
  before.src = item.sourceUrl;
  after.src = item.resultUrl;
  stage.style.aspectRatio = `${item.info.width} / ${item.info.height}`;

  let beforeOk = true;
  before.onerror = () => {
    beforeOk = false;
    stage.style.setProperty('--cut', '0%');
    slider.disabled = true;
    $('.compare-tag.before', stage).textContent = 'Original non lisible ici';
  };

  if (!panel.dataset.wired) {
    panel.dataset.wired = '1';
    slider.addEventListener('input', () => stage.style.setProperty('--cut', `${slider.value}%`));
    // Glisser directement sur l'image
    const fromPointer = (ev) => {
      const r = stage.getBoundingClientRect();
      const pct = Math.max(0, Math.min(100, ((ev.clientX - r.left) / r.width) * 100));
      slider.value = String(Math.round(pct));
      stage.style.setProperty('--cut', `${pct}%`);
    };
    stage.addEventListener('pointerdown', (ev) => { stage.setPointerCapture(ev.pointerId); fromPointer(ev); });
    stage.addEventListener('pointermove', (ev) => { if (stage.hasPointerCapture(ev.pointerId)) fromPointer(ev); });

    play.addEventListener('click', () => {
      const b = $('.v-before', panel), a = $('.v-after', panel);
      if (a.paused) {
        b.currentTime = a.currentTime;
        a.play();
        if (beforeOk) b.play().catch(() => {});
        play.textContent = 'Pause';
      } else {
        a.pause(); b.pause();
        play.textContent = 'Lire';
      }
    });
    after.addEventListener('ended', () => { before.pause(); play.textContent = 'Lire'; });
    // Garder les deux vidéos synchronisées
    after.addEventListener('timeupdate', () => {
      if (beforeOk && !before.paused && Math.abs(before.currentTime - after.currentTime) > 0.15) before.currentTime = after.currentTime;
    });
  }
  slider.value = '50';
  slider.disabled = false;
  stage.style.setProperty('--cut', '50%');
  play.textContent = 'Lire';
}

/* ---------------- Glisser-déposer ---------------- */

function setupDrop() {
  let depth = 0;
  const over = (on) => els.zone.classList.toggle('over', on);
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { depth++; over(true); } });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) over(false); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0; over(false);
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });
  els.input.addEventListener('change', () => { addFiles(els.input.files); els.input.value = ''; });
}

/* ---------------- Démarrage ---------------- */

/** Sur GitHub Pages (utilisateur.github.io/depot), le lien pointe tout seul vers le dépôt. */
function linkRepo() {
  const m = /^([^.]+)\.github\.io$/.exec(location.hostname);
  if (!m) return;
  const repo = location.pathname.split('/').filter(Boolean)[0];
  $('#repo-link').href = `https://github.com/${m[1]}/${repo ?? `${m[1]}.github.io`}`;
}

async function init() {
  linkRepo();
  restoreSettings();
  setupDrop();

  document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', onSettingsChange));
  els.presets.forEach((b) => b.addEventListener('click', () => { els.target.value = b.dataset.mb; onSettingsChange(); }));
  for (const el of [els.target, els.quality, els.maxRes, els.codec, els.removeAudio]) {
    el.addEventListener('input', onSettingsChange);
    el.addEventListener('change', onSettingsChange);
  }
  els.runAll.addEventListener('click', runAll);
  els.clearDone.addEventListener('click', () => items.filter((i) => i.status === 'done').forEach(removeItem));

  window.addEventListener('beforeunload', (e) => { if (running) e.preventDefault(); });

  if (!('VideoEncoder' in window)) {
    els.notice.hidden = false;
    els.notice.textContent = "Votre navigateur ne prend pas en charge l'encodage vidéo matériel (WebCodecs). SHRINKSIZER fonctionnera quand même avec le lecteur universel, mais plus lentement. Chrome, Edge, Firefox et Safari récents sont plus rapides.";
  }

  encoders = await detectEncoders();
  for (const opt of els.codec.options) {
    if (opt.value !== 'avc' && !encoders[opt.value]) opt.textContent = `${opt.textContent.split(' (')[0]} (indisponible ici)`;
  }
  onSettingsChange();
}

init();
