'use strict';

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_BIN = process.env.FFPROBE_PATH || 'ffprobe';

let cachedHwCapabilities = null;

/**
 * Check available hardware encoders on this machine (testing both H.264 and HEVC individually).
 */
async function detectHardwareEncoders() {
  if (cachedHwCapabilities) return cachedHwCapabilities;

  const candidates = [
    { id: 'nvenc', label: 'NVIDIA NVENC (GPU高速)', h264: 'h264_nvenc', hevc: 'hevc_nvenc' },
    { id: 'qsv', label: 'Intel QSV (GPU高速)', h264: 'h264_qsv', hevc: 'hevc_qsv' },
    { id: 'amf', label: 'AMD AMF (GPU高速)', h264: 'h264_amf', hevc: 'hevc_amf' }
  ];

  const available = [];
  for (const cand of candidates) {
    const [supportsH264, supportsHevc] = await Promise.all([
      testEncoder(cand.h264),
      testEncoder(cand.hevc)
    ]);
    if (supportsH264 || supportsHevc) {
      available.push({
        ...cand,
        supportsH264,
        supportsHevc
      });
    }
  }

  cachedHwCapabilities = {
    available,
    hasGpu: available.length > 0,
    recommendedGpu: available[0] || null
  };
  return cachedHwCapabilities;
}

function testEncoder(encoderName) {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'lavfi',
      '-i', 'color=c=black:s=256x144:d=0.1',
      '-pix_fmt', 'yuv420p',
      '-c:v', encoderName,
      '-f', 'null',
      '-'
    ];
    const proc = spawn(FFMPEG_BIN, args, { windowsHide: true });
    const timer = setTimeout(() => {
      killProcessTree(proc);
      resolve(false);
    }, 4500);
    proc.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

function killProcessTree(proc) {
  if (!proc || proc.killed) return;
  try {
    proc.kill();
  } catch {}
  if (process.platform === 'win32' && proc.pid) {
    setTimeout(() => {
      if (proc.exitCode === null) {
        try {
          spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], { windowsHide: true, stdio: 'ignore' });
        } catch {}
      }
    }, 300);
  }
}

/**
 * Probe video metadata using ffprobe.
 */
function probeVideo(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ];
    execFile(FFPROBE_BIN, args, { windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(`ffprobe failed: ${stderr || err.message}`));
      }
      try {
        const data = JSON.parse(stdout);
        const videoStream = (data.streams || []).find((s) => s.codec_type === 'video');
        const audioStream = (data.streams || []).find((s) => s.codec_type === 'audio');
        const stat = fs.statSync(filePath);

        if (!videoStream) {
          return reject(new Error('映像ストリームが見つかりません（動画ファイルではない可能性があります）'));
        }

        const duration = parseFloat(data.format?.duration || videoStream?.duration || 0) || 0;
        let fps = 30;
        if (videoStream?.avg_frame_rate && videoStream.avg_frame_rate !== '0/0') {
          const [num, den] = videoStream.avg_frame_rate.split('/').map(Number);
          if (num && den) fps = Math.round((num / den) * 100) / 100;
        }

        // Handle rotation metadata if present
        let width = videoStream?.width || 0;
        let height = videoStream?.height || 0;
        let rotation = 0;
        if (videoStream?.tags?.rotate) {
          rotation = Math.abs(parseInt(videoStream.tags.rotate, 10)) || 0;
        } else if (Array.isArray(videoStream?.side_data_list)) {
          const disp = videoStream.side_data_list.find((d) => typeof d.rotation === 'number');
          if (disp) rotation = Math.abs(disp.rotation);
        }
        if (rotation === 90 || rotation === 270) {
          [width, height] = [height, width];
        }

        const totalBitrateKbps = data.format?.bit_rate
          ? Math.round(parseInt(data.format.bit_rate, 10) / 1000)
          : (duration > 0 ? Math.round((stat.size * 8) / duration / 1000) : 0);

        const videoBitrateKbps = videoStream?.bit_rate
          ? Math.round(parseInt(videoStream.bit_rate, 10) / 1000)
          : 0;

        resolve({
          sizeBytes: stat.size,
          sizeMB: Math.round((stat.size / (1024 * 1024)) * 100) / 100,
          duration,
          width,
          height,
          fps,
          videoCodec: videoStream?.codec_name || 'unknown',
          audioCodec: audioStream?.codec_name || null,
          hasAudio: Boolean(audioStream),
          bitrateKbps: totalBitrateKbps,
          videoBitrateKbps,
          formatName: data.format?.format_name || ''
        });
      } catch (parseErr) {
        reject(new Error(`Failed to parse ffprobe output: ${parseErr.message}`));
      }
    });
  });
}

