// Moteur de secours : FFmpeg compilé en WebAssembly (ffmpeg.wasm).
// Plus lent que WebCodecs, mais lit presque tous les formats (AVI, MPEG, WMV, FLV…).
// Le cœur (~32 Mo) n'est téléchargé que la première fois qu'on en a besoin.

import { FFmpeg } from '../vendor/ffmpeg/index.js';
import { toBlobURL } from '../vendor/ffmpeg-util/index.js';
import { planForTarget, nextVideoBitrate, scaledSize, qualityToCrf, MB } from './planner.js';

// Le cœur est cherché d'abord dans vendor/ffmpeg-core/ (si vous l'y avez copié
// pour un fonctionnement 100 % hors ligne), sinon sur le CDN jsDelivr.
const CORE_SOURCES = [
  new URL('../vendor/ffmpeg-core/', import.meta.url).href,
  'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/',
];

async function fetchCore(onProgress) {
  let lastError;
  for (const base of CORE_SOURCES) {
    try {
      const head = await fetch(`${base}ffmpeg-core.js`, { method: 'HEAD' });
      if (!head.ok) throw new Error(`${head.status} sur ${base}`);
      return await Promise.all([
        toBlobURL(`${base}ffmpeg-core.js`, 'text/javascript'),
        toBlobURL(`${base}ffmpeg-core.wasm`, 'application/wasm', true, onProgress),
      ]);
    } catch (err) { lastError = err; }
  }
  throw new Error(`Impossible de télécharger le lecteur universel (${lastError?.message}). Vérifiez votre connexion.`);
}

let ffmpeg = null;
let loading = null;
let queue = Promise.resolve();
let logListener = null;
let mountCounter = 0;

