import { unstampFile } from '@zerostack-labc/adapter-node';
import { readFile, writeFile } from 'node:fs/promises';

const inputPath = process.argv[2] ?? 'input.jpg';
const outputPath = process.argv[3] ?? 'output.png';
const text = process.argv[4] ?? 'Gemini';

const input = await readFile(inputPath);
const output = await unstampFile(input, {
  text,
  angle: 'auto',
  model: 'auto',
  metadata: true,
  miganPath: './models/migan.onnx',
  lamaPath: './models/lama.onnx',
});

await writeFile(outputPath, output);
console.log('✓ wrote', outputPath);
