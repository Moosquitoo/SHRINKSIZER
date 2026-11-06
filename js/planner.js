// Calcule les réglages d'encodage (débit, résolution, images/s) pour tenir
// dans une taille cible avec la meilleure qualité possible.
// Module pur : aucune dépendance au navigateur, testable avec Node.

/** Bits par pixel et par image (référence 1080p) en dessous desquels la qualité
 *  se dégrade visiblement, selon le codec. Les codecs récents ont besoin de moins. */
export const MIN_BPP = { avc: 0.05, hevc: 0.033, vp9: 0.035, av1: 0.026 };

/** Les petites images ont besoin de plus de bits par pixel que les grandes. */
export function bppThreshold(codec, width, height) {
  const base = MIN_BPP[codec] ?? MIN_BPP.avc;
  return base * Math.pow((1920 * 1080) / (width * height), 0.25);
}

/** Largeurs proposées quand il faut réduire la résolution. */
export const STANDARD_WIDTHS = [3840, 2560, 1920, 1600, 1440, 1280, 1024, 960, 854, 720, 640, 480, 426, 360, 320, 240];

const MIN_VIDEO_BPS = 40_000;

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** Débit audio adapté au budget total (bit/s). */
export function pickAudioBitrate(totalBps) {
  if (totalBps >= 2_000_000) return 128_000;
  if (totalBps >= 800_000) return 96_000;
  if (totalBps >= 300_000) return 64_000;
  return 48_000;
}

/** Estimation de l'enveloppe du conteneur MP4 (index des images, en-têtes). */
export function containerOverheadBytes(duration, fps, hasAudio) {
  const videoFrames = duration * fps;
  const audioFrames = hasAudio ? duration * 47 : 0; // ~47 trames AAC/s à 48 kHz
  return 8_192 + videoFrames * 18 + audioFrames * 10;
}

/** Dimensions de sortie pour une largeur donnée, en gardant le ratio. */
export function scaledSize(srcW, srcH, width) {
  const w = even(Math.min(width, srcW));
  return { width: w, height: even((w * srcH) / srcW) };
}

/**
 * Plan pour le mode « taille cible ».
 * @returns {{ok:true, videoBps, audioBps, width, height, fps, bpp, quality, reducedResolution, reducedFps}
 *          | {ok:false, reason, minBytes}}
 */
export function planForTarget({
  targetBytes, duration, srcW, srcH, fps = 30,
  hasAudio = true, removeAudio = false, codec = 'avc', maxWidth = Infinity,
  safety = 0.96,
}) {
  if (!(duration > 0)) return { ok: false, reason: 'duration', minBytes: 0 };
  const keepAudio = hasAudio && !removeAudio;
  const srcFps = fps > 0 && fps < 241 ? fps : 30;

  const overhead = containerOverheadBytes(duration, srcFps, keepAudio);
  const usableBits = (targetBytes - overhead) * 8 * safety;
  const totalBps = usableBits / duration;
  const audioBps = keepAudio ? Math.min(pickAudioBitrate(totalBps), Math.max(32_000, totalBps * 0.25)) : 0;
  const videoBps = Math.floor(totalBps - audioBps);

  if (videoBps < MIN_VIDEO_BPS) {
    const minBytes = Math.ceil(((MIN_VIDEO_BPS + (keepAudio ? 32_000 : 0)) * duration) / 8 / safety + overhead);
    return { ok: false, reason: 'too-small', minBytes };
  }

  const capW = Math.min(srcW, maxWidth);
  const widths = [capW, ...STANDARD_WIDTHS.filter((w) => w < capW)];
  const fpsOptions = srcFps > 32 ? [srcFps, 30] : [srcFps];

  let chosen = null;
  for (const w of widths) {
    const size = scaledSize(srcW, srcH, w);
    for (const f of fpsOptions) {
      const bpp = videoBps / (size.width * size.height * f);
      if (bpp >= bppThreshold(codec, size.width, size.height)) { chosen = { ...size, fps: f, bpp }; break; }
    }
    if (chosen) break;
  }
  if (!chosen) {
    // Budget très serré : plus petite taille raisonnable, 30 i/s max.
    const size = scaledSize(srcW, srcH, Math.min(capW, 320));
    const f = Math.min(srcFps, 30);
    chosen = { ...size, fps: f, bpp: videoBps / (size.width * size.height * f) };
  }

  const ratio = chosen.bpp / bppThreshold(codec, chosen.width, chosen.height);
  const quality = ratio >= 2 ? 'excellente' : ratio >= 1.2 ? 'très bonne' : ratio >= 0.95 ? 'bonne' : ratio >= 0.6 ? 'correcte' : 'faible';

  return {
    ok: true,
    videoBps,
    audioBps,
    width: chosen.width,
    height: chosen.height,
    fps: chosen.fps,
    bpp: chosen.bpp,
    quality,
    reducedResolution: chosen.width < even(srcW),
    reducedFps: chosen.fps < srcFps,
  };
}

/**
 * Ajuste le débit vidéo après une passe d'encodage, à partir de la taille obtenue.
 * Retourne null si le résultat est déjà satisfaisant.
 */
export function nextVideoBitrate({ targetBytes, resultBytes, videoBps, audioBps, duration, attempt }) {
  const fits = resultBytes <= targetBytes;
  const fill = resultBytes / targetBytes;
  if (fits && fill >= 0.88) return null; // assez proche : on garde

  // Part de la taille due à la vidéo (l'audio et le conteneur ne changent pas).
  const fixedBytes = (audioBps * duration) / 8;
  const videoBytes = Math.max(1, resultBytes - fixedBytes);
  const wantedVideoBytes = targetBytes * (fits ? 0.97 : 0.95 - 0.04 * attempt) - fixedBytes;
  let factor = wantedVideoBytes / videoBytes;
  if (fits) factor = Math.min(factor, 1.6); // remonter prudemment
  const next = Math.floor(videoBps * factor);
  return next >= MIN_VIDEO_BPS ? next : MIN_VIDEO_BPS;
}

/** Correspondance curseur qualité (0–100) → CRF x264 pour le moteur de secours. */
export function qualityToCrf(q) {
  return Math.round(34 - (q / 100) * 16); // 100 → 18, 0 → 34
}

/** 1 Mo = 1 000 000 octets partout dans l'appli (cible et affichage) :
 *  c'est la convention la plus stricte, donc un fichier « sous 25 Mo » l'est
 *  aussi pour les services qui comptent en 1024. */
export const MB = 1_000_000;

export function formatBytes(bytes) {
  if (bytes < 1000) return `${bytes} o`;
  const units = ['Ko', 'Mo', 'Go'];
  let v = bytes / 1000, i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v.toLocaleString('fr-FR', { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
}

export function formatDuration(sec) {
  if (!isFinite(sec)) return '–';
  const s = Math.round(sec);
  const m = Math.floor(s / 60), r = s % 60;
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}
