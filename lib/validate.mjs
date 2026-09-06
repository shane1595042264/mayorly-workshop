/**
 * Mayorly asset validator.
 *
 * Zero dependencies. Runs unchanged in a browser, in Node 18+, and in CI.
 *
 * It parses the PNG bytes itself rather than going through a canvas, because
 * three rules in the art standard are invisible to a canvas: the 2D pipeline
 * premultiplies alpha, so getImageData returns 0,0,0 for every alpha-0 pixel
 * no matter what the file holds. A canvas-only check for stale RGB can never
 * fail, which is worse than no check at all. Colour type and embedded ICC
 * profiles are likewise not exposed by canvas.
 *
 * The only platform requirement is DecompressionStream, which is standard in
 * browsers and in Node 18+.
 */

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
export const COLOUR_TYPE = { 0: 'greyscale', 2: 'RGB', 3: 'indexed', 4: 'grey+alpha', 6: 'RGBA' };

const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Parse a PNG into metadata plus true, non-premultiplied RGBA. */
export async function parsePNG(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (buf.length < 8) return { error: 'file is too short to be a PNG' };
  for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) return { error: 'not a PNG (bad signature)' };

  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 8, ihdr = null, plte = null, trns = null, iccp = false, apng = false;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
    const body = off + 8;
    if (body + len > buf.length) return { error: `truncated ${type} chunk` };
    if (type === 'IHDR') ihdr = {
      w: dv.getUint32(body), h: dv.getUint32(body + 4),
      depth: buf[body + 8], color: buf[body + 9], interlace: buf[body + 12],
    };
    else if (type === 'PLTE') plte = buf.subarray(body, body + len);
    else if (type === 'tRNS') trns = buf.subarray(body, body + len);
    else if (type === 'IDAT') idat.push(buf.subarray(body, body + len));
    else if (type === 'iCCP') iccp = true;
    else if (type === 'acTL') apng = true;
    else if (type === 'IEND') break;
    off = body + len + 4;
  }
  if (!ihdr) return { error: 'no IHDR chunk' };
  const meta = { ...ihdr, iccp, apng, trns: !!trns };

  // Adam7 and non-8-bit depths are rejected by the standard anyway, so we do
  // not un-interlace. Report metadata and skip the pixel pass.
  if (ihdr.depth !== 8 || ihdr.interlace !== 0)
    return { meta, noPixels: `depth ${ihdr.depth}, interlace ${ihdr.interlace}` };

  const bpp = CHANNELS[ihdr.color];
  if (!bpp) return { meta, noPixels: `unknown colour type ${ihdr.color}` };

  let raw;
  try {
    const total = idat.reduce((n, c) => n + c.length, 0);
    const z = new Uint8Array(total);
    let q = 0; for (const c of idat) { z.set(c, q); q += c.length; }
    const stream = new Blob([z]).stream().pipeThrough(new DecompressionStream('deflate'));
    raw = new Uint8Array(await new Response(stream).arrayBuffer());
  } catch { return { meta, noPixels: 'IDAT inflate failed' }; }

  const stride = ihdr.w * bpp;
  if (raw.length < ihdr.h * (stride + 1)) return { meta, noPixels: 'IDAT shorter than declared size' };

  const out = new Uint8Array(ihdr.h * stride);
  let pos = 0;
  for (let y = 0; y < ihdr.h; y++) {
    const ft = raw[pos++], line = y * stride, prev = line - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[pos + x];
      const a = x >= bpp ? out[line + x - bpp] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = (x >= bpp && y > 0) ? out[prev + x - bpp] : 0;
      out[line + x] = (ft === 0 ? v : ft === 1 ? v + a : ft === 2 ? v + b
        : ft === 3 ? v + ((a + b) >> 1) : v + paeth(a, b, c)) & 255;
    }
    pos += stride;
  }

  const px = new Uint8Array(ihdr.w * ihdr.h * 4);
  for (let i = 0, n = ihdr.w * ihdr.h; i < n; i++) {
    const o = i * 4, k = i * bpp;
    if (ihdr.color === 6) { px[o] = out[k]; px[o + 1] = out[k + 1]; px[o + 2] = out[k + 2]; px[o + 3] = out[k + 3]; }
    else if (ihdr.color === 2) { px[o] = out[k]; px[o + 1] = out[k + 1]; px[o + 2] = out[k + 2]; px[o + 3] = 255; }
    else if (ihdr.color === 3) {
      const j = out[k] * 3;
      px[o] = plte ? plte[j] : 0; px[o + 1] = plte ? plte[j + 1] : 0; px[o + 2] = plte ? plte[j + 2] : 0;
      px[o + 3] = trns && out[k] < trns.length ? trns[out[k]] : 255;
    }
    else if (ihdr.color === 0) { px[o] = px[o + 1] = px[o + 2] = out[k]; px[o + 3] = 255; }
    else { px[o] = px[o + 1] = px[o + 2] = out[k]; px[o + 3] = out[k + 1]; }
  }
  return { meta, px };
}

