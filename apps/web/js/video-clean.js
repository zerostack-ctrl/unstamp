import { Muxer, ArrayBufferTarget } from 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.5/+esm';
import { alphaInvert } from './inpaint/alpha-invert.js';

const CODEC_CANDIDATES = [
  'avc1.640028',   // H.264 High
  'avc1.4d001f',   // H.264 Main
  'avc1.42001f',   // H.264 Baseline
];

export async function webCodecsSupported() {
  if (typeof VideoEncoder === 'undefined') return false;
  for (const codec of CODEC_CANDIDATES) {
    try {
      const s = await VideoEncoder.isConfigSupported({
        codec, width: 1280, height: 720, bitrate: 5_000_000, framerate: 30,
      });
      if (s.supported) return true;
    } catch {}
  }
  return false;
}

async function pickConfig(w, h, bitrate, framerate) {
  for (const codec of CODEC_CANDIDATES) {
    const config = { codec, width: w, height: h, bitrate, framerate };
    try {
      const s = await VideoEncoder.isConfigSupported(config);
      if (s.supported) return { config, codec };
    } catch {}
  }
  throw new Error('No WebCodecs video encoder available');
}

function evenDown(n) {
  return Math.max(2, Math.floor(n / 2) * 2);
}

/**
 * Encode a cleaned video using WebCodecs (hardware-accelerated H.264) and
 * mux it to MP4. Video-only — no audio track (see notes).
 *
 * @returns {Promise<Blob>} MP4 blob
 */
export async function cleanVideoWebCodecs(video, opts = {}) {
  const {
    mask,                      // Float32Array of size srcW*srcH
    colour = null,
    trimStart = 0,
    trimEnd = null,
    targetHeight = null,       // 720 | 1080 | null (keep source)
    bitrate = 8_000_000,
    framerate = 30,
    onProgress = () => {},
    signal,
  } = opts;

  const srcW = video.videoWidth;
  const srcH = video.videoHeight;
  const srcDuration = video.duration;
  const start = Math.max(0, trimStart);
  const end = trimEnd != null ? Math.min(srcDuration, trimEnd) : srcDuration;
  if (end <= start) throw new Error('Invalid trim range');

  // Output size
  let outW = srcW;
  let outH = srcH;
  if (targetHeight && targetHeight < srcH) {
    outH = evenDown(targetHeight);
    outW = evenDown((srcW / srcH) * outH);
  } else {
    outW = evenDown(srcW);
    outH = evenDown(srcH);
  }

  const { config, codec } = await pickConfig(outW, outH, bitrate, framerate);

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: outW, height: outH },
    fastStart: 'in-memory',
  });

  let encodeError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => { try { muxer.addVideoChunk(chunk, meta); } catch (e) { encodeError = e; } },
    error: (e) => { encodeError = e; },
  });
  encoder.configure(config);

  // Working canvas at source resolution for the inpaint math
  const work = document.createElement('canvas');
  work.width = srcW;
  work.height = srcH;
  const workCtx = work.getContext('2d', { willReadFrequently: true });

  // Output canvas at target resolution
  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const outCtx = out.getContext('2d');

  // Seek to trim start
  video.currentTime = start;
  await new Promise((r) => { video.onseeked = r; });

  let frameIndex = 0;
  const totalFrames = Math.max(1, Math.ceil((end - start) * framerate));

  return new Promise((resolve, reject) => {
    let finished = false;

    const finish = async () => {
      if (finished) return;
      finished = true;
      video.pause();
      try {
        if (encodeError) throw encodeError;
        await encoder.flush();
        if (encodeError) throw encodeError;
        muxer.finalize();
        const { buffer } = muxer.target;
        const blob = new Blob([buffer], { type: 'video/mp4' });
        resolve(blob);
      } catch (e) {
        reject(e);
      }
    };

    const tick = () => {
      if (finished) return;
      if (signal?.aborted) { finished = true; video.pause(); reject(new Error('Aborted')); return; }
      if (video.currentTime >= end || video.ended) return void finish();

      workCtx.drawImage(video, 0, 0, srcW, srcH);
      const frameData = workCtx.getImageData(0, 0, srcW, srcH);
      const cleaned = alphaInvert(frameData, mask, { colour });
      workCtx.putImageData(cleaned, 0, 0);

      outCtx.drawImage(work, 0, 0, srcW, srcH, 0, 0, outW, outH);

      try {
        const frame = new VideoFrame(out, {
          timestamp: Math.round(video.currentTime * 1e6),
        });
        encoder.encode(frame, { keyFrame: frameIndex % 60 === 0 });
        frame.close();
      } catch (e) {
        encodeError = e;
      }

      frameIndex++;
      if (frameIndex % 5 === 0) {
        onProgress('video', Math.min(0.98, (frameIndex / totalFrames)),
          `Frame ${frameIndex} / ~${totalFrames}`);
      }

      video.requestVideoFrameCallback(tick);
    };

    const onEnded = () => finish();
    video.addEventListener('ended', onEnded);
    video.addEventListener('error', () => reject(new Error('Video error')));
    video.play().then(() => video.requestVideoFrameCallback(tick)).catch(reject);
  });
}