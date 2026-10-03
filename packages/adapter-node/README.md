# @zerostack-ctrl/adapter-node

```ts
import { unstampFile } from '@zerostack-ctrl/adapter-node';
import { readFile, writeFile } from 'node:fs/promises';

const out = await unstampFile(await readFile('in.jpg'), {
  text: 'Sora',
  angle: -30,
  model: 'ensemble',
  miganPath: './models/migan.onnx',
  lamaPath: './models/lama.onnx',
});
await writeFile('out.png', out);
```
