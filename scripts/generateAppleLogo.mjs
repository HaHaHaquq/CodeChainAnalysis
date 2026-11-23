/**
 * Apple Space-Black & Metallic Liquid-Silver Chain-Node Logo Generator
 * Matches the user's reference topology emblem:
 * - 3 hollow ring nodes arranged diagonally from bottom-left to top-right connected by smooth S-curves
 * - 1 solid secondary callback branch node extending to bottom-right from the center node
 * - Rendered in Apple's Space Black squircle + Anodized Platinum/Silver & Titanium Sheen palette
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodeRgbaToPng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    makePngChunk("IHDR", ihdr),
    makePngChunk("IDAT", compressed),
    makePngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function clamp(v, lo = 0, hi = 1) {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

// Distance from point P to quadratic Bezier curve (A, B, C) via 14-step subdivision
function distToQuadBezier(px, py, ax, ay, bx, by, cx, cy) {
  let minDist = Infinity;
  const steps = 16;
  let prevX = ax;
  let prevY = ay;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const inv = 1 - t;
    const qx = inv * inv * ax + 2 * inv * t * bx + t * t * cx;
    const qy = inv * inv * ay + 2 * inv * t * by + t * t * cy;

    // Segment distance from (prevX, prevY) to (qx, qy)
    const vx = qx - prevX;
    const vy = qy - prevY;
    const wx = px - prevX;
    const wy = py - prevY;
    const lenSq = vx * vx + vy * vy;
    const u = lenSq > 1e-8 ? clamp((wx * vx + wy * vy) / lenSq) : 0;
    const dx = px - (prevX + u * vx);
    const dy = py - (prevY + u * vy);
    const d = Math.hypot(dx, dy);
    if (d < minDist) minDist = d;

    prevX = qx;
    prevY = qy;
  }
  return minDist;
}

/**
 * Sample pixel at normalized coordinates nx, ny in [-1, 1]
 */
