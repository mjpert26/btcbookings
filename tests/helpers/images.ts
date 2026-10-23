/** Minimal image byte sequences with valid headers, for logo validation tests. */

function u32be(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

function u24le(n: number): number[] {
  return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
}

function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

export function pngBytes(width = 200, height = 80, padTo = 0): Uint8Array {
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32be(13), ...ascii("IHDR"), ...u32be(width), ...u32be(height), 8, 6, 0, 0, 0, 0, 0, 0, 0];
  const tail = [...u32be(0), ...ascii("IEND"), 0xae, 0x42, 0x60, 0x82];
  const pad = Math.max(0, padTo - head.length - tail.length);
  return Uint8Array.from([...head, ...new Array(pad).fill(0), ...tail]);
}

export function jpegBytes(width = 320, height = 120): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof0 = [0xff, 0xc0, 0x00, 0x11, 8, (height >> 8) & 255, height & 255, (width >> 8) & 255, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return Uint8Array.from([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xd9]);
}

export function webpBytes(width = 400, height = 100): Uint8Array {
  const vp8x = [...ascii("VP8X"), 10, 0, 0, 0, 0, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)];
  const body = [...ascii("WEBP"), ...vp8x];
  const size = body.length;
  return Uint8Array.from([...ascii("RIFF"), size & 255, (size >> 8) & 255, 0, 0, ...body]);
}

export function svgBytes(): Uint8Array {
  return new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
}
