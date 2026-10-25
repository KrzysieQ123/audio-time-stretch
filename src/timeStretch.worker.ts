type StretchRequest = {
  channels: ArrayBuffer[];
  sampleRate: number;
  tempo: number;
  pitch: number;
};

type StretchSuccess = {
  ok: true;
  channels: ArrayBuffer[];
  length: number;
};

type StretchFailure = {
  ok: false;
  message: string;
};

type StretchProgress = {
  progress: number;
};

type WorkerScope = {
  onmessage: ((event: MessageEvent<StretchRequest>) => void) | null;
  postMessage(
    message: StretchSuccess | StretchFailure | StretchProgress,
    transfer?: Transferable[],
  ): void;
};

const workerScope = self as unknown as WorkerScope;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const mixChannelsToMono = (channels: Float32Array[]) => {
  const mono = new Float32Array(channels[0].length);
  const channelScale = 1 / channels.length;

  for (
    let channelIndex = 0;
    channelIndex < channels.length;
    channelIndex += 1
  ) {
    const channel = channels[channelIndex];

    for (let index = 0; index < channel.length; index += 1) {
      mono[index] += channel[index] * channelScale;
    }
  }

  return mono;
};

const createFadeInWindow = (length: number) => {
  const window = new Float64Array(length);

  if (length === 1) {
    window[0] = 1;
    return window;
  }

  const denominator = length - 1;

  for (let index = 0; index < length; index += 1) {
    const progress = index / denominator;
    window[index] = 0.5 - 0.5 * Math.cos(Math.PI * progress);
  }

  return window;
};

const calculateSimilarity = (
  output: Float32Array,
  input: Float32Array,
  outputStart: number,
  inputStart: number,
  overlapLength: number,
  correlationStep: number,
  outputEnergy: number,
) => {
  let dot = 0;
  let inputEnergy = 0;

  for (let index = 0; index < overlapLength; index += correlationStep) {
    const outputSample = output[outputStart + index];
    const inputSample = input[inputStart + index];

    dot += outputSample * inputSample;
    inputEnergy += inputSample * inputSample;
  }

  const denominator = Math.sqrt(outputEnergy * inputEnergy);

  return denominator > 1e-12 ? dot / denominator : -1;
};

const findBestInputStart = (
  output: Float32Array,
  input: Float32Array,
  outputStart: number,
  expectedInputStart: number,
  overlapLength: number,
  searchRadius: number,
  searchStep: number,
  correlationStep: number,
  maximumInputStart: number,
) => {
  const minimumCandidate = clamp(
    expectedInputStart - searchRadius,
    0,
    maximumInputStart,
  );

  const maximumCandidate = clamp(
    expectedInputStart + searchRadius,
    0,
    maximumInputStart,
  );

  let bestCandidate = clamp(expectedInputStart, 0, maximumInputStart);

  let bestSimilarity = Number.NEGATIVE_INFINITY;

  let outputEnergy = 0;

  for (let index = 0; index < overlapLength; index += correlationStep) {
    const sample = output[outputStart + index];
    outputEnergy += sample * sample;
  }

  const testCandidate = (candidate: number) => {
    const similarity = calculateSimilarity(
      output,
      input,
      outputStart,
      candidate,
      overlapLength,
      correlationStep,
      outputEnergy,
    );

    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestCandidate = candidate;
    }
  };

  for (
    let candidate = minimumCandidate;
    candidate <= maximumCandidate;
    candidate += searchStep
  ) {
    testCandidate(candidate);
  }

  testCandidate(clamp(expectedInputStart, 0, maximumInputStart));

  return bestCandidate;
};