/**
 * Parse HH:MM:SS or MM:SS or seconds string into seconds (or null if empty).
 */
function parseTimeToSeconds(val) {
  if (val === null || val === undefined || val === '') return null;
  if (typeof val === 'number' && !Number.isNaN(val)) return Math.max(0, val);
  const str = String(val).trim();
  if (!str) return null;
  if (/^\d+(\.\d+)?$/.test(str)) return Math.max(0, parseFloat(str));
  const parts = str.split(':').map((p) => parseFloat(p));
  if (parts.some((n) => Number.isNaN(n))) return null;
  if (parts.length === 2) return Math.max(0, parts[0] * 60 + parts[1]);
  if (parts.length === 3) return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
  return null;
}

/**
 * Calculate smart encoding parameters given source metadata and user options.
 */
function buildEncodingPlan(meta, options = {}, hw = null) {
  const mode = options.mode || 'target_size'; // 'target_size' | 'quality'
  const format = (options.format || 'mp4').toLowerCase(); // mp4 | hevc | webm | mov | gif
  const targetSizeMB = Math.max(0.5, parseFloat(options.targetSizeMB) || 20);
  const crf = Math.min(45, Math.max(15, parseInt(options.crf, 10) || 24));
  const resolution = options.resolution || 'auto'; // auto | original | 1080 | 720 | 480 | 360
  const fpsOption = options.fps || 'original'; // original | 60 | 30 | 24 | 15
  const audioOption = options.audio || 'auto'; // auto | 128 | 96 | 64 | mute
  const speedMode = options.speedMode || 'accurate_2pass'; // accurate_2pass | fast_1pass | gpu
  const marginRatio = options.marginRatio || 0.94; // safety buffer for container overhead

  const trimStart = parseTimeToSeconds(options.trimStart);
  const trimEnd = parseTimeToSeconds(options.trimEnd);

  let effectiveDuration = meta.duration || 10;
  if (trimStart !== null && trimEnd !== null && trimEnd > trimStart) {
    effectiveDuration = Math.min(effectiveDuration, trimEnd - trimStart);
  } else if (trimStart !== null && trimStart < effectiveDuration) {
    effectiveDuration = effectiveDuration - trimStart;
  } else if (trimEnd !== null && trimEnd > 0) {
    effectiveDuration = Math.min(effectiveDuration, trimEnd);
  }
  effectiveDuration = Math.max(0.5, effectiveDuration);

  // Determine extension and codec
  let ext = 'mp4';
  let videoCodec = 'libx264';
  let audioCodec = 'aac';
  let useTwoPass = false;
  let useGpu = false;
  let gpuFallback = false;

  if (format === 'gif') {
    ext = 'gif';
    videoCodec = 'gif';
    audioCodec = null;
  } else if (format === 'webm') {
    ext = 'webm';
    videoCodec = 'libvpx-vp9';
    audioCodec = 'libopus';
  } else if (format === 'hevc') {
    ext = 'mp4';
    videoCodec = 'libx265';
    audioCodec = 'aac';
  } else if (format === 'mov') {
    ext = 'mov';
    videoCodec = 'libx264';
    audioCodec = 'aac';
  } else {
    ext = 'mp4';
    videoCodec = 'libx264';
    audioCodec = 'aac';
  }

  // GPU encoder selection with per-codec support verification
  if (speedMode === 'gpu' && hw?.recommendedGpu && (format === 'mp4' || format === 'mov' || format === 'hevc')) {
    const gpu = hw.recommendedGpu;
    if (format === 'hevc') {
      if (gpu.supportsHevc) {
        useGpu = true;
        videoCodec = gpu.hevc;
      } else {
        gpuFallback = true;
      }
    } else if (gpu.supportsH264) {
      useGpu = true;
      videoCodec = gpu.h264;
    } else {
      gpuFallback = true;
    }
  }

  // Audio & video bitrate calculation
  const hasAudio = meta.hasAudio && audioOption !== 'mute' && format !== 'gif';
  let audioBitrateKbps = 0;
  let targetVideoBitrateKbps = null;
  let cappedBySource = false;

  const minVideoKbps = 64;
  const minAudioKbps = hasAudio ? 32 : 0;
  const minTotalKbps = minVideoKbps + minAudioKbps;
  const minPossibleMB = Math.round(((minTotalKbps * 1000 * effectiveDuration) / (8 * 1024 * 1024) / 0.94) * 100) / 100;
  const impossibleTarget = mode === 'target_size' && format !== 'gif' && targetSizeMB < minPossibleMB;

  if (mode === 'target_size' && format !== 'gif') {
    const targetTotalBits = targetSizeMB * 1024 * 1024 * 8 * marginRatio;
    let targetTotalKbps = targetTotalBits / effectiveDuration / 1000;

    // Prevent file bloat when targetSizeMB is larger than the source video bitrate
    const sourceTotalKbps = meta.bitrateKbps > 0 ? meta.bitrateKbps : 0;
    if (sourceTotalKbps > 0 && targetTotalKbps > sourceTotalKbps * 1.02) {
      targetTotalKbps = sourceTotalKbps * 0.98;
      cappedBySource = true;
    }

    if (hasAudio) {
      if (audioOption === 'auto') {
        if (targetTotalKbps >= 1200) audioBitrateKbps = 128;
        else if (targetTotalKbps >= 600) audioBitrateKbps = 96;
        else if (targetTotalKbps >= 300) audioBitrateKbps = 64;
        else if (targetTotalKbps >= 160) audioBitrateKbps = 48;
        else audioBitrateKbps = 32;
      } else {
        audioBitrateKbps = Math.min(parseInt(audioOption, 10) || 96, Math.max(32, Math.floor(targetTotalKbps * 0.35)));
      }
    }

    targetVideoBitrateKbps = Math.max(minVideoKbps, Math.floor(targetTotalKbps - audioBitrateKbps));

    // Also cap against source video stream bitrate if known, to avoid bloating video stream
    if (meta.videoBitrateKbps > 0 && targetVideoBitrateKbps > meta.videoBitrateKbps * 1.05) {
      targetVideoBitrateKbps = Math.max(minVideoKbps, Math.floor(meta.videoBitrateKbps * 1.0));
      cappedBySource = true;
    }

    // Decide 2-pass vs 1-pass
    if (!useGpu && speedMode === 'accurate_2pass' && (videoCodec === 'libx264' || videoCodec === 'libx265' || videoCodec === 'libvpx-vp9')) {
      useTwoPass = true;
    }
  } else if (hasAudio) {
    audioBitrateKbps = audioOption === 'auto' ? 128 : (parseInt(audioOption, 10) || 128);
  }

  // Determine target max short side (width for portrait, height for landscape)
  let maxShortSide = null;
  if (resolution === 'auto') {
    if (format === 'gif') {
      maxShortSide = 480;
    } else if (targetVideoBitrateKbps !== null && !cappedBySource) {
      // Scale down automatically when bitrate budget is tight so video stays crisp
      const effBitrate = format === 'hevc' || format === 'webm' ? targetVideoBitrateKbps * 1.35 : targetVideoBitrateKbps;
      if (effBitrate < 350) maxShortSide = 360;
      else if (effBitrate < 800) maxShortSide = 480;
      else if (effBitrate < 1800) maxShortSide = 720;
      else if (effBitrate < 4500) maxShortSide = 1080;
      else maxShortSide = null;
    }
  } else if (resolution !== 'original') {
    maxShortSide = parseInt(resolution, 10) || null;
  }

  // Determine FPS
  let targetFps = null;
  if (fpsOption === 'original') {
    if (format === 'gif') targetFps = 12;
    else if (targetVideoBitrateKbps !== null && !cappedBySource && targetVideoBitrateKbps < 500 && meta.fps > 30) {
      targetFps = 24;
    } else if (targetVideoBitrateKbps !== null && !cappedBySource && targetVideoBitrateKbps < 1500 && meta.fps > 35) {
      targetFps = 30;
    }
  } else {
    targetFps = parseInt(fpsOption, 10) || null;
  }

  // Estimate resulting output size
  let estimatedMB = null;
  if (targetVideoBitrateKbps !== null) {
    const totalKbps = targetVideoBitrateKbps + audioBitrateKbps;
    estimatedMB = Math.round(((totalKbps * 1000 * effectiveDuration) / (8 * 1024 * 1024) / 0.96) * 100) / 100;
  }

  return {
    mode,
    format,
    ext,
    targetSizeMB,
    crf,
    videoCodec,
    audioCodec,
    hasAudio,
    audioBitrateKbps,
    targetVideoBitrateKbps,
    maxShortSide,
    targetFps,
    useTwoPass,
    useGpu,
    gpuFallback,
    cappedBySource,
    minPossibleMB,
    impossibleTarget,
    estimatedMB,
    effectiveDuration,
    trimStart,
    trimEnd,
    marginRatio
  };
}

