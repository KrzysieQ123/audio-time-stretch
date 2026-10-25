export type AudioTransformOptions = {
  tempo?: number;
  pitch?: number;
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
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

type StretchResponse = StretchSuccess | StretchFailure | StretchProgress;

declare const __TIME_STRETCH_WORKER_FILE__: string;

export const stretchAudioBuffer = (
  context: BaseAudioContext,
  input: AudioBuffer,
  options: AudioTransformOptions = {},
): Promise<AudioBuffer> => {
  const { tempo = 1, pitch = 1, signal, onProgress } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    if (!Number.isFinite(tempo) || tempo <= 0) {
      reject(new RangeError("Tempo must be greater than zero."));
      return;
    }

    if (!Number.isFinite(pitch) || pitch <= 0) {
      reject(new RangeError("Pitch must be greater than zero."));
      return;
    }

    const changesTempo = Math.abs(tempo - 1) >= 0.000001;
    const changesPitch = Math.abs(pitch - 1) >= 0.000001;

    if (!changesTempo && !changesPitch) {
      try {
        const output = context.createBuffer(
          input.numberOfChannels,
          input.length,
          input.sampleRate,
        );

        for (
          let channelIndex = 0;
          channelIndex < input.numberOfChannels;
          channelIndex += 1
        ) {
          output.copyToChannel(
            input.getChannelData(channelIndex),
            channelIndex,
          );
        }

        onProgress?.(1);
        resolve(output);
      } catch (error) {
        reject(error);
      }

      return;
    }

    const worker = new Worker(
      new URL(__TIME_STRETCH_WORKER_FILE__, import.meta.url),
      {
        type: "module",
      },
    );

    let settled = false;

    const cleanup = () => {
      signal?.removeEventListener("abort", handleAbort);
      worker.terminate();
    };

    const rejectOnce = (error: unknown) => {
      if (settled) return;

      settled = true;
      cleanup();
      reject(error);
    };

    const handleAbort = () => {
      rejectOnce(new DOMException("Aborted", "AbortError"));
    };

    worker.onerror = (event) => {
      rejectOnce(new Error(event.message || "Audio processing worker failed."));
    };

    worker.onmessage = (event: MessageEvent<StretchResponse>) => {
      if (settled) return;

      const response = event.data;

      if ("progress" in response) {
        onProgress?.(Math.min(1, Math.max(0, response.progress)));
        return;
      }

      if (!response.ok) {
        rejectOnce(new Error(response.message));
        return;
      }

      settled = true;
      cleanup();

      try {
        const output = context.createBuffer(
          response.channels.length,
          response.length,
          input.sampleRate,
        );

        response.channels.forEach((channelBuffer, channelIndex) => {
          output.copyToChannel(new Float32Array(channelBuffer), channelIndex);
        });

        resolve(output);
      } catch (error) {
        reject(error);
      }
    };

    signal?.addEventListener("abort", handleAbort, { once: true });

    const channels = Array.from(
      { length: input.numberOfChannels },
      (_, channelIndex) => input.getChannelData(channelIndex).slice(),
    );

    const transfers = channels.map((channel) => channel.buffer as ArrayBuffer);

    try {
      worker.postMessage(
        {
          channels: transfers,
          sampleRate: input.sampleRate,
          tempo,
          pitch,
        },
        transfers,
      );
    } catch (error) {
      rejectOnce(error);
    }
  });
};
