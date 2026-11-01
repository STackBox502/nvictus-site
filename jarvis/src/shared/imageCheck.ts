// Header-level validation for imported character images (PNG / WebP). No decoding here:
// main additionally decodes PNGs with nativeImage and the renderer decodes before confirming.

export const IMAGE_LIMITS = { maxBytes: 12 * 1024 * 1024, minDim: 64, maxDim: 4096 } as const;

export interface ImageInfo {
  format: 'png' | 'webp';
  mime: 'image/png' | 'image/webp';
  width: number;
  height: number;
  hasAlphaChannel: boolean;
}

export type ImageCheck = { ok: true; info: ImageInfo } | { ok: false; error: string };

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function u32be(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;
}
function u24le(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
}
function ascii(b: Uint8Array, o: number, n: number): string {
  return String.fromCharCode(...b.subarray(o, o + n));
}

function checkPng(b: Uint8Array): ImageCheck {
  if (b.length < 33 || ascii(b, 12, 4) !== 'IHDR') return { ok: false, error: 'PNG header is malformed.' };
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  const colorType = b[25]!;
  let hasAlpha = colorType === 4 || colorType === 6;
  // Look for a tRNS chunk before IDAT (palette/greyscale transparency).
  let o = 8;
  while (!hasAlpha && o + 8 <= b.length) {
    const len = u32be(b, o);
    const type = ascii(b, o + 4, 4);
    if (type === 'tRNS') hasAlpha = true;
    if (type === 'IDAT' || type === 'IEND') break;
    o += 12 + len;
  }
  return { ok: true, info: { format: 'png', mime: 'image/png', width, height, hasAlphaChannel: hasAlpha } };
}

function checkWebp(b: Uint8Array): ImageCheck {
  if (b.length < 30) return { ok: false, error: 'WebP file is truncated.' };
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8X') {
    const flags = b[20]!;
    return {
      ok: true,
      info: { format: 'webp', mime: 'image/webp', width: u24le(b, 24) + 1, height: u24le(b, 27) + 1, hasAlphaChannel: (flags & 0x10) !== 0 },
    };
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return { ok: false, error: 'WebP (lossless) header is malformed.' };
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    const alpha = ((bits >>> 28) & 1) === 1;
    return { ok: true, info: { format: 'webp', mime: 'image/webp', width, height, hasAlphaChannel: alpha } };
  }
  if (chunk === 'VP8 ') {
    const width = (b[26]! | (b[27]! << 8)) & 0x3fff;
    const height = (b[28]! | (b[29]! << 8)) & 0x3fff;
    return { ok: true, info: { format: 'webp', mime: 'image/webp', width, height, hasAlphaChannel: false } };
  }
  return { ok: false, error: 'Unsupported WebP variant.' };
}

export function checkImage(bytes: Uint8Array): ImageCheck {
  if (bytes.length > IMAGE_LIMITS.maxBytes) return { ok: false, error: `File is larger than ${IMAGE_LIMITS.maxBytes / 1024 / 1024} MB.` };
  let res: ImageCheck;
  if (PNG_SIG.every((v, i) => bytes[i] === v)) res = checkPng(bytes);
  else if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') res = checkWebp(bytes);
  else return { ok: false, error: 'Only PNG or WebP images are supported (file signature did not match).' };
  if (!res.ok) return res;
  const { width, height } = res.info;
  if (width < IMAGE_LIMITS.minDim || height < IMAGE_LIMITS.minDim)
    return { ok: false, error: `Image is too small (${width}×${height}); minimum ${IMAGE_LIMITS.minDim}px.` };
  if (width > IMAGE_LIMITS.maxDim || height > IMAGE_LIMITS.maxDim)
    return { ok: false, error: `Image is too large (${width}×${height}); maximum ${IMAGE_LIMITS.maxDim}px per side.` };
  return res;
}
