// Moteur principal : WebCodecs via Mediabunny (accéléré par le matériel).
// Bascule vers ffmpeg.wasm pour les formats que le navigateur ne sait pas décoder.

import {
  Input, Output, Conversion, BlobSource, BufferTarget, Mp4OutputFormat,
  ALL_FORMATS, Quality, canEncodeVideo, canEncodeAudio, ConversionCanceledError,
} from 'mediabunny';
import { planForTarget, nextVideoBitrate, scaledSize, MB } from './planner.js';
import * as ffmpegEngine from './ffmpeg-engine.js';

export const CODEC_LABELS = { avc: 'H.264', hevc: 'H.265', av1: 'AV1' };

export class CanceledError extends Error {
  constructor() { super('Compression annulée'); this.name = 'CanceledError'; }
}

const hasWebCodecs = typeof window !== 'undefined' && 'VideoEncoder' in window && 'VideoDecoder' in window;

/** Codecs de sortie que ce navigateur sait encoder (testé en 1080p). */
export async function detectEncoders() {
  const result = { avc: false, hevc: false, av1: false };
  if (!hasWebCodecs) return result;
  await Promise.all(Object.keys(result).map(async (codec) => {
    try {
      result[codec] = await canEncodeVideo(codec, { width: 1920, height: 1080, quality: new Quality({ bitrate: 4_000_000 }) });
    } catch { result[codec] = false; }
  }));
  return result;
}

/** Lit les infos d'une vidéo et choisit le moteur capable de la traiter. */
export async function probe(file, onEngineProgress) {
  if (hasWebCodecs) {
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    try {
      const video = await input.getPrimaryVideoTrack();
      if (video && (await video.canDecode())) {
        const [duration, width, height, stats, audioTracks] = await Promise.all([
          input.computeDuration(),
          video.getDisplayWidth(),
          video.getDisplayHeight(),
          video.computePacketStats(120),
          input.getAudioTracks(),
        ]);
        return {
          engine: 'webcodecs',
          duration,
          width,
          height,
          fps: stats.averagePacketRate || 30,
          hasAudio: audioTracks.length > 0,
          sourceCodec: video.codec,
        };
      }
    } catch { /* format non lu : on tente ffmpeg */ } finally {
      input.dispose?.();
    }
  }
  const info = await ffmpegEngine.probe(file, onEngineProgress);
  return { ...info, engine: 'ffmpeg' };
}

let aacReady = null;
/** AAC natif si dispo, sinon encodeur AAC en WebAssembly, sinon Opus. */
async function pickAudioCodec() {
  if (!aacReady) {
    aacReady = (async () => {
      try { if (await canEncodeAudio('aac')) return 'aac'; } catch { /* ignore */ }
      try {
        const { registerAacEncoder } = await import('mediabunny-aac-encoder');
        registerAacEncoder();
        return 'aac';
      } catch {
        return (await canEncodeAudio('opus').catch(() => false)) ? 'opus' : null;
      }
    })();
  }
  return aacReady;
}

async function resolveVideoCodec(wanted, width, height, bitrate) {
  const order = [wanted, 'avc'].filter((c, i, a) => a.indexOf(c) === i);
  for (const codec of order) {
    const quality = new Quality(bitrate ? { bitrate } : 'high');
    if (await canEncodeVideo(codec, { width, height, quality }).catch(() => false)) return codec;
  }
  return null;
}

/** Une passe d'encodage Mediabunny. Renvoie un Blob MP4. */
async function encodeOnce(file, p, { onProgress, signal }) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });

  const video = {
    codec: p.codec,
    width: p.width,
    quality: p.videoBps
      ? new Quality({ bitrate: p.videoBps, bitrateMode: 'variable' })
      : new Quality({ quality: p.qualityLevel }),
    forceTranscode: true,
  };
  if (p.fps) video.frameRate = p.fps;

  const audio = p.removeAudio || !p.audioCodec
    ? { discard: true }
    : {
        codec: p.audioCodec,
        quality: p.audioBps ? new Quality({ bitrate: p.audioBps }) : new Quality('medium'),
        forceTranscode: Boolean(p.audioBps),
      };

  const conversion = await Conversion.init({ input, output, tracks: 'primary', video, audio, showWarnings: false });
  if (!conversion.isValid || !conversion.utilizedTracks.some((t) => t.type === 'video')) {
    input.dispose?.();
    throw new Error('Cette vidéo ne peut pas être réencodée par le navigateur.');
  }

  conversion.onProgress = (progress) => onProgress?.(progress);
  const abort = () => conversion.cancel();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await conversion.execute();
  } catch (err) {
    if (err instanceof ConversionCanceledError || signal?.aborted) throw new CanceledError();
    throw err;
  } finally {
    signal?.removeEventListener('abort', abort);
    input.dispose?.();
  }
  return new Blob([target.buffer], { type: 'video/mp4' });
}

