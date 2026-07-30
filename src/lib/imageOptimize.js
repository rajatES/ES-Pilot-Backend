import sharp from "sharp";

// Facebook (and, less strictly, the other platforms) rejects oversized photos
// with an opaque code-100 "Invalid parameter" — no size hint, nothing. So we
// downscale + re-encode images that are too big BEFORE they reach S3, and every
// publish path then fetches platform-safe media. Images already within limits
// pass through byte-for-byte unchanged; videos, animated GIFs and SVGs are left
// alone (resizing them would break animation / rasterize vectors).

const MAX_EDGE = 2048; // longest side — covers FB/IG/Threads/X feed display
const MAX_BYTES = 4 * 1024 * 1024; // conservative Facebook photo ceiling
const PNG_CEILING = 4 * 1024 * 1024; // above this, a re-encoded PNG becomes JPEG

const SKIP = new Set(["image/gif", "image/svg+xml"]);

// Returns { buffer, contentType, ext, changed }. `ext` is set only when the
// output format changed (so callers can fix the object key); `changed` is false
// for pass-through.
export async function optimizeImageBuffer(buffer, mimetype) {
  const passthrough = { buffer, contentType: mimetype, ext: null, changed: false };
  if (typeof mimetype !== "string" || !mimetype.startsWith("image/") || SKIP.has(mimetype)) {
    return passthrough;
  }

  let meta;
  try {
    meta = await sharp(buffer, { failOn: "none" }).metadata();
  } catch {
    return passthrough; // not a decodable raster image (or corrupt) — don't touch it
  }
  if (meta.pages && meta.pages > 1) return passthrough; // multi-frame (animated) — leave it

  const longest = Math.max(meta.width || 0, meta.height || 0);
  const oversized = longest > MAX_EDGE || buffer.byteLength > MAX_BYTES;
  if (!oversized) return passthrough;

  const resize = (s) =>
    longest > MAX_EDGE
      ? s.resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
      : s;

  // .rotate() with no args bakes in EXIF orientation before we strip metadata.
  const base = () => resize(sharp(buffer, { failOn: "none" }).rotate());

  // Keep transparency / graphics as PNG when it fits; otherwise JPEG, which is
  // far smaller for photographic content. Flatten alpha onto white for JPEG.
  const wantsPng = meta.hasAlpha || mimetype === "image/png";
  if (wantsPng) {
    const png = await base().png({ compressionLevel: 9 }).toBuffer();
    if (png.byteLength <= PNG_CEILING) {
      return { buffer: png, contentType: "image/png", ext: "png", changed: true };
    }
    let p = base();
    if (meta.hasAlpha) p = p.flatten({ background: "#ffffff" });
    const jpg = await p.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
    return { buffer: jpg, contentType: "image/jpeg", ext: "jpg", changed: true };
  }

  const jpg = await base().jpeg({ quality: 85, mozjpeg: true }).toBuffer();
  return { buffer: jpg, contentType: "image/jpeg", ext: "jpg", changed: true };
}
