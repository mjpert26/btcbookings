import { createHash } from "node:crypto";

/**
 * Validation for partner logo uploads. The file type is decided by its leading bytes, not by
 * the declared type or file name. Only PNG, JPEG and WebP are accepted; SVG and every other
 * format are rejected because they can carry script or are not rendered consistently.
 */

export const LOGO_MAX_BYTES = 512 * 1024;
export const LOGO_MAX_DIMENSION = 4096;
export const LOGO_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type LogoContentType = (typeof LOGO_CONTENT_TYPES)[number];

export type LogoErrorCode = "empty" | "too_large" | "unsupported_type" | "type_mismatch" | "corrupt" | "too_many_pixels";

export class LogoValidationError extends Error {
  constructor(readonly code: LogoErrorCode, message: string) {
    super(message);
    this.name = "LogoValidationError";
  }
}

export type ValidatedLogo = {
  contentType: LogoContentType;
  bytes: Buffer;
  sha256: string;
  width: number | null;
  height: number | null;
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(b: Uint8Array, sig: number[], offset = 0): boolean {
  if (b.length < offset + sig.length) return false;
  return sig.every((v, i) => b[offset + i] === v);
}

function ascii(b: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...b.subarray(offset, offset + length));
}

/** The image format from magic bytes, or null when it is not PNG, JPEG or WebP. */
export function sniffImageType(b: Uint8Array): LogoContentType | null {
  if (startsWith(b, PNG_SIGNATURE)) return "image/png";
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "image/webp";
  return null;
}

type Size = { width: number; height: number };

function pngSize(b: Uint8Array): Size | null {
  // Signature (8), IHDR length (4), "IHDR" (4), width (4), height (4).
  if (b.length < 24 || ascii(b, 12, 4) !== "IHDR") return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegSize(b: Uint8Array): Size | null {
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    // Fill bytes and markers without a length field.
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = (b[i + 2] << 8) | b[i + 3];
    if (length < 2) return null;
    if (JPEG_SOF.has(marker)) {
      if (i + 9 > b.length) return null;
      return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
    }
    i += 2 + length;
  }
  return null;
}

function webpSize(b: Uint8Array): Size | null {
  if (b.length < 30) return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 ") {
    // Frame tag (3) then start code 9D 01 2A, then 14-bit width and height.
    if (!startsWith(b, [0x9d, 0x01, 0x2a], 23)) return null;
    return { width: ((b[27] << 8) | b[26]) & 0x3fff, height: ((b[29] << 8) | b[28]) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    const w = b[24] | (b[25] << 8) | (b[26] << 16);
    const h = b[27] | (b[28] << 8) | (b[29] << 16);
    return { width: w + 1, height: h + 1 };
  }
  return null;
}

export function imageSize(b: Uint8Array, type: LogoContentType): Size | null {
  if (type === "image/png") return pngSize(b);
  if (type === "image/jpeg") return jpegSize(b);
  return webpSize(b);
}

/**
 * Validates an uploaded logo. `declaredType` is the browser-reported type; when given it must
 * match the detected format. Throws LogoValidationError.
 */
export function validateLogo(input: Uint8Array, declaredType?: string | null): ValidatedLogo {
  if (input.byteLength === 0) throw new LogoValidationError("empty", "choose an image file");
  if (input.byteLength > LOGO_MAX_BYTES) throw new LogoValidationError("too_large", "the logo must be 512 KB or smaller");
  const declared = (declaredType ?? "").toLowerCase().split(";")[0].trim();
  if (declared === "image/svg+xml") throw new LogoValidationError("unsupported_type", "SVG logos are not accepted; upload a PNG, JPEG or WebP file");
  const detected = sniffImageType(input);
  if (!detected) throw new LogoValidationError("unsupported_type", "upload a PNG, JPEG or WebP file");
  const declaredNormalized = declared === "image/jpg" || declared === "image/pjpeg" ? "image/jpeg" : declared;
  if (declaredNormalized && declaredNormalized !== "application/octet-stream" && declaredNormalized !== detected) {
    throw new LogoValidationError("type_mismatch", "the file contents do not match its type");
  }
  const size = imageSize(input, detected);
  if (!size || size.width < 1 || size.height < 1) throw new LogoValidationError("corrupt", "the image could not be read");
  if (size.width > LOGO_MAX_DIMENSION || size.height > LOGO_MAX_DIMENSION) {
    throw new LogoValidationError("too_many_pixels", `the logo must be at most ${LOGO_MAX_DIMENSION} pixels on each side`);
  }
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  return {
    contentType: detected,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    width: size.width,
    height: size.height,
  };
}
