# audio-time-stretch

[![npm version](https://img.shields.io/npm/v/audio-time-stretch.svg)](https://npmjs.com/package/audio-time-stretch)
[![license](https://img.shields.io/github/license/KrzysieQ123/audio-time-stretch)](https://github.com/KrzysieQ123/audio-time-stretch/blob/main/LICENSE)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Buy_me_a_coffee-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/krzysieq43799)

Audio time stretching and pitch shifting for the Web Audio API.

The library changes the tempo and pitch of an `AudioBuffer`. Processing runs inside a Web Worker and does not block the main thread.

## Installation

```bash
npm install audio-time-stretch
```

## Usage

```js
import { stretchAudioBuffer } from "audio-time-stretch";

const context = new AudioContext();

const response = await fetch("/audio.mp3");
const encoded = await response.arrayBuffer();
const input = await context.decodeAudioData(encoded);

const output = await stretchAudioBuffer(
  context,
  input,
  {
    tempo: 1.5,
    pitch: 1,
  },
);

const source = context.createBufferSource();

source.buffer = output;
source.connect(context.destination);

await context.resume();
source.start();
```

## Tempo and pitch

Increase tempo while preserving the original pitch:

```js
const output = await stretchAudioBuffer(
  context,
  input,
  {
    tempo: 1.5,
    pitch: 1,
  },
);
```

Change pitch without changing the final duration:

```js
const output = await stretchAudioBuffer(
  context,
  input,
  {
    tempo: 1,
    pitch: 1.25,
  },
);
```

Increase tempo and pitch together:

```js
const output = await stretchAudioBuffer(
  context,
  input,
  {
    tempo: 1.5,
    pitch: 1.5,
  },
);
```

Values greater than `1` increase tempo or pitch. Values below `1` decrease them.

## Progress

```js
const output = await stretchAudioBuffer(
  context,
  input,
  {
    tempo: 0.75,
    pitch: 1,
    onProgress: (progress) => {
      console.log(`${Math.round(progress * 100)}%`)
    }
  },
);
```

## Cancellation

```js
const controller = new AbortController();

const processing = stretchAudioBuffer(
  context,
  input,
  {
    tempo: 0.75,
    pitch: 1,
    signal: controller.signal,
  },
);

controller.abort();

try {
  const output = await processing;
} catch (error) {
  if (error.name === "AbortError") {
    console.log("Processing cancelled");
  }
}
```

## API

```ts
stretchAudioBuffer(
  context: BaseAudioContext,
  input: AudioBuffer,
  options?: {
    tempo?: number;
    pitch?: number;
    signal?: AbortSignal;
    onProgress?: (progress: number) => void;
  }
): Promise<AudioBuffer>
```

### Options

- `tempo` - tempo multiplier. Defaults to `1`.
- `pitch` - pitch multiplier. Defaults to `1`.
- `signal` - optional `AbortSignal` used to cancel processing.
- `onProgress` - optional callback receiving progress from `0` to `1`.

## Notes

- The input buffer is not modified.
- Processing is performed offline on the complete audio buffer.
- Very long files may require significant memory.
- Extreme tempo or pitch values may introduce audible artifacts.
- Supported input formats depend on the browser.

## Browser support

The library requires support for:

- Web Audio API
- Web Workers
- ES modules
- Transferable `ArrayBuffer` objects

## License

Released under the [MIT License](https://github.com/KrzysieQ123/audio-time-stretch/blob/main/LICENSE).
