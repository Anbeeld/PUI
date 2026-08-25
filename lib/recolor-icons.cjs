// Dependency-free PNG recolor: decode -> recolor -> encode.
// No GDI+, no System.Drawing. Pure Node with zlib.
const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let off = 8, width, height, bitDepth, colorType, interlace;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12]; }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0) throw new Error("unsupported");
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  if (ch !== 4) throw new Error("only RGBA supported, got colorType " + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const px = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const rs = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[rs + x];
      const a = x >= 4 ? px[y * stride + x - 4] : 0;
      const b = prev[x];
      const c = x >= 4 ? prev[x - 4] : 0;
      let v;
      switch (f) {
        case 0: v = rawByte; break;
        case 1: v = (rawByte + a) & 0xff; break;
        case 2: v = (rawByte + b) & 0xff; break;
        case 3: v = (rawByte + ((a + b) >> 1)) & 0xff; break;
        case 4: { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = (rawByte + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff; break; }
        default: throw new Error("bad filter " + f);
      }
      px[y * stride + x] = v;
    }
    prev = px.subarray(y * stride, y * stride + stride);
  }
  return { width, height, px, stride };
}

function encodePng(width, height, px) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    px.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const compressed = zlib.deflateSync(raw);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  function chunk(type, data) {
    const h = Buffer.alloc(8);
    h.writeUInt32BE(data.length, 0);
    h.write(type, 4, 4, "ascii");
    const crc = Buffer.alloc(4);
    const crcInput = Buffer.concat([Buffer.from(type, "ascii"), data]);
    crc.writeUInt32BE(crc32(crcInput), 0);
    return Buffer.concat([h, data, crc]);
  }
  function crc32(buf) {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  }
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", compressed), Buffer.from([0,0,0,0,0x49,0x45,0x4e,0x44,0xae,0x42,0x60,0x82])]);
}

function recolor(srcPath, dstPath, br, bg, bb) {
  const img = decodePng(fs.readFileSync(srcPath));
  const { width: w, height: h, px, stride } = img;
  const pc = w * h;

  // Pass 1: recolor non-transparent pixels to bubble color.
  for (let i = 0; i < pc; i++) {
    if (px[i * 4 + 3] > 0) { px[i*4] = br; px[i*4+1] = bg; px[i*4+2] = bb; }
  }

  // Pass 2: flood fill from borders across A < 250.
  const outside = new Uint8Array(pc);
  const stack = [];
  for (let x = 0; x < w; x++) { stack.push(x); stack.push((h-1)*w + x); }
  for (let y = 0; y < h; y++) { stack.push(y * w); stack.push(y * w + (w - 1)); }
  while (stack.length) {
    const idx = stack.pop();
    if (outside[idx]) continue;
    if (px[idx * 4 + 3] >= 250) continue;
    outside[idx] = 1;
    const x = idx % w;
    if (x > 0) stack.push(idx - 1);
    if (x < w - 1) stack.push(idx + 1);
    if (idx >= w) stack.push(idx - w);
    if (idx < pc - w) stack.push(idx + w);
  }

  // Pass 3: fill enclosed non-solid pixels (the glyph) with white.
  let filled = 0;
  for (let i = 0; i < pc; i++) {
    if (outside[i]) continue;
    const a = px[i * 4 + 3];
    if (a >= 250) continue;
    const t = a / 255;
    px[i * 4]     = Math.round(255 * (1 - t) + br * t);
    px[i * 4 + 1] = Math.round(255 * (1 - t) + bg * t);
    px[i * 4 + 2] = Math.round(255 * (1 - t) + bb * t);
    px[i * 4 + 3] = 255;
    filled++;
  }

  fs.writeFileSync(dstPath, encodePng(w, h, px));
  return `${w}x${h}: filled ${filled} glyph px, bubble=#${br.toString(16).padStart(2,"0")}${bg.toString(16).padStart(2,"0")}${bb.toString(16).padStart(2,"0")}`;
}

const [,, srcDir, outDir, bubbleHex] = process.argv;
if (!srcDir || !outDir) { console.error("usage: node recolor-icons.cjs <srcDir> <outDir> [bubbleHex]"); process.exit(2); }
const hex = bubbleHex || "#2E6D7A";
const r = parseInt(hex.replace("#","").slice(0,2), 16);
const g = parseInt(hex.replace("#","").slice(2,4), 16);
const b = parseInt(hex.replace("#","").slice(4,8), 16);
fs.mkdirSync(outDir, { recursive: true });
for (const name of ["icon-512.png", "icon-192.png", "apple-touch-icon.png"]) {
  console.log(`wrote ${outDir}/${name} (${recolor(`${srcDir}/${name}`, `${outDir}/${name}`, r, g, b)})`);
}