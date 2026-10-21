# audio-time-stretch

[![npm version](https://img.shields/npm/v/audio-time-stretch.svg)](https://npmjs.com/package/audio-time-stretch)
[![license](https://img.shields/github/license/KrzysieQ123/audio-time-stretch)](https://github.com/KrzysieQ123/audio-time-stretch/blob/main/LICENSE)

Pitch-preserving audio time stretching for the Web Audio API.

The library changes the tempo and duration of an `AudioBuffer` without changing its original pitch. Audio processing runs inside a Web Worker.

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
  1.5,
);

const source = context.createBufferSource();

source.buffer = output;
source.connect(context.destination);

await context.resume();
source.start();
```

A rate greater than `1` makes the audio faster:

```js
await stretchAudioBuffer(context, input, 1.5);
```

A rate below `1` makes it slower:

```js
await stretchAudioBuffer(context, input, 0.75);
```

The original pitch is preserved.

## Progress

An optional callback can be used to track processing progress:

```js
const output = await stretchAudioBuffer(
  context,
  input,
  1.5,
  undefined,
  (progress) => {
    console.log(`${Math.round(progress * 100)}%`);
  },
);
```

## Cancellation

Processing can be cancelled with an `AbortController`:

```js
const controller = new AbortController();

const processing = stretchAudioBuffer(
  context,
  input,
  0.75,
  controller.signal,
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
  rate: number,
  signal?: AbortSignal,
  onProgress?: (progress: number) => void,
): Promise<AudioBuffer>
```

### `context`

An `AudioContext` or another `BaseAudioContext` used to create the output buffer.

### `input`

The decoded `AudioBuffer` to process.

### `rate`

The tempo multiplier.

### `signal`

An optional `AbortSignal` used to cancel processing.

### `onProgress`

An optional callback receiving processing progress from `0` to `1`.

## Notes

- The input buffer is not modified.
- Processing is performed offline on the complete audio buffer.
- Very long files may require significant memory.
- Extreme playback rates may introduce audible artifacts.
- Supported audio formats depend on the browser.

## Browser support

The library requires a browser with support for:

- Web Audio API
- Web Workers
- ES modules
- Transferable `ArrayBuffer` objects

## License

Released under the [MIT License](https://github.com/KrzysieQ123/audio-time-stretch/blob/main/LICENSE).