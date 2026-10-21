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
  rate: number,
  signal?: AbortSignal,
  onProgress?: (progress: number) => void,
): Promise<AudioBuffer> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
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
          rate,
        },
        transfers,
      );
    } catch (error) {
      rejectOnce(error);
    }
  });