const cubicInterpolate = (channel: Float32Array, position: number) => {
  const index = Math.floor(position);
  const fraction = position - index;
  const lastIndex = channel.length - 1;

  const sample0 = channel[clamp(index - 1, 0, lastIndex)];
  const sample1 = channel[clamp(index, 0, lastIndex)];
  const sample2 = channel[clamp(index + 1, 0, lastIndex)];
  const sample3 = channel[clamp(index + 2, 0, lastIndex)];

  const fractionSquared = fraction * fraction;
  const fractionCubed = fractionSquared * fraction;

  return (
    0.5 *
    (2 * sample1 +
      (-sample0 + sample2) * fraction +
      (2 * sample0 - 5 * sample1 + 4 * sample2 - sample3) * fractionSquared +
      (-sample0 + 3 * sample1 - 3 * sample2 + sample3) * fractionCubed)
  );
};

const resampleChannels = (
  input: Float32Array[],
  pitch: number,
  onProgress?: (progress: number) => void,
) => {
  const inputLength = input[0].length;
  const outputLength = Math.max(1, Math.ceil(inputLength / pitch));
  const output = input.map(() => new Float32Array(outputLength));
  const totalSamples = outputLength * input.length;

  let processedSamples = 0;
  let lastReportedProgress = -1;

  onProgress?.(0);

  for (let channelIndex = 0; channelIndex < input.length; channelIndex += 1) {
    const inputChannel = input[channelIndex];
    const outputChannel = output[channelIndex];

    for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
      const inputPosition = outputIndex * pitch;

      outputChannel[outputIndex] = cubicInterpolate(
        inputChannel,
        inputPosition,
      );

      processedSamples += 1;

      if (processedSamples % 4096 === 0) {
        const progress = processedSamples / totalSamples;
        const roundedProgress = Math.floor(progress * 100) / 100;

        if (roundedProgress > lastReportedProgress) {
          lastReportedProgress = roundedProgress;
          onProgress?.(roundedProgress);
        }
      }
    }
  }

  onProgress?.(1);

  return output;
};

const stretchChannels = (
  input: Float32Array[],
  sampleRate: number,
  rate: number,
  onProgress?: (progress: number) => void,
) => {
  if (input.length === 0 || input[0].length === 0) {
    throw new Error("Audio buffer doesn't contain any samples.");
  }

  if (!Number.isFinite(rate) || rate <= 0) {
    throw new RangeError("Playback rate must be greater than zero.");
  }

  const inputLength = input[0].length;

  if (Math.abs(rate - 1) < 0.000001) {
    return input.map((channel) => channel.slice());
  }

  const inputMono = mixChannelsToMono(input);
  const outputLength = Math.max(1, Math.round(inputLength / rate));

  const frameLength = Math.min(
    inputLength,
    Math.max(256, Math.round(sampleRate * 0.046)),
  );

  const overlapLength = Math.min(
    Math.floor(frameLength / 2),
    Math.max(64, Math.round(sampleRate * 0.012)),
  );

  const synthesisHop = Math.max(1, frameLength - overlapLength);
  const analysisHop = synthesisHop * rate;

  const searchRadius = Math.max(32, Math.round(sampleRate * 0.012));
  const searchStep = Math.max(1, Math.round(sampleRate / 11025));
  const correlationStep = 4;

  const output = input.map(() => new Float32Array(outputLength));
  const outputMono = new Float32Array(outputLength);
  const fullFadeInWindow = createFadeInWindow(overlapLength);

  const initialLength = Math.min(frameLength, inputLength, outputLength);

  for (let channel = 0; channel < input.length; channel += 1) {
    output[channel].set(input[channel].subarray(0, initialLength), 0);
  }

  outputMono.set(inputMono.subarray(0, initialLength), 0);

  const maximumInputStart = Math.max(0, inputLength - frameLength);

  let outputStart = synthesisHop;

  let lastReportedProgresss = -1;

  onProgress?.(0);

  while (outputStart < outputLength) {
    const expectedInputStart = clamp(
      Math.round((outputStart / synthesisHop) * analysisHop),
      0,
      maximumInputStart,
    );

    const currentOverlapLength = Math.min(
      overlapLength,
      outputLength - outputStart,
      inputLength,
    );

    const inputStart = findBestInputStart(
      outputMono,
      inputMono,
      outputStart,
      expectedInputStart,
      currentOverlapLength,
      searchRadius,
      searchStep,
      correlationStep,
      maximumInputStart,
    );

    const availableInput = inputLength - inputStart;
    const availableOutput = outputLength - outputStart;

    const currentFrameLength = Math.min(
      frameLength,
      availableInput,
      availableOutput,
    );

    const currentCrossfadeLength = Math.min(overlapLength, currentFrameLength);

    const fadeInWindow =
      currentCrossfadeLength === overlapLength
        ? fullFadeInWindow
        : createFadeInWindow(currentCrossfadeLength);

    for (let channel = 0; channel < input.length; channel += 1) {
      const inputChannel = input[channel];
      const outputChannel = output[channel];

      for (let index = 0; index < currentCrossfadeLength; index += 1) {
        const fadeIn = fadeInWindow[index];
        const fadeOut = 1 - fadeIn;

        outputChannel[outputStart + index] =
          outputChannel[outputStart + index] * fadeOut +
          inputChannel[inputStart + index] * fadeIn;
      }

      for (
        let index = currentCrossfadeLength;
        index < currentFrameLength;
        index += 1
      ) {
        outputChannel[outputStart + index] = inputChannel[inputStart + index];
      }
    }

    for (let index = 0; index < currentCrossfadeLength; index += 1) {
      const fadeIn = fadeInWindow[index];
      const fadeOut = 1 - fadeIn;

      outputMono[outputStart + index] =
        outputMono[outputStart + index] * fadeOut +
        inputMono[inputStart + index] * fadeIn;
    }

    for (
      let index = currentCrossfadeLength;
      index < currentFrameLength;
      index += 1
    ) {
      outputMono[outputStart + index] = inputMono[inputStart + index];
    }

    outputStart += synthesisHop;

    const progress = Math.min(1, outputStart / outputLength);
    const roundedProgress = Math.floor(progress * 100) / 100;

    if (roundedProgress > lastReportedProgresss) {
      lastReportedProgresss = roundedProgress;
      onProgress?.(roundedProgress);
    }
  }

  onProgress?.(1);
  return output;
};