const MAGENTA = 0xFF00FF;

/** Parse a Lospec .hex file (one RRGGBB per line) into a Set of packed ints. */
export function loadPalette(text) {
  return new Set(String(text).split(/\r?\n/)
    .map(l => l.trim().replace(/^#/, ''))
    .filter(l => /^[0-9a-fA-F]{6}$/.test(l))
    .map(l => parseInt(l, 16)));
}

/** Count everything the rules care about in a single pass. */
export function analyse(px) {
  let opaque = 0, semi = 0, clear = 0, stale = 0, magenta = 0;
  const palette = new Map();
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (a === 0) { clear++; if (px[i] || px[i + 1] || px[i + 2]) stale++; continue; }
    if (a < 255) { semi++; continue; }
    opaque++;
    const k = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
    if (k === MAGENTA) magenta++;
    palette.set(k, (palette.get(k) || 0) + 1);
  }
  return { opaque, semi, clear, stale, magenta, palette };
}

/** Canvas size a spec expects, accounting for vertical animation strips. */
export const canvasOf = spec => ({
  w: spec.w,
  h: spec.strip ? spec.h * spec.frames : spec.h,
});

/**
 * Validate bytes against a slot spec.
 * Returns { ok, blocking, warnings, checks }. A check with soft:true never blocks.
 */
export async function validate(bytes, spec) {
  const checks = [];
  const add = (id, ok, label, value, soft = false, fix = null) =>
    checks.push({ id, ok, label, value, soft, fix });
  const want = canvasOf(spec);

  const P = await parsePNG(bytes);
  if (P.error) {
    add('png.signature', false, 'File is a valid PNG', P.error);
    return finish(checks);
  }
  add('png.signature', true, 'File is a valid PNG', 'ok');

  const m = P.meta;
  // Aseprite writes colour type 2 whenever the sprite has a VISIBLE BACKGROUND
  // LAYER. Sprite::isOpaque() is literally `bg && bg->isVisible()`, so this has
  // nothing to do with how opaque the pixels are. The New Sprite dialog offers a
  // Background layer, so this is the first thing a beginner trips on.
  // RGBA (6) or Indexed (3) are both fine: we decode both to true RGBA below.
  // Indexed is actually preferred, since the scaffold ships with the palette
  // baked in and off-palette colours become impossible. RGB (2) is the
  // Background-layer trap and is rejected.
  add('png.colorType', m.color === 6 || m.color === 3, 'RGBA or Indexed PNG', COLOUR_TYPE[m.color] || m.color, false,
    m.color === 2 ? 'Your sprite has a visible Background layer. In Aseprite: Layer menu > Background > Convert to Layer. Aseprite drops the alpha channel whenever a Background layer is visible.'
    : 'Export as an RGBA PNG, or keep the scaffold\'s Indexed mode.');
  if (m.color === 3)
    add('png.indexedAlpha', m.trns, 'Indexed PNG has a transparent index', m.trns ? 'tRNS present' : 'no tRNS chunk', !!spec.opaque,
      'The transparent colour was lost. In Aseprite: Sprite > Properties, set Transparent Color to index 0, then save.');
  add('png.depth', m.depth === 8, '8 bits per channel', `${m.depth}-bit`, false,
    'Export at 8 bits per channel, which is the PNG default.');
  add('png.interlace', m.interlace === 0, 'Not interlaced', m.interlace ? 'Adam7' : 'none', false,
    'Turn off interlacing on export.');
  add('png.iccp', !m.iccp, 'No embedded ICC profile', m.iccp ? 'iCCP present' : 'none', false,
    'In Aseprite: Sprite menu > Properties > Color Profile, set it to sRGB. A profile shifts your colours between the editor and the game.');
  add('canvas.size', m.w === want.w && m.h === want.h,
    `Canvas is exactly ${want.w}x${want.h}`, `${m.w}x${m.h}`, false,
    `Run: tf scaffold ${spec.id || '<slot-id>'}  to get a canvas at the right size. Or in Aseprite: Sprite menu > Canvas Size.`);

  if (!P.px) {
    add('pixels.readable', false, 'Pixels readable', P.noPixels || 'unavailable');
    return finish(checks);
  }

  const a = analyse(P.px);
  add('alpha.binary', a.semi === 0, 'Binary alpha, no soft edges',
    a.semi ? `${a.semi} semi-transparent px` : 'clean', false,
    'Anti-aliasing is on somewhere. Use the Pencil tool, not the Brush, and turn off any soft edge or blur. Soft pixels look blurry once the game scales the sprite up 3x.');
  // Ground tiles cover their whole square, so a fully opaque tile is correct,
  // not suspicious. Only props, icons and characters are expected to have
  // transparency around them.
  if (!spec.opaque)
    add('alpha.present', a.clear > 0, 'Has a transparent background',
      a.clear ? `${a.clear} clear px` : 'fully opaque', true,
      'Props, icons and characters should have transparent space around them so they sit on the ground rather than on a square.');
  add('alpha.clean', a.stale === 0, 'Transparent pixels are RGB 0,0,0',
    a.stale ? `${a.stale} px carry stale colour` : 'clean', false,
    'Colour is hiding under transparent pixels. Select the area and use Edit > Clear rather than painting over it with a transparent colour. It is invisible in the editor and fringes in the game.');
  add('palette.cap', a.palette.size > 0 && a.palette.size <= spec.colors,
    `Colours within the cap of ${spec.colors}`,
    a.palette.size ? `${a.palette.size} used` : 'no opaque pixels', false,
    `Reduce to ${spec.colors} colours or fewer. This is the single biggest thing that separates professional pixel art from amateur pixel art, so treat it as a design tool rather than a limit.`);
  add('palette.sentinel', a.magenta === 0, 'No #FF00FF (missing-asset sentinel)',
    a.magenta ? `${a.magenta} magenta px` : 'none', false,
    'Pure magenta #FF00FF is reserved for missing art. Nudge the colour slightly.');
  // Warning tier, not blocking. Straying off the master palette is usually a
  // mistake, but it is a judgement call, and a blocked submission over a
  // deliberate choice would be worse than a note.
  if (spec.masterPalette && a.palette.size) {
    const stray = [...a.palette.keys()].filter(k => !spec.masterPalette.has(k));
    add('palette.master', stray.length === 0, 'On the master palette',
      stray.length ? `${stray.length} off-palette: ${stray.slice(0, 4).map(k => '#' + k.toString(16).padStart(6, '0')).join(' ')}${stray.length > 4 ? '…' : ''}` : 'all on palette',
      true,
      'Load palette/resurrect-64.gpl in Aseprite and pick from it. Off-palette colours are allowed but they are usually an accident, and palette consistency is most of what makes a set of sprites look like one game.');
  }

  const fill = a.opaque / (m.w * m.h || 1);
  add('content.notBlank', fill > 0.03, 'Canvas is not blank', `${Math.round(fill * 100)}% opaque`, false,
    'Nothing drawn yet.');

  if (spec.frames > 1 && spec.strip) {
    const fh = m.h / spec.frames, whole = Number.isInteger(fh);
    add('frames.divides', whole, `Height divides by ${spec.frames} frames`,
      whole ? `${fh}px per frame` : `${m.h} / ${spec.frames} is not whole`, false,
      `Export with --sheet-type vertical so frames stack top to bottom, ${spec.frames} of them.`);
    if (whole) {
      let empty = 0;
      for (let f = 0; f < spec.frames; f++) {
        let any = false;
        for (let y = f * fh; y < (f + 1) * fh && !any; y++)
          for (let x = 0; x < m.w; x++) if (P.px[((y * m.w + x) << 2) + 3] > 0) { any = true; break; }
        if (!any) empty++;
      }
      add('frames.allDrawn', empty === 0, 'Every frame is drawn',
        empty ? `${empty} blank` : `all ${spec.frames} drawn`, false,
        'A frame is empty. Never export with --ignore-empty: it silently removes the blank frame and shifts every frame after it, so the animation desyncs without any error.');
    }
  }
  return finish(checks, { meta: m, palette: [...a.palette.entries()].sort((x, y) => y[1] - x[1]) });
}

function finish(checks, extra = {}) {
  const blocking = checks.filter(c => !c.ok && !c.soft);
  const warnings = checks.filter(c => !c.ok && c.soft);
  return { ok: blocking.length === 0, blocking, warnings, checks, ...extra };
}

/**
 * True when the only thing wrong is that nobody has drawn anything yet.
 * A scaffolded canvas trips two rules (no opaque pixels, and blank), so this
 * has to look at the set rather than count to one.
 */
export function isUntouched(result) {
  if (result.ok) return false;
  const ids = new Set(result.blocking.map(c => c.id));
  ids.delete('content.notBlank');
  ids.delete('palette.cap');
  return ids.size === 0 && result.blocking.some(c => c.id === 'content.notBlank');
}

/** One-line human summary, used by CI and by the PR comment. */
export function summarise(result, name) {
  if (result.ok) {
    return `PASS  ${name}` + result.warnings
      .map(c => `\n        ! ${c.label}: ${c.value}  (advisory, does not block)`).join('');
  }
  return `FAIL  ${name}\n` + result.blocking
    .map(c => `        - ${c.label}: ${c.value}` + (c.fix ? `\n          ${c.fix}` : '')).join('\n');
}