function sampleLogoPixel(nx, ny) {
  // 1. macOS Superellipse Squircle
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const squircleDist =
    Math.pow(Math.pow(ax / 0.88, 4.2) + Math.pow(ay / 0.88, 4.2), 1 / 4.2) - 1.0;

  if (squircleDist > 0.04) {
    return [0, 0, 0, 0];
  }

  const squircleAlpha = 1.0 - smoothstep(-0.015, 0.015, squircleDist);

  // Apple Space Black / Dark Titanium background gradient
  const bgGrad = clamp((ny + 1) * 0.5);
  let bgR = Math.round(38 * (1 - bgGrad) + 13 * bgGrad);
  let bgG = Math.round(40 * (1 - bgGrad) + 14 * bgGrad);
  let bgB = Math.round(45 * (1 - bgGrad) + 17 * bgGrad);

  // Subtle brushed aluminum inner border rim on the squircle
  const borderMask =
    smoothstep(-0.045, -0.015, squircleDist) *
    (1 - smoothstep(-0.015, 0.01, squircleDist));
  const rimHighlight = clamp((1 - ny) * 0.68);
  bgR = Math.round(bgR + borderMask * 95 * rimHighlight);
  bgG = Math.round(bgG + borderMask * 98 * rimHighlight);
  bgB = Math.round(bgB + borderMask * 106 * rimHighlight);

  // 2. Chain-Node Topology Emblem Geometry (matching user's 2nd uploaded image)
  // Coordinates of the 3 hollow main-chain rings + 1 solid callback branch dot:
  // Node 1 (bottom-left hollow ring): (-0.40, 0.28)
  // Node 2 (center hollow ring):      (-0.02, -0.02)
  // Node 3 (top-right hollow ring):   (0.38, -0.34)
  // Node 4 (bottom-right solid dot):  (0.38, 0.24)
  const n1x = -0.40,
    n1y = 0.28;
  const n2x = -0.02,
    n2y = -0.02;
  const n3x = 0.38,
    n3y = -0.34;
  const n4x = 0.38,
    n4y = 0.24;

  const outerR = 0.165;
  const innerR = 0.082;
  const strokeHalf = 0.042;

  const dCenter1 = Math.hypot(nx - n1x, ny - n1y);
  const dCenter2 = Math.hypot(nx - n2x, ny - n2y);
  const dCenter3 = Math.hypot(nx - n3x, ny - n3y);
  const dCenter4 = Math.hypot(nx - n4x, ny - n4y);

  // Ring SDFs: max(|d - midR| - halfThick)
  const ringMid = (outerR + innerR) * 0.5;
  const ringHalf = (outerR - innerR) * 0.5;
  const dRing1 = Math.abs(dCenter1 - ringMid) - ringHalf;
  const dRing2 = Math.abs(dCenter2 - ringMid) - ringHalf;
  const dRing3 = Math.abs(dCenter3 - ringMid) - ringHalf;

  // Curved links between rings (clipped inside the hollow center of the 3 rings!)
  // Link 1->2 (subtle S-wave curve)
  const dCurve12 =
    distToQuadBezier(nx, ny, n1x + 0.09, n1y - 0.08, -0.22, 0.04, n2x - 0.09, n2y + 0.08) -
    strokeHalf;
  // Link 2->3
  const dCurve23 =
    distToQuadBezier(nx, ny, n2x + 0.09, n2y - 0.08, 0.16, -0.24, n3x - 0.09, n3y + 0.08) -
    strokeHalf;

  // Main chain SDF (carve out the hollow interiors of the 3 rings so links don't cross inside)
  let mainChainDist = Math.min(dRing1, dRing2, dRing3, dCurve12, dCurve23);
  const insideHole =
    dCenter1 < innerR || dCenter2 < innerR || dCenter3 < innerR;
  if (insideHole) {
    mainChainDist = Math.min(dRing1, dRing2, dRing3);
  }

  // Secondary callback branch (Node 2 -> Node 4 solid dot)
  const dBranchCurve =
    distToQuadBezier(nx, ny, n2x + 0.09, n2y + 0.07, 0.17, 0.15, n4x - 0.04, n4y - 0.02) -
    strokeHalf * 0.85;
  const dDot4 = dCenter4 - 0.092;
  let branchDist = Math.min(dBranchCurve, dDot4);
  if (dCenter2 < outerR - 0.01) {
    branchDist = 1.0; // cleanly tuck behind center ring
  }

  const mainMask = 1.0 - smoothstep(-0.018, 0.018, mainChainDist);
  const branchMask = (1.0 - smoothstep(-0.018, 0.018, branchDist)) * (1.0 - mainMask);

  // Subtle ambient drop shadow under the emblem for Apple 3D metallic depth
  const shadowDist = Math.min(mainChainDist, branchDist);
  const shadowMask = clamp(1.0 - smoothstep(0.0, 0.14, shadowDist)) * 0.35;
  bgR = Math.round(bgR * (1 - shadowMask));
  bgG = Math.round(bgG * (1 - shadowMask));
  bgB = Math.round(bgB * (1 - shadowMask));

  let outR = bgR;
  let outG = bgG;
  let outB = bgB;

  if (branchMask > 0.001) {
    // Secondary branch: Apple Cool Titanium / Frosted Machined Silver (#C7C7CC -> #8E8E93)
    const gy = clamp((ny + 0.6) / 1.3);
    const bVal = 208 * (1 - gy * 0.32);
    const brR = clamp(Math.round(bVal - 4), 0, 255);
    const brG = clamp(Math.round(bVal + 2), 0, 255);
    const brB = clamp(Math.round(bVal + 12), 0, 255);

    outR = Math.round(outR * (1 - branchMask) + brR * branchMask);
    outG = Math.round(outG * (1 - branchMask) + brG * branchMask);
    outB = Math.round(outB * (1 - branchMask) + brB * branchMask);
  }

  if (mainMask > 0.001) {
    // Main 3-node chain: Apple Bright Liquid Silver / Platinum gradient (#FFFFFF -> #E5E5EA -> #98989F)
    const gy = clamp((ny + 0.65) / 1.3);
    const gx = clamp((nx + 0.65) / 1.3);
    const sheen = Math.exp(-Math.pow(gy - 0.4 + gx * 0.14, 2) / 0.045) * 28;
    const baseVal = 250 * (1 - gy * 0.33) + sheen;

    const fgR = clamp(Math.round(baseVal), 0, 255);
    const fgG = clamp(Math.round(baseVal + 1), 0, 255);
    const fgB = clamp(Math.round(baseVal + 5), 0, 255);

    outR = Math.round(outR * (1 - mainMask) + fgR * mainMask);
    outG = Math.round(outG * (1 - mainMask) + fgG * mainMask);
    outB = Math.round(outB * (1 - mainMask) + fgB * mainMask);
  }

  return [outR, outG, outB, Math.round(squircleAlpha * 255)];
}