/**
 * Compresse un fichier selon les réglages.
 * settings = { mode: 'target'|'quality', targetMB, quality (0–100), maxWidth, codec, removeAudio }
 * report(event) reçoit { phase, progress, attempt, plan, message }
 */
export async function compress(file, info, settings, report, signal) {
  if (info.engine === 'ffmpeg') return ffmpegEngine.compress(file, info, settings, report, signal);

  const audioCodec = settings.removeAudio || !info.hasAudio ? null : await pickAudioCodec();
  const removeAudio = settings.removeAudio || !audioCodec;

  if (settings.mode === 'quality') {
    const { width, height } = scaledSize(info.width, info.height, Math.min(info.width, settings.maxWidth || Infinity));
    const codec = await resolveVideoCodec(settings.codec, width, height);
    if (!codec) return ffmpegEngine.compress(file, info, settings, report, signal);
    const plan = { codec, width, height, quality: null };
    report({ phase: 'encoding', progress: 0, attempt: 1, plan });
    const blob = await encodeOnce(file, {
      codec, width, removeAudio, audioCodec,
      qualityLevel: 0.15 + (settings.quality / 100) * 0.85,
    }, { signal, onProgress: (x) => report({ phase: 'encoding', progress: x, attempt: 1, plan }) });
    return { blob, plan, attempts: 1 };
  }

  // Mode taille cible
  const targetBytes = Math.floor(settings.targetMB * MB);
  let plan = planForTarget({
    targetBytes,
    duration: info.duration,
    srcW: info.width,
    srcH: info.height,
    fps: info.fps,
    hasAudio: info.hasAudio,
    removeAudio,
    codec: settings.codec,
    maxWidth: settings.maxWidth || Infinity,
  });
  if (!plan.ok) {
    const err = new Error(`Taille trop petite pour cette vidéo. Minimum conseillé : ${(plan.minBytes / MB).toFixed(1)} Mo.`);
    err.minBytes = plan.minBytes;
    throw err;
  }

  const codec = await resolveVideoCodec(settings.codec, plan.width, plan.height, plan.videoBps);
  if (!codec) return ffmpegEngine.compress(file, info, settings, report, signal);
  if (codec !== settings.codec) {
    // Le codec demandé n'est pas dispo : on recalcule pour H.264.
    plan = planForTarget({ targetBytes, duration: info.duration, srcW: info.width, srcH: info.height, fps: info.fps, hasAudio: info.hasAudio, removeAudio, codec, maxWidth: settings.maxWidth || Infinity });
  }
  plan.codec = codec;

  const MAX_ATTEMPTS = 4;
  let best = null;
  let last = null;
  let videoBps = plan.videoBps;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const current = { ...plan, videoBps };
    report({ phase: 'encoding', progress: 0, attempt, plan: current });
    const blob = await encodeOnce(file, {
      codec,
      width: plan.width,
      fps: plan.reducedFps ? plan.fps : undefined,
      videoBps,
      audioBps: plan.audioBps,
      audioCodec,
      removeAudio,
    }, { signal, onProgress: (x) => report({ phase: 'encoding', progress: x, attempt, plan: current }) });

    last = { blob, plan: current, attempts: attempt };
    if (blob.size <= targetBytes && (!best || blob.size > best.blob.size)) best = last;

    const next = nextVideoBitrate({
      targetBytes, resultBytes: blob.size, videoBps, audioBps: plan.audioBps, duration: info.duration, attempt,
    });
    if (next === null) break;
    // Si on est déjà dans la cible et que la passe suivante ne gagnerait presque rien, on s'arrête.
    if (blob.size <= targetBytes && next < videoBps * 1.08) break;
    if (attempt < MAX_ATTEMPTS) {
      report({ phase: 'adjusting', attempt, size: blob.size, targetBytes });
      videoBps = next;
    }
  }

  if (best) return { ...best, attempts: last.attempts };
  return { ...last, overTarget: true };
}
