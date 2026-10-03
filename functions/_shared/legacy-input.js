const CANCEL_WAIT_MS = 100;

const badJson = (details = {}) => ({ ok: false, error: 'bad_json', ...details });

async function finishReader(reader, { cancel, telemetry }) {
  let cancelPromise;
  let timer;
  try {
    if (cancel) {
      telemetry.cancelCalled = true;
      try {
        cancelPromise = Promise.resolve().then(() => reader.cancel());
        await Promise.race([
          cancelPromise.then(
            () => { telemetry.cancelSettled = true; },
            () => { telemetry.cancelSettled = true; telemetry.cancelRejected = true; },
          ),
          new Promise((resolve) => { timer = setTimeout(resolve, CANCEL_WAIT_MS); }),
        ]);
        if (!telemetry.cancelSettled) telemetry.cancelTimedOut = true;
      } catch (_error) {
        telemetry.cancelSettled = true;
        telemetry.cancelRejected = true;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        // Observe a late cancellation rejection even after the bounded wait.
        if (cancelPromise) cancelPromise.catch(() => {});
      }
    }
  } finally {
    try {
      reader.releaseLock();
      telemetry.lockReleased = true;
    } catch (_error) {
      telemetry.lockReleased = false;
    }
  }
}

/**
 * Read and parse a legacy JSON request with a byte, rather than Content-Length,
 * budget. The telemetry is deliberately returned for local handler-path tests.
 */
export async function readLegacyJson(request, limit) {
  const telemetry = {
    readCount: 0,
    cancelCalled: false,
    cancelSettled: false,
    cancelRejected: false,
    cancelTimedOut: false,
    lockReleased: false,
  };
  if (!request.body) return { ...badJson(), telemetry };

  let reader;
  try {
    reader = request.body.getReader();
  } catch (_error) {
    return { ...badJson(), telemetry };
  }

  const chunks = [];
  let bytes = 0;
  let completed = false;
  try {
    while (true) {
      let result;
      try {
        result = await reader.read();
        telemetry.readCount += 1;
      } catch (_error) {
        await finishReader(reader, { cancel: true, telemetry });
        return { ...badJson(), telemetry };
      }
      if (!result || typeof result !== 'object' || typeof result.done !== 'boolean') {
        await finishReader(reader, { cancel: true, telemetry });
        return { ...badJson(), telemetry };
      }
      if (result.done) {
        completed = true;
        break;
      }
      if (!(result.value instanceof Uint8Array)) {
        await finishReader(reader, { cancel: true, telemetry });
        return { ...badJson(), telemetry };
      }
      bytes += result.value.byteLength;
      if (bytes > limit) {
        await finishReader(reader, { cancel: true, telemetry });
        return { ok: false, error: 'too_large', field: 'body', limit, bytes, telemetry };
      }
      chunks.push(result.value);
    }

    if (bytes === 0) {
      await finishReader(reader, { cancel: true, telemetry });
      return { ...badJson(), telemetry };
    }
    const all = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      all.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let text;
    try {
      // Target workerd's Request.json semantics: keep a leading BOM for
      // JSON.parse to reject, while preserving U+FEFF inside string values.
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(all);
    } catch (_error) {
      await finishReader(reader, { cancel: true, telemetry });
      return { ...badJson(), telemetry };
    }
    let value;
    try {
      value = JSON.parse(text);
    } catch (_error) {
      await finishReader(reader, { cancel: true, telemetry });
      return { ...badJson(), telemetry };
    }
    await finishReader(reader, { cancel: false, telemetry });
    return { ok: true, value, bytes, telemetry };
  } catch (_error) {
    // Keep all malformed/custom stream implementations on the stable 400 path.
    await finishReader(reader, { cancel: !completed, telemetry });
    return { ...badJson(), telemetry };
  }
}