function renderIconRgba(size) {
  const buf = Buffer.alloc(size * size * 4);
  const offsets = [-0.25, 0.25];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rSum = 0,
        gSum = 0,
        bSum = 0,
        aSum = 0;
      for (const oy of offsets) {
        for (const ox of offsets) {
          const nx = ((x + 0.5 + ox) / size) * 2 - 1;
          const ny = ((y + 0.5 + oy) / size) * 2 - 1;
          const [r, g, b, a] = sampleLogoPixel(nx, ny);
          rSum += r;
          gSum += g;
          bSum += b;
          aSum += a;
        }
      }
      const idx = (y * size + x) * 4;
      buf[idx] = rSum >> 2;
      buf[idx + 1] = gSum >> 2;
      buf[idx + 2] = bSum >> 2;
      buf[idx + 3] = aSum >> 2;
    }
  }
  return buf;
}

function buildMultiSizeIco(pngBuffersWithSizes) {
  const count = pngBuffersWithSizes.length;
  const header = Buffer.alloc(6 + count * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  let dataOffset = 6 + count * 16;
  pngBuffersWithSizes.forEach(({ size, png }, i) => {
    const entryOffset = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, entryOffset);
    header.writeUInt8(size >= 256 ? 0 : size, entryOffset + 1);
    header.writeUInt8(0, entryOffset + 2);
    header.writeUInt8(0, entryOffset + 3);
    header.writeUInt16LE(1, entryOffset + 4);
    header.writeUInt16LE(32, entryOffset + 6);
    header.writeUInt32LE(png.length, entryOffset + 8);
    header.writeUInt32LE(dataOffset, entryOffset + 12);
    dataOffset += png.length;
  });

  return Buffer.concat([header, ...pngBuffersWithSizes.map((x) => x.png)]);
}

const iconsDir = path.resolve("src-tauri/icons");
fs.mkdirSync(iconsDir, { recursive: true });

const png16 = encodeRgbaToPng(16, 16, renderIconRgba(16));
const png24 = encodeRgbaToPng(24, 24, renderIconRgba(24));
const png32 = encodeRgbaToPng(32, 32, renderIconRgba(32));
const png48 = encodeRgbaToPng(48, 48, renderIconRgba(48));
const png64 = encodeRgbaToPng(64, 64, renderIconRgba(64));
const png128 = encodeRgbaToPng(128, 128, renderIconRgba(128));
const png256 = encodeRgbaToPng(256, 256, renderIconRgba(256));

fs.writeFileSync(path.join(iconsDir, "32x32.png"), png32);
fs.writeFileSync(path.join(iconsDir, "128x128.png"), png128);
fs.writeFileSync(path.join(iconsDir, "128x128@2x.png"), png256);
fs.writeFileSync(path.join(iconsDir, "icon.png"), png256);

const icoBuf = buildMultiSizeIco([
  { size: 16, png: png16 },
  { size: 24, png: png24 },
  { size: 32, png: png32 },
  { size: 48, png: png48 },
  { size: 64, png: png64 },
  { size: 128, png: png128 },
  { size: 256, png: png256 },
]);
fs.writeFileSync(path.join(iconsDir, "icon.ico"), icoBuf);

console.log("Generated Apple-silver Chain-Node topology icons (16..256px) in src-tauri/icons/");
