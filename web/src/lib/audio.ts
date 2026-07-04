/** Audio LOCAL (sin Azure): probar el micrófono y reproducir grabaciones.
 * Espejo de `audio.py` (sounddevice + aplay) con las APIs del navegador. */

export interface MicOption {
  label: string;
  /** deviceId del navegador; undefined = predeterminado del sistema */
  deviceId?: string;
}

/** Lista los micrófonos de entrada. El navegador solo muestra los nombres
 * después de que el usuario dio permiso; antes de eso queda solo el
 * predeterminado (permission-gating de getUserMedia). */
export async function listMicrophones(): Promise<MicOption[]> {
  const options: MicOption[] = [{ label: "🎙 Predeterminado del sistema" }];
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
    // sin enumerateDevices: queda solo el predeterminado
  }
  return options;
}

/** Pide permiso de mic (y de paso desbloquea los labels de enumerateDevices). */
export async function requestMicPermission(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    return false;
  }
}

/** Graba `seconds` del mic elegido y devuelve una URL reproducible, o un
 * mensaje de error. Es la prueba de mic (Ctrl+T / botón Probar). */
export function recordTest(
  deviceId: string | undefined,
  seconds = 3,
): Promise<{ url: string | null; error: string | null }> {
  return new Promise(async (resolve) => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      });
    } catch (exc) {
      resolve({ url: null, error: `No pude abrir el micrófono: ${String(exc)}` });
      return;
    }
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

/** Reproduce una grabación (objectURL). Devuelve un error o null si salió bien.
 * La promesa se resuelve cuando TERMINA de sonar. */
export function playRecording(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const audio = new Audio(url);
    audio.onended = () => resolve(null);
    audio.onerror = () => resolve("No pude reproducir la grabación.");
    audio.play().catch((exc) => resolve(`No pude reproducir: ${String(exc)}`));
  });
}
