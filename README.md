# Unstamp

**Strip any watermark. Locally. Freely.**

Browser-native, type-safe watermark remover. Handles **typed**, **rotated**,
**transparent**, **tiled**, **coloured**, **outlined**, and **frequency-domain**
watermarks — plus hidden **EXIF / XMP / C2PA** metadata.

Live demo: **https://zerostack-ctrl.github.io/unstamp/**

## Install

```bash
npx @zerostack-ctrl/cli in.jpg --text "Gemini" --out clean/
npm i @zerostack-ctrl/unstamp @zerostack-ctrl/adapter-node
npm i @zerostack-ctrl/unstamp onnxruntime-web
```

## Usage

```ts
import { unstamp } from '@zerostack-ctrl/unstamp';

const { image } = await unstamp(file, { text: 'Gemini', angle: 'auto' });
```

## License

MIT — see [`LICENSE`](LICENSE).