workerScope.onmessage = (event) => {
  try {
    const input = event.data.channels.map(
      (channel) => new Float32Array(channel),
    );

    const { tempo, pitch, sampleRate } = event.data;

    if (!Number.isFinite(tempo) || tempo <= 0) {
      throw new RangeError("Tempo must be greater than zero.");
    }

    if (!Number.isFinite(pitch) || pitch <= 0) {
      throw new RangeError("Pitch must be greater than zero.");
    }

    const changesPitch = Math.abs(pitch - 1) >= 0.000001;
    const stretchRate = tempo / pitch;
    const changesStretch = Math.abs(stretchRate - 1) >= 0.000001;

    let output: Float32Array[];

    if (changesPitch && changesStretch) {
      const pitchProgressShare = 0.2;

      const pitched = resampleChannels(input, pitch, (progress) => {
        workerScope.postMessage({
          progress: progress * pitchProgressShare,
        });
      });

      output = stretchChannels(pitched, sampleRate, stretchRate, (progress) => {
        workerScope.postMessage({
          progress: pitchProgressShare + progress * (1 - pitchProgressShare),
        });
      });
    } else if (changesPitch) {
      output = resampleChannels(input, pitch, (progress) => {
        workerScope.postMessage({ progress });
      });
    } else if (changesStretch) {
      output = stretchChannels(input, sampleRate, stretchRate, (progress) => {
        workerScope.postMessage({ progress });
      });
    } else {
      output = input.map((channel) => channel.slice());
      workerScope.postMessage({ progress: 1 });
    }

    const channelBuffers = output.map(
      (channel) => channel.buffer as ArrayBuffer,
    );

    workerScope.postMessage(
      {
        ok: true,
        channels: channelBuffers,
        length: output[0].length,
      },
      channelBuffers,
    );
  } catch (error: unknown) {
    workerScope.postMessage({
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Unknown audio processing error.",
    });
  }
};

export {};
