/** LOCAL audio (no Azure): testing the microphone and playing recordings. */

export interface MicOption {
  label: string;
  /** browser deviceId; undefined = system default */
  deviceId?: string;
}

/** Lists the input microphones. The browser only exposes the names after
 * the user grants permission; before that only the default remains
 * (getUserMedia permission-gating). */
export async function listMicrophones(): Promise<MicOption[]> {
  const options: MicOption[] = [{ label: "Predeterminado del sistema" }];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const seen = new Set<string>();
    for (const device of devices) {
      if (device.kind !== "audioinput" || !device.label) continue;
      if (device.deviceId === "default" || seen.has(device.label)) continue;
      seen.add(device.label);
      options.push({ label: device.label, deviceId: device.deviceId });
    }
  } catch {
    // no enumerateDevices: only the default remains
  }
  return options;
}

/** Requests mic permission (and unlocks the enumerateDevices labels as a bonus). */
export async function requestMicPermission(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    return false;
  }
}

/** Records `seconds` from the chosen mic and returns a playable URL, or an
 * error message. This is the mic test (Ctrl+T / "Probar" button). */
export async function recordTest(
  deviceId: string | undefined,
  seconds = 3,
): Promise<{ url: string | null; error: string | null }> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    });
  } catch (exc) {
    return { url: null, error: `No pude abrir el micrófono: ${String(exc)}` };
  }
  return new Promise((resolve) => {
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: recorder.mimeType });
      if (blob.size === 0) {
        resolve({ url: null, error: "El micrófono no grabó nada." });
      } else {
        resolve({ url: URL.createObjectURL(blob), error: null });
      }
    };
    recorder.start();
    setTimeout(() => recorder.stop(), seconds * 1000);
  });
}

/** Plays a recording (objectURL). Returns an error, or null on success.
 * The promise resolves when playback FINISHES. */
export function playRecording(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (err: string | null) => {
      if (settled) return;
      settled = true;
      resolve(err);
    };
    const audio = new Audio(url);
    audio.onended = () => done(null);
    audio.onerror = () => done("No pude reproducir la grabación.");
    audio.onloadedmetadata = () => {
      // MediaRecorder blobs may never fire `ended` (webm reports Infinity
      // duration); without this fallback the caller stays busy forever.
      const ms = Number.isFinite(audio.duration) ? audio.duration * 1000 : 15000;
      setTimeout(() => done(null), ms + 2000);
    };
    audio.play().catch((exc) => done(`No pude reproducir: ${String(exc)}`));
  });
}
