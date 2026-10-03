#!/usr/bin/env node
import { cac } from 'cac';
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { extname, join, basename, resolve } from 'node:path';
import { unstampFile } from '@zerostack-ctrl/adapter-node';
import { PRESETS } from '@zerostack-ctrl/unstamp/presets';
import kleur from 'kleur';

const cli = cac('unstamp');

cli
  .command('[files...]', 'Remove watermarks from images')
  .option('--text <text>', 'Watermark text')
  .option('--preset <name>', 'Preset (sora|veo|gemini|dalle|midjourney|synthid)')
  .option('--angle <deg>', 'Rotation angle in degrees')
  .option('--model <model>', 'migan | lama | ensemble | auto', { default: 'auto' })
  .option('--strip-metadata', 'Strip EXIF/XMP/C2PA')
  .option('--out <dir>', 'Output directory', { default: './out' })
  .option('--json', 'Emit JSON lines')
  .option('--concurrency <n>', 'Parallel jobs', { default: 4 })
  .action(async (files, opts) => {
    const preset = opts.preset ? PRESETS[opts.preset] : null;
    const text = opts.text ?? preset?.text;
    if (!text) {
      console.error(kleur.red('error: --text or --preset required'));
      process.exit(1);
    }
    await mkdir(opts.out, { recursive: true });
    const inputs = await expand(files);
    if (!inputs.length) {
      console.error(kleur.red('error: no input files'));
      process.exit(1);
    }
    await runPool(inputs, +opts.concurrency, async (file) => {
      try {
        const buf = await readFile(file);
        const out = await unstampFile(buf, {
          text,
          angle: opts.angle ? +opts.angle : (preset?.angle ?? 'auto'),
          model: opts.model,
          metadata: !!opts.stripMetadata,
          transparent: preset?.transparent,
          colour: preset?.colour,
        });
        const dest = join(opts.out, basename(file, extname(file)) + '.png');
        await writeFile(dest, out);
        if (opts.json) console.log(JSON.stringify({ in: file, out: dest, ok: true }));
        else console.log(kleur.green('✓'), file, '→', dest);
      } catch (e) {
        if (opts.json) console.log(JSON.stringify({ in: file, ok: false, error: String(e) }));
        else console.error(kleur.red('✗'), file, kleur.dim(String(e)));
      }
    });
  });

cli.help();
cli.version('1.0.0');
cli.parse();

async function expand(inputs) {
  const out = [];
  for (const inp of inputs) {
    try {
      const s = await stat(inp);
      if (s.isDirectory()) {
        const children = await readdir(inp);
        for (const c of children) {
          if (/\.(png|jpe?g|webp)$/i.test(c)) out.push(join(inp, c));
        }
      } else if (s.isFile()) {
        out.push(inp);
      }
    } catch {
      out.push(resolve(inp));
    }
  }
  return out;
}

async function runPool(items, concurrency, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx]); }
  });
  await Promise.all(workers);
}