/** Exécute les opérations FFmpeg une par une (une seule instance partagée). */
function exclusive(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

async function load(onProgress) {
  if (ffmpeg) return ffmpeg;
  if (!loading) {
    loading = (async () => {
      const instance = new FFmpeg();
      instance.on('log', ({ message }) => logListener?.(message));
      let received = 0;
      const progress = ({ received: r, total }) => {
        received = r;
        onProgress?.(total > 0 ? r / total : Math.min(0.95, received / 32_500_000));
      };
      const [coreURL, wasmURL] = await fetchCore(progress);
      await instance.load({ coreURL, wasmURL });
      ffmpeg = instance;
      return instance;
    })().catch((err) => { loading = null; throw err; });
  }
  return loading;
}

/** Monte le fichier sans le copier en mémoire (WORKERFS). */
async function withMountedFile(file, fn) {
  const dir = `/in${++mountCounter}`;
  await ffmpeg.createDir(dir);
  await ffmpeg.mount('WORKERFS', { files: [file] }, dir);
  try {
    return await fn(`${dir}/${file.name}`);
  } finally {
    await ffmpeg.unmount(dir).catch(() => {});
    await ffmpeg.deleteDir(dir).catch(() => {});
  }
}

async function runCollectingLogs(args, onLine) {
  const lines = [];
  logListener = (line) => { lines.push(line); onLine?.(line); };
  try {
    const code = await ffmpeg.exec(args);
    return { code, lines };
  } finally {
    logListener = null;
  }
}

const parseTime = (s) => {
  const m = /(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(s);
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : NaN;
};

export async function probe(file, onEngineProgress) {
  await load(onEngineProgress);
  return exclusive(() => withMountedFile(file, async (path) => {
    const { lines } = await runCollectingLogs(['-hide_banner', '-i', path]);
    const text = lines.join('\n');
    const duration = parseTime(/Duration:\s*([\d:.]+)/.exec(text)?.[1] ?? '');
    const videoLine = lines.find((l) => /Stream #.*Video:/.test(l));
    if (!videoLine || !isFinite(duration)) throw new Error('Aucune piste vidéo lisible dans ce fichier.');
    const dims = /,\s*(\d{2,5})x(\d{2,5})/.exec(videoLine);
    let width = dims ? +dims[1] : 1280;
    let height = dims ? +dims[2] : 720;
    const rotation = /rotation of (-?\d+(?:\.\d+)?)/.exec(text);
    if (rotation && Math.abs(Math.round(+rotation[1])) % 180 === 90) [width, height] = [height, width];
    const fps = parseFloat(/([\d.]+)\s*fps/.exec(videoLine)?.[1] ?? /([\d.]+)\s*tbr/.exec(videoLine)?.[1] ?? '30') || 30;
    const sourceCodec = /Video:\s*(\w+)/.exec(videoLine)?.[1] ?? null;
    return { duration, width, height, fps, hasAudio: lines.some((l) => /Stream #.*Audio:/.test(l)), sourceCodec };
  }));
}

function buildArgs(path, out, p) {
  const filters = [];
  if (p.width) filters.push(`scale=${p.width}:-2:flags=lanczos`);
  if (p.fps) filters.push(`fps=${p.fps}`);
  const args = ['-hide_banner', '-y', '-i', path, '-map', '0:v:0', '-map', '0:a:0?'];
  if (filters.length) args.push('-vf', filters.join(','));
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p');
  if (p.videoBps) {
    const k = Math.round(p.videoBps / 1000);
    args.push('-b:v', `${k}k`, '-maxrate', `${Math.round(k * 1.5)}k`, '-bufsize', `${k * 2}k`);
  } else {
    args.push('-crf', String(p.crf));
  }
  if (p.removeAudio) args.push('-an');
  else args.push('-c:a', 'aac', '-b:a', `${Math.round((p.audioBps || 128_000) / 1000)}k`);
  args.push('-movflags', '+faststart', out);
  return args;
}

async function encodeOnce(file, info, p, onProgress, signal) {
  return exclusive(() => withMountedFile(file, async (path) => {
    const out = `/out-${mountCounter}.mp4`;
    const onAbort = () => {
      // Arrêter FFmpeg impose de recharger l'instance.
      ffmpeg?.terminate();
      ffmpeg = null;
      loading = null;
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const { code, lines } = await runCollectingLogs(buildArgs(path, out, p), (line) => {
        const t = /time=\s*([\d:.]+)/.exec(line);
        if (t) onProgress?.(Math.min(1, parseTime(t[1]) / info.duration));
      });
      if (signal?.aborted) throw Object.assign(new Error('Compression annulée'), { name: 'CanceledError' });
      if (code !== 0) throw new Error(`FFmpeg a échoué : ${lines.slice(-3).join(' ')}`);
      const data = await ffmpeg.readFile(out);
      await ffmpeg.deleteFile(out).catch(() => {});
      return new Blob([data.buffer], { type: 'video/mp4' });
    } catch (err) {
      if (signal?.aborted) throw Object.assign(new Error('Compression annulée'), { name: 'CanceledError' });
      throw err;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }));
}

export async function compress(file, info, settings, report, signal) {
  await load((x) => report({ phase: 'loading-engine', progress: x }));
  const removeAudio = settings.removeAudio || !info.hasAudio;
  const maxWidth = settings.maxWidth || Infinity;

  if (settings.mode === 'quality') {
    const { width, height } = scaledSize(info.width, info.height, Math.min(info.width, maxWidth));
    const plan = { codec: 'avc', width, height, engine: 'ffmpeg' };
    report({ phase: 'encoding', progress: 0, attempt: 1, plan });
    const blob = await encodeOnce(file, info, {
      width: width < info.width ? width : null, crf: qualityToCrf(settings.quality), removeAudio,
    }, (x) => report({ phase: 'encoding', progress: x, attempt: 1, plan }), signal);
    return { blob, plan, attempts: 1 };
  }

  const targetBytes = Math.floor(settings.targetMB * MB);
  const plan = planForTarget({
    targetBytes, duration: info.duration, srcW: info.width, srcH: info.height, fps: info.fps,
    hasAudio: info.hasAudio, removeAudio, codec: 'avc', maxWidth,
  });
  if (!plan.ok) {
    const err = new Error(`Taille trop petite pour cette vidéo. Minimum conseillé : ${(plan.minBytes / MB).toFixed(1)} Mo.`);
    err.minBytes = plan.minBytes;
    throw err;
  }
  plan.codec = 'avc';
  plan.engine = 'ffmpeg';

  // FFmpeg tient bien le débit demandé : 3 passes maximum suffisent.
  let videoBps = plan.videoBps, best = null, last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const current = { ...plan, videoBps };
    report({ phase: 'encoding', progress: 0, attempt, plan: current });
    const blob = await encodeOnce(file, info, {
      width: plan.reducedResolution ? plan.width : null,
      fps: plan.reducedFps ? plan.fps : null,
      videoBps, audioBps: plan.audioBps, removeAudio,
    }, (x) => report({ phase: 'encoding', progress: x, attempt, plan: current }), signal);
    last = { blob, plan: current, attempts: attempt };
    if (blob.size <= targetBytes && (!best || blob.size > best.blob.size)) best = last;
    const next = nextVideoBitrate({ targetBytes, resultBytes: blob.size, videoBps, audioBps: plan.audioBps, duration: info.duration, attempt });
    if (next === null || (blob.size <= targetBytes && next < videoBps * 1.08)) break;
    report({ phase: 'adjusting', attempt, size: blob.size, targetBytes });
    videoBps = next;
  }
  return best ? { ...best, attempts: last.attempts } : { ...last, overTarget: true };
}