/**
 * Build scale filter string that preserves aspect ratio, never upscales, and ALWAYS produces even dimensions.
 */
function buildScaleFilter(meta, maxShortSide) {
  if (!maxShortSide) {
    return 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  }
  const isPortrait = meta.height > meta.width;
  if (isPortrait) {
    // Limit width to maxShortSide, never upscale, force even width & height
    return `scale='trunc(min(${maxShortSide},iw)/2)*2':-2`;
  }
  // Landscape or square: limit height to maxShortSide, never upscale, force even height & width
  return `scale=-2:'trunc(min(${maxShortSide},ih)/2)*2'`;
}

/**
 * Run a single ffmpeg process with progress reporting (including ETA) and optional cwd.
 */
function runFfmpeg(args, totalDurationSec, onProgress, registerCancel, spawnOpts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args, { windowsHide: true, ...spawnOpts });
    let stderrTail = '';
    let cancelled = false;

    if (registerCancel) {
      registerCancel(() => {
        cancelled = true;
        killProcessTree(proc);
      });
    }

    let stdoutBuf = '';
    let lastSpeed = '';

    proc.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() || '';
      let outTimeUs = null;

      for (const line of lines) {
        const idx = line.indexOf('=');
        if (idx === -1) continue;
        const k = line.slice(0, idx).trim();
        const v = line.slice(idx + 1).trim();
        if (k === 'out_time_us' || k === 'out_time_ms') {
          const parsed = parseInt(v, 10);
          if (!Number.isNaN(parsed) && parsed >= 0) {
            outTimeUs = parsed;
          }
        } else if (k === 'speed') {
          lastSpeed = v;
        }
      }

      if (outTimeUs !== null && totalDurationSec > 0 && onProgress) {
        const currentSec = outTimeUs / 1_000_000;
        const ratio = Math.min(0.999, Math.max(0, currentSec / totalDurationSec));
        let etaSec = null;
        const speedNum = parseFloat(String(lastSpeed).replace(/x$/i, ''));
        if (speedNum > 0.01) {
          etaSec = Math.max(0, Math.round((totalDurationSec - currentSec) / speedNum));
        }
        onProgress({ ratio, currentSec, speed: lastSpeed, etaSec });
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderrTail += chunk.toString();
      if (stderrTail.length > 8000) {
        stderrTail = stderrTail.slice(-8000);
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start ffmpeg: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (cancelled) {
        return reject(new Error('CANCELLED'));
      }
      if (code !== 0) {
        const lastLines = stderrTail.trim().split(/\r?\n/).slice(-8).join('\n');
        return reject(new Error(`FFmpeg error (code ${code}): ${lastLines}`));
      }
      resolve();
    });
  });
}

