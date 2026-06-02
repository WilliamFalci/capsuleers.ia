// Robust downloader for the heavy assets (.gguf models, RAG index): downloads
// to a ".part" file with RESUME (HTTP Range), computes the SHA256 in streaming and
// promotes the file only if size and checksum match. Cancelable via
// AbortSignal. No dependency on Electron → testable with `node`.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { USER_AGENT } from "./user-agent.mjs";

function statSize(p) { try { return fs.statSync(p).size; } catch { return 0; } }

// Updates `hash` with the entire content of the file (for: after-the-fact
// verification, and to "seed" the hash with the already-downloaded part on resume).
async function hashInto(filePath, hash, signal) {
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(filePath);
    const onAbort = () => rs.destroy(new Error("Aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    rs.on("data", (c) => hash.update(c));
    rs.on("end", resolve);
    rs.on("error", reject);
  }).finally(() => signal?.removeEventListener?.("abort", () => {}));
}

/** Hexadecimal SHA256 of a file (streaming, low RAM usage). */
export async function fileSha256(filePath, signal) {
  const hash = createHash("sha256");
  await hashInto(filePath, hash, signal);
  return hash.digest("hex");
}

// Writes a chunk respecting the stream's backpressure (the callback returns
// once the data has been accepted/flushed enough).
function writeChunk(stream, chunk) {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Downloads `url` to `dest` with resume and verification.
 * @param {object} o
 * @param {string} o.url          Source URL (follows redirects, e.g. HuggingFace CDN).
 * @param {string} o.dest         Final path of the file.
 * @param {string} [o.sha256]     Expected checksum (hex). If absent, no verification.
 * @param {number} [o.size]       Expected size in bytes (for progress and sanity).
 * @param {(p:{received:number,total:number,speed:number,done?:boolean})=>void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<string>} the `dest` path once the download is complete and verified.
 */
export async function downloadFile({ url, dest, sha256, size, onProgress = () => {}, signal } = {}) {
  if (!url || !dest) throw new Error("downloadFile: url e dest sono obbligatori");
  const part = dest + ".part";
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });

  // 1) Final file already present and valid → nothing to do (idempotent).
  if (fs.existsSync(dest)) {
    const okSize = !size || statSize(dest) === size;
    if (okSize && (!sha256 || (await fileSha256(dest, signal)) === sha256)) {
      const t = statSize(dest);
      onProgress({ received: t, total: t, speed: 0, done: true });
      return dest;
    }
    await fs.promises.unlink(dest).catch(() => {});  // corrupted/different → re-download
  }

  // 2) Resume point: how many bytes are already in the ".part".
  let start = statSize(part);
  if (size && start > size) { await fs.promises.unlink(part).catch(() => {}); start = 0; }

  const headers = { "User-Agent": USER_AGENT };
  if (start > 0) headers.Range = `bytes=${start}-`;
  const res = await fetch(url, { headers, redirect: "follow", signal });
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
  if (!res.body) throw new Error(`Risposta senza corpo — ${url}`);

  // If I requested a Range but the server does NOT honor it (200 instead of 206), restart from 0.
  const append = start > 0 && res.status === 206;
  if (start > 0 && !append) start = 0;

  const total = size || (Number(res.headers.get("content-length")) || 0) + start || 0;

  // 3) Hash: on resume I "seed" it with the part already on disk, so it covers the whole file.
  const hash = createHash("sha256");
  if (append) await hashInto(part, hash, signal);
  else if (fs.existsSync(part)) await fs.promises.unlink(part).catch(() => {});

  const out = fs.createWriteStream(part, { flags: append ? "a" : "w" });
  let received = start, lastT = Date.now(), lastB = start, speed = 0;
  try {
    for await (const chunk of Readable.fromWeb(res.body)) {
      if (signal?.aborted) throw Object.assign(new Error("Download annullato"), { name: "AbortError" });
      hash.update(chunk);
      await writeChunk(out, chunk);
      received += chunk.length;
      const now = Date.now();
      if (now - lastT >= 250) {
        speed = (received - lastB) / ((now - lastT) / 1000);
        lastT = now; lastB = received;
        onProgress({ received, total, speed });
      }
    }
  } finally {
    out.end();
    await new Promise((r) => out.on("close", r));
  }

  // 4) Verify size + checksum before promoting the file.
  if (size && received !== size) throw new Error(`Dimensione inattesa: ${received} ≠ ${size} byte`);
  if (sha256) {
    const got = hash.digest("hex");
    if (got !== sha256) {
      await fs.promises.unlink(part).catch(() => {});
      throw new Error(`SHA256 non combacia: ${got.slice(0, 16)}… ≠ ${sha256.slice(0, 16)}…`);
    }
  }
  await fs.promises.rename(part, dest);
  onProgress({ received, total: received, speed, done: true });
  return dest;
}
