import { Bench } from 'tinybench';
import { ncc } from '../dist/detect/fft.js';

const bench = new Bench({ time: 1000 });
const img = new Float32Array(1024 * 1024);
const tpl = new Float32Array(64 * 16);

bench.add('ncc 1024² × 64×16', () => ncc(img, 1024, 1024, tpl, 64, 16));

await bench.run();
console.table(bench.table());
