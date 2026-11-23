#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { compressVideo, detectHardwareEncoders } = require('./compressor');

function displayWidth(str) {
  let w = 0;
  for (const ch of String(str)) {
    const code = ch.codePointAt(0);
    // Treat CJK / fullwidth characters as 2 terminal columns
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

function formatEta(etaSec) {
  if (etaSec === null || etaSec === undefined || Number.isNaN(etaSec)) return '';
  if (etaSec <= 1) return ' / まもなく完了';
  if (etaSec < 60) return ` / 残り約${etaSec}秒`;
  const m = Math.floor(etaSec / 60);
  const s = etaSec % 60;
  return ` / 残り約${m}分${s > 0 ? `${s}秒` : ''}`;
}

function parseArgs(argv) {
  const options = {
    targetSizeMB: 20,
    format: 'mp4',
    resolution: 'auto',
    speedMode: 'accurate_2pass',
    audio: 'auto',
    fps: 'original',
    mode: 'target_size',
    outDir: null
  };
  const files = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--size' || arg === '-s') {
      options.targetSizeMB = parseFloat(argv[++i]) || 20;
    } else if (arg === '--format' || arg === '-f') {
      options.format = argv[++i] || 'mp4';
    } else if (arg === '--res' || arg === '-r') {
      options.resolution = argv[++i] || 'auto';
    } else if (arg === '--speed') {
      options.speedMode = argv[++i] || 'accurate_2pass';
    } else if (arg === '--out' || arg === '-o') {
      options.outDir = argv[++i] || null;
    } else if (arg === '--mute') {
      options.audio = 'mute';
    } else if (!arg.startsWith('-')) {
      files.push(arg);
    }
  }
  return { options, files };
}

function makeOutputPath(inputPath, options) {
  const parsed = path.parse(inputPath);
  const outDir = options.outDir ? path.resolve(options.outDir) : parsed.dir;
  fs.mkdirSync(outDir, { recursive: true });
  const ext = options.format === 'webm' ? 'webm' : options.format === 'mov' ? 'mov' : options.format === 'gif' ? 'gif' : 'mp4';
  const suffix = `${options.targetSizeMB}MB`;
  let candidate = path.join(outDir, `${parsed.name}_${suffix}.${ext}`);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(outDir, `${parsed.name}_${suffix}_${n}.${ext}`);
    n++;
  }
  return candidate;
}

async function main() {
  const { options, files } = parseArgs(process.argv.slice(2));

  if (files.length === 0) {
    console.log('使い方: node cli.js [--size 20] [--format mp4|hevc|webm|gif] [--speed accurate_2pass|fast_1pass|gpu] <動画ファイル...>');
    process.exit(1);
  }

  let activeCancel = null;
  let activeOutputPath = null;
  process.on('SIGINT', () => {
    process.stdout.write('\n中断しています...\n');
    if (activeCancel) activeCancel();
    setTimeout(() => {
      try { if (activeOutputPath && fs.existsSync(activeOutputPath)) fs.unlinkSync(activeOutputPath); } catch {}
      process.exit(130);
    }, 300);
  });

  const hw = await detectHardwareEncoders();
  console.log(`\n目標サイズ: ${options.targetSizeMB}MB 以下 | 形式: ${options.format.toUpperCase()} | GPU: ${hw.hasGpu ? hw.recommendedGpu.label : 'CPU'}\n`);

  let hasError = false;
  for (let idx = 0; idx < files.length; idx++) {
    const inputPath = path.resolve(files[idx]);
    if (!fs.existsSync(inputPath)) {
      console.error(`[エラー] ファイルが見つかりません: ${inputPath}`);
      hasError = true;
      continue;
    }

    const outputPath = makeOutputPath(inputPath, options);
    activeOutputPath = outputPath;
    console.log(`[${idx + 1}/${files.length}] 処理開始: ${path.basename(inputPath)}`);

    let lastLineWidth = 0;
    try {
      const res = await compressVideo({
        inputPath,
        outputPath,
        options,
        onCancelRegister: (fn) => { activeCancel = fn; },
        onProgress: (p) => {
          const pct = String(p.percent ?? 0).padStart(3, ' ');
          const barLen = 24;
          const filled = Math.round(((p.percent ?? 0) / 100) * barLen);
          const bar = '#'.repeat(filled) + '-'.repeat(barLen - filled);
          const speedText = p.speed ? ` (${p.speed})` : '';
          const etaText = formatEta(p.etaSec);
          const line = `  [${bar}] ${pct}% ${p.message || ''}${speedText}${etaText}`;
          const curWidth = displayWidth(line);
          const pad = Math.max(0, lastLineWidth - curWidth);
          process.stdout.write(`\r${line}${' '.repeat(pad)}`);
          lastLineWidth = curWidth;
        }
      });

      process.stdout.write('\n');
      const badge = res.withinTarget ? 'OK' : '注意';
      const note = res.plan?.cappedBySource ? ' (元サイズ維持)' : '';
      console.log(`  [${badge}] ${res.originalSizeMB} MB -> ${res.outputSizeMB} MB (${res.savedPercent}% 削減)${note}`);
      console.log(`  保存先: ${res.outputPath}\n`);
    } catch (err) {
      process.stdout.write('\n');
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
      console.error(`  [失敗] ${err.message}\n`);
      hasError = true;
    } finally {
      activeCancel = null;
      activeOutputPath = null;
    }
  }

  if (hasError) process.exit(1);
}

main();