/**
 * Compress a video file with automatic retry if targetSizeMB is slightly exceeded.
 */
async function compressVideo({ inputPath, outputPath, options = {}, onProgress, onCancelRegister }) {
  const absInput = path.resolve(inputPath);
  const absOutput = path.resolve(outputPath);

  const meta = await probeVideo(absInput);
  const hw = await detectHardwareEncoders();

  let currentCancel = null;
  let cancelled = false;
  const cancelWrapper = () => {
    cancelled = true;
    if (currentCancel) currentCancel();
  };
  if (onCancelRegister) onCancelRegister(cancelWrapper);

  const emitProgress = (payload) => {
    if (onProgress) onProgress(payload);
  };

  let marginRatio = 0.94;
  let finalPlan = null;
  const initialPlan = buildEncodingPlan(meta, { ...options, marginRatio }, hw);
  const maxAttempts =
    initialPlan.mode === 'target_size' &&
    initialPlan.format !== 'gif' &&
    !initialPlan.impossibleTarget
      ? 2
      : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (cancelled) throw new Error('CANCELLED');

    const plan = buildEncodingPlan(meta, { ...options, marginRatio }, hw);
    finalPlan = plan;

    emitProgress({
      stage: attempt === 1 ? 'starting' : 'retrying',
      percent: 0,
      etaSec: null,
      message: attempt === 1
        ? `解析完了 (${meta.width}x${meta.height}, ${meta.duration.toFixed(1)}秒)`
        : `目標サイズをわずかに超えたためビットレートを微調整して再圧縮中...`,
      plan
    });

    // Separate input args from trim duration args so multi-input commands (like GIF paletteuse) don't misapply -t/-to
    const inputArgs = ['-hide_banner', '-loglevel', 'error', '-y'];
    if (plan.trimStart !== null) {
      inputArgs.push('-ss', String(plan.trimStart));
    }
    inputArgs.push('-i', absInput);

    const trimOutputArgs = [];
    if (plan.trimEnd !== null) {
      if (plan.trimStart !== null) {
        trimOutputArgs.push('-t', String(Math.max(0.5, plan.trimEnd - plan.trimStart)));
      } else {
        trimOutputArgs.push('-to', String(plan.trimEnd));
      }
    }

    const vfParts = [buildScaleFilter(meta, plan.maxShortSide)];
    if (plan.targetFps) {
      vfParts.push(`fps=${plan.targetFps}`);
    }

    // Special handling for GIF (2-step palettegen + paletteuse for crisp colors)
    if (plan.format === 'gif') {
      const palettePath = path.join(os.tmpdir(), `vc-pal-${crypto.randomBytes(6).toString('hex')}.png`);
      try {
        emitProgress({ stage: 'pass1', percent: 5, message: 'GIFカラーパレットを生成中...' });
        const palFilter = `${vfParts.join(',')},palettegen=stats_mode=diff`;
        await runFfmpeg(
          [...inputArgs, ...trimOutputArgs, '-vf', palFilter, '-progress', 'pipe:1', palettePath],
          plan.effectiveDuration,
          ({ ratio, speed, etaSec }) => {
            emitProgress({ stage: 'pass1', percent: Math.round(ratio * 40), speed, etaSec, message: 'パレット生成中...' });
          },
          (fn) => { currentCancel = fn; }
        );

        emitProgress({ stage: 'pass2', percent: 42, message: 'GIFをエンコード中...' });
        const useFilter = `${vfParts.join(',')}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
        await runFfmpeg(
          [...inputArgs, '-i', palettePath, ...trimOutputArgs, '-lavfi', useFilter, '-loop', '0', '-progress', 'pipe:1', absOutput],
          plan.effectiveDuration,
          ({ ratio, speed, etaSec }) => {
            emitProgress({ stage: 'pass2', percent: 40 + Math.round(ratio * 59), speed, etaSec, message: 'GIF書き出し中...' });
          },
          (fn) => { currentCancel = fn; }
        );
      } finally {
        try { if (fs.existsSync(palettePath)) fs.unlinkSync(palettePath); } catch {}
      }
      break;
    }

    const commonVideoFilter = ['-vf', vfParts.join(',')];
    const pixFmt = ['-pix_fmt', 'yuv420p'];
    const movFlags = (plan.ext === 'mp4' || plan.ext === 'mov') ? ['-movflags', '+faststart'] : [];

    // Audio args
    const audioArgs = plan.hasAudio
      ? ['-c:a', plan.audioCodec, '-b:a', `${plan.audioBitrateKbps}k`, '-ac', '2']
      : ['-an'];

    if (plan.useTwoPass && plan.targetVideoBitrateKbps) {
      const tmpDir = os.tmpdir();
      const passLogBase = `vc-pass-${crypto.randomBytes(6).toString('hex')}`;
      const nullOut = process.platform === 'win32' ? 'NUL' : '/dev/null';
      const vb = `${plan.targetVideoBitrateKbps}k`;
      const maxrate = `${Math.round(plan.targetVideoBitrateKbps * 1.4)}k`;
      const bufsize = `${Math.round(plan.targetVideoBitrateKbps * 2.0)}k`;

      // Run in tmpDir with relative passlog names so x265-params doesn't choke on Windows drive colons (C:)
      const spawnOpts = { cwd: tmpDir };

      try {
        // Pass 1
        const pass1Args = [
          ...inputArgs,
          ...trimOutputArgs,
          ...commonVideoFilter,
          ...pixFmt,
          '-c:v', plan.videoCodec,
          '-b:v', vb,
          '-maxrate', maxrate,
          '-bufsize', bufsize
        ];

        if (plan.videoCodec === 'libx264') {
          pass1Args.push('-preset', 'medium', '-pass', '1', '-passlogfile', passLogBase);
        } else if (plan.videoCodec === 'libx265') {
          pass1Args.push('-preset', 'medium', '-x265-params', `pass=1:stats=${passLogBase}.log:log-level=error`);
        } else if (plan.videoCodec === 'libvpx-vp9') {
          pass1Args.push('-deadline', 'good', '-cpu-used', '4', '-row-mt', '1', '-pass', '1', '-passlogfile', passLogBase);
        }

        pass1Args.push('-an', '-f', plan.format === 'webm' ? 'webm' : 'mp4', '-progress', 'pipe:1', nullOut);

        emitProgress({ stage: 'pass1', percent: 1, message: 'Pass 1/2: 映像を分析中...' });
        await runFfmpeg(
          pass1Args,
          plan.effectiveDuration,
          ({ ratio, speed, etaSec }) => {
            emitProgress({
              stage: 'pass1',
              percent: Math.min(45, Math.round(ratio * 45)),
              speed,
              etaSec: etaSec !== null ? Math.round(etaSec * 2.2) : null,
              message: 'Pass 1/2: 映像を分析中...'
            });
          },
          (fn) => { currentCancel = fn; },
          spawnOpts
        );

        // Pass 2
        const pass2Args = [
          ...inputArgs,
          ...trimOutputArgs,
          ...commonVideoFilter,
          ...pixFmt,
          '-c:v', plan.videoCodec,
          '-b:v', vb,
          '-maxrate', maxrate,
          '-bufsize', bufsize
        ];

        if (plan.videoCodec === 'libx264') {
          pass2Args.push('-preset', 'medium', '-pass', '2', '-passlogfile', passLogBase);
        } else if (plan.videoCodec === 'libx265') {
          pass2Args.push('-preset', 'medium', '-tag:v', 'hvc1', '-x265-params', `pass=2:stats=${passLogBase}.log:log-level=error`);
        } else if (plan.videoCodec === 'libvpx-vp9') {
          pass2Args.push('-deadline', 'good', '-cpu-used', '2', '-row-mt', '1', '-pass', '2', '-passlogfile', passLogBase);
        }

        pass2Args.push(...audioArgs, ...movFlags, '-progress', 'pipe:1', absOutput);

        emitProgress({ stage: 'pass2', percent: 45, message: 'Pass 2/2: 目標サイズに合わせてエンコード中...' });
        await runFfmpeg(
          pass2Args,
          plan.effectiveDuration,
          ({ ratio, speed, etaSec }) => {
            emitProgress({
              stage: 'pass2',
              percent: Math.min(99, 45 + Math.round(ratio * 54)),
              speed,
              etaSec,
              message: 'Pass 2/2: エンコード中...'
            });
          },
          (fn) => { currentCancel = fn; },
          spawnOpts
        );
      } finally {
        try {
          for (const f of fs.readdirSync(tmpDir)) {
            if (f.startsWith(passLogBase)) {
              fs.unlinkSync(path.join(tmpDir, f));
            }
          }
        } catch {}
      }
    } else {
      // 1-pass (fast CPU, GPU, or Quality/CRF mode)
      const encodeArgs = [
        ...inputArgs,
        ...trimOutputArgs,
        ...commonVideoFilter,
        ...pixFmt,
        '-c:v', plan.videoCodec
      ];

      if (plan.mode === 'target_size' && plan.targetVideoBitrateKbps) {
        const vb = `${plan.targetVideoBitrateKbps}k`;
        const maxrate = `${Math.round(plan.targetVideoBitrateKbps * 1.15)}k`;
        const bufsize = `${Math.round(plan.targetVideoBitrateKbps * 1.5)}k`;
        encodeArgs.push('-b:v', vb, '-maxrate', maxrate, '-bufsize', bufsize);

        if (plan.videoCodec === 'libx264' || plan.videoCodec === 'libx265') {
          encodeArgs.push('-preset', 'fast');
          if (plan.videoCodec === 'libx265') encodeArgs.push('-tag:v', 'hvc1');
        } else if (plan.videoCodec.includes('nvenc')) {
          encodeArgs.push('-rc', 'vbr', '-preset', 'p5');
          if (plan.videoCodec === 'hevc_nvenc') encodeArgs.push('-tag:v', 'hvc1');
        } else if (plan.videoCodec === 'libvpx-vp9') {
          encodeArgs.push('-deadline', 'good', '-cpu-used', '3', '-row-mt', '1');
        }
      } else {
        // Quality / CRF mode
        if (plan.videoCodec === 'libx264') {
          encodeArgs.push('-preset', 'medium', '-crf', String(plan.crf));
        } else if (plan.videoCodec === 'libx265') {
          encodeArgs.push('-preset', 'medium', '-crf', String(Math.min(45, plan.crf + 2)), '-tag:v', 'hvc1');
        } else if (plan.videoCodec === 'libvpx-vp9') {
          encodeArgs.push('-crf', String(Math.min(50, plan.crf + 6)), '-b:v', '0', '-deadline', 'good', '-cpu-used', '3', '-row-mt', '1');
        } else if (plan.videoCodec.includes('nvenc')) {
          encodeArgs.push('-rc', 'vbr', '-cq', String(plan.crf), '-b:v', '0', '-preset', 'p5');
          if (plan.videoCodec === 'hevc_nvenc') encodeArgs.push('-tag:v', 'hvc1');
        } else {
          encodeArgs.push('-q:v', '24');
        }
      }

      encodeArgs.push(...audioArgs, ...movFlags, '-progress', 'pipe:1', absOutput);

      emitProgress({
        stage: 'encoding',
        percent: 2,
        message: plan.useGpu ? `GPU (${plan.videoCodec}) で高速エンコード中...` : 'エンコード中...'
      });

      await runFfmpeg(
        encodeArgs,
        plan.effectiveDuration,
        ({ ratio, speed, etaSec }) => {
          emitProgress({
            stage: 'encoding',
            percent: Math.min(99, Math.round(ratio * 99)),
            speed,
            etaSec,
            message: plan.useGpu ? `GPU高速エンコード中...` : 'エンコード中...'
          });
        },
        (fn) => { currentCancel = fn; }
      );
    }

    // Check output file size against targetSizeMB
    const outStat = fs.statSync(absOutput);
    const outMB = outStat.size / (1024 * 1024);

    if (
      plan.mode === 'target_size' &&
      plan.format !== 'gif' &&
      !plan.impossibleTarget &&
      outMB > plan.targetSizeMB &&
      attempt < maxAttempts
    ) {
      const overshootRatio = plan.targetSizeMB / outMB;
      marginRatio = Math.max(0.55, marginRatio * overshootRatio * 0.94);
      continue;
    }

    break;
  }

  const outStat = fs.statSync(absOutput);
  const outMeta = await probeVideo(absOutput).catch(() => null);

  return {
    outputPath: absOutput,
    originalSizeBytes: meta.sizeBytes,
    outputSizeBytes: outStat.size,
    originalSizeMB: Math.round((meta.sizeBytes / (1024 * 1024)) * 100) / 100,
    outputSizeMB: Math.round((outStat.size / (1024 * 1024)) * 100) / 100,
    savedPercent: meta.sizeBytes > 0 ? Math.round((1 - outStat.size / meta.sizeBytes) * 1000) / 10 : 0,
    withinTarget: finalPlan.mode === 'target_size' && finalPlan.format !== 'gif'
      ? (outStat.size <= finalPlan.targetSizeMB * 1024 * 1024)
      : true,
    plan: finalPlan,
    inputMeta: meta,
    outputMeta: outMeta
  };
}

module.exports = {
  probeVideo,
  detectHardwareEncoders,
  buildEncodingPlan,
  compressVideo,
  parseTimeToSeconds
};
