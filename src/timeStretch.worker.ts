type StretchRequest = {
  channels: ArrayBuffer[];
  sampleRate: number;
  rate: number;
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

const calculateSimilarity = (
  output: Float32Array[],
  input: Float32Array[],
  outputStart: number,
  inputStart: number,
  overlapLength: number,
  correlationStep: number,
) => {
  let dot = 0;
  let outputEnergy = 0;
  let inputEnergy = 0;

  for (let index = 0; index < overlapLength; index += correlationStep) {
    let outputSample = 0;
    let inputSample = 0;

    for (let channel = 0; channel < input.length; channel += 1) {
      outputSample += output[channel][outputStart + index] ?? 0;
      inputSample += input[channel][inputStart + index] ?? 0;
    }

    outputSample /= input.length;
    inputSample /= input.length;

    dot += outputSample * inputSample;
    outputEnergy += outputSample * outputSample;
    inputEnergy += inputSample * inputSample;
  }

  const denominator = Math.sqrt(outputEnergy * inputEnergy);

  return denominator > 1e-12 ? dot / denominator : -1;
};

const findBestInputStart = (
  output: Float32Array[],
  input: Float32Array[],
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

  const testCandidate = (candidate: number) => {
    const similarity = calculateSimilarity(
      output,
      input,
      outputStart,
      candidate,
      overlapLength,
      correlationStep,
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

  const initialLength = Math.min(frameLength, inputLength, outputLength);

  for (let channel = 0; channel < input.length; channel += 1) {
    output[channel].set(input[channel].subarray(0, initialLength), 0);
  }

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
      output,
      input,
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

    for (let channel = 0; channel < input.length; channel += 1) {
      const inputChannel = input[channel];
      const outputChannel = output[channel];

      for (let index = 0; index < currentCrossfadeLength; index += 1) {
        const progress =
          currentCrossfadeLength <= 1
            ? 1
            : index / (currentCrossfadeLength - 1);

        const fadeIn = 0.5 - 0.5 * Math.cos(Math.PI * progress);
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

    const output = stretchChannels(
      input,
      event.data.sampleRate,
      event.data.rate,
      (progress) => {
        workerScope.postMessage({ progress });
      },
    );

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
