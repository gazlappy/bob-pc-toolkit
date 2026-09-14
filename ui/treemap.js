'use strict';

// Squarified treemap, drawn on a canvas with cushion shading.
//
// Every rectangle's area is proportional to the bytes it represents, so the
// thing filling your disk is literally the biggest shape on screen. The
// squarified layout (Bruls, Huizing & van Wijk) keeps rectangles close to
// square, which makes their areas far easier to compare by eye than the naive
// slice-and-dice alternative.
//
// The tiles are shaded like little cushions — light from the top-left, a darker
// falloff to the bottom-right, rounded corners and a drop shadow — which is the
// same trick WinDirStat uses to make a flat mosaic read as physical objects.
//
// Two canvases: the map is drawn once into an offscreen buffer, and hovering
// just blits that buffer and redraws the one tile under the cursor. Without
// that, every mouse move would re-render a few thousand gradients.

const TYPES = [
  { id: 'video', color: '#7c6ef0', label: 'Video', ext: 'mp4 mkv avi mov wmv m4v webm flv mpg mpeg' },
  { id: 'image', color: '#2fa15b', label: 'Images', ext: 'jpg jpeg png gif bmp tif tiff webp heic psd svg ico raw cr2 nef dds tga' },
  { id: 'audio', color: '#d08a2e', label: 'Audio', ext: 'mp3 wav flac ogg m4a aac wma mid aiff' },
  { id: 'archive', color: '#c0563f', label: 'Archives', ext: 'zip rar 7z tar gz bz2 iso bpak pak cab pck vpk xz' },
  { id: 'program', color: '#3d84c6', label: 'Programs', ext: 'exe dll sys msi bin so ocx cpl drv' },
  { id: 'document', color: '#b05fa8', label: 'Documents', ext: 'pdf doc docx xls xlsx ppt pptx txt md rtf csv odt epub' },
  { id: 'code', color: '#4aa3a3', label: 'Code', ext: 'js ts jsx tsx cs cpp c h py java json xml html css scss rb go rs php sql yml yaml' },
  { id: 'data', color: '#7a8899', label: 'Data', ext: 'dat db sqlite asset bundle bin cache log idx pdb resS resource' },
];

const OTHER = { id: 'other', color: '#4a5462', label: 'Other' };
const FOLDER = '#2b3643';

// How much thicker a block gets while the cursor is over it.
const HOVER_DEPTH = 1.45;

const extLookup = new Map();
for (const type of TYPES) {
  for (const ext of type.ext.split(' ')) extLookup.set(ext, type);
}

function typeFor(node) {
  if (node.aggregate) return OTHER;
  if (node.dir) return null;
  return extLookup.get(node.ext) || OTHER;
}

/* Colour helpers ----------------------------------------------------------- */

const shadeCache = new Map();

function toRgb(hex) {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** amount > 0 lightens towards white, < 0 darkens towards black. */
function shade(hex, amount) {
  const key = `${hex}|${amount}`;
  const cached = shadeCache.get(key);
  if (cached) return cached;

  const [r, g, b] = toRgb(hex);
  const mix = (channel) =>
    Math.round(amount > 0 ? channel + (255 - channel) * amount : channel * (1 + amount));
  const result = `rgb(${mix(r)},${mix(g)},${mix(b)})`;
  shadeCache.set(key, result);
  return result;
}

/* Layout ------------------------------------------------------------------- */

function worstRatio(areas, sum, side) {
  let max = -Infinity;
  let min = Infinity;
  for (const area of areas) {
    if (area > max) max = area;
    if (area < min) min = area;
  }
  if (min <= 0) return Infinity;
  const side2 = side * side;
  const sum2 = sum * sum;
  return Math.max((side2 * max) / sum2, sum2 / (side2 * min));
}

/**
 * Places `items` (each {node, value}) inside the rectangle, appending
 * {node, x, y, w, h, depth} to `out`. Recurses into folders while there is
 * still enough room to be legible.
 */
function squarify(items, x, y, w, h, depth, out, maxDepth) {
  if (w <= 0.5 || h <= 0.5) return;

  const usable = items.filter((item) => item.value > 0);
  if (!usable.length) return;

  let remaining = usable.slice();
  let rx = x;
  let ry = y;
  let rw = w;
  let rh = h;

  while (remaining.length) {
    const remainingTotal = remaining.reduce((sum, item) => sum + item.value, 0);
    if (remainingTotal <= 0 || rw <= 0.5 || rh <= 0.5) return;

    const scale = (rw * rh) / remainingTotal;
    const side = Math.min(rw, rh);

    const rowAreas = [];
    let rowSum = 0;
    let best = Infinity;
    let take = 0;

    for (const item of remaining) {
      const area = item.value * scale;
      const candidateSum = rowSum + area;
      const candidate = worstRatio([...rowAreas, area], candidateSum, side);
      if (rowAreas.length === 0 || candidate <= best) {
        rowAreas.push(area);
        rowSum = candidateSum;
        best = candidate;
        take += 1;
      } else {
        break;
      }
    }

    const row = remaining.slice(0, take);
    const thickness = rowSum / side;
    const horizontal = rw >= rh;

    let offset = 0;
    for (let i = 0; i < row.length; i += 1) {
      const length = (rowAreas[i] / rowSum) * side;
      const rect = horizontal
        ? { x: rx, y: ry + offset, w: thickness, h: length }
        : { x: rx + offset, y: ry, w: length, h: thickness };
      offset += length;

      out.push({ node: row[i].node, ...rect, depth });

      // Nest one level in, leaving a margin so the parent stays readable.
      const child = row[i].node;
      if (child.dir && child.children && child.children.length && depth < maxDepth) {
        const pad = depth === 0 ? 2.5 : 2;
        const header = rect.w > 46 && rect.h > 24 ? 14 : 2.5;
        const inner = {
          x: rect.x + pad,
          y: rect.y + header,
          w: rect.w - pad * 2,
          h: rect.h - header - pad,
        };
        if (inner.w > 6 && inner.h > 6) {
          squarify(
            child.children.map((c) => ({ node: c, value: c.bytes })),
            inner.x,
            inner.y,
            inner.w,
            inner.h,
            depth + 1,
            out,
            maxDepth
          );
        }
      }
    }

    if (horizontal) {
      rx += thickness;
      rw -= thickness;
    } else {
      ry += thickness;
      rh -= thickness;
    }
    remaining = remaining.slice(take);
  }
}

/* Drawing ------------------------------------------------------------------ */

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size < 10 && unit > 0 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
}

function roundedPath(ctx, x, y, w, h, radius) {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  ctx.beginPath();
  if (r <= 0.5) {
    ctx.rect(x, y, w, h);
  } else {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
  }
  ctx.closePath();
}

/**
 * How thick a block is, given its footprint. Scales with the tile so small
 * ones do not end up as all side and no face.
 */
function depthFor(w, h) {
  return Math.max(1.2, Math.min(5, Math.min(w, h) * 0.09));
}

/**
 * A tile drawn as a solid block rather than a flat sheet.
 *
 * The footprint is filled with a much darker version of the colour, and the lit
 * top face is drawn inset from it by the block's depth. What is left showing
 * along the right and bottom edges reads as the sides of a raised object, lit
 * consistently from the top left. Shading alone made these look like sheets of
 * paper; the visible side walls are what give them mass.
 *
 * `lightX`/`lightY` shift the highlight, which is what sells the tilt on hover.
 */
function drawBlock(ctx, x, y, w, h, color, options = {}) {
  const { lightX = -0.4, lightY = -0.4, strength = 1, depthScale = 1 } = options;

  // Below a few pixels there is no room for a face and sides; a flat fill reads
  // better and costs a fraction as much.
  if (w < 5 || h < 5) {
    ctx.fillStyle = shade(color, -0.08);
    ctx.fillRect(x, y, w, h);
    return;
  }

  const depth = depthFor(w, h) * depthScale;
  const faceW = w - depth;
  const faceH = h - depth;

  if (faceW < 3 || faceH < 3) {
    ctx.fillStyle = shade(color, -0.08);
    ctx.fillRect(x, y, w, h);
    return;
  }

  const radius = Math.min(7, faceW / 5, faceH / 5);

  // The body of the block, seen along its right and bottom sides.
  roundedPath(ctx, x, y, w, h, radius + depth * 0.35);
  const side = ctx.createLinearGradient(x, y, x + w, y + h);
  side.addColorStop(0, shade(color, -0.46));
  side.addColorStop(1, shade(color, -0.72));
  ctx.fillStyle = side;
  ctx.fill();

  // The lit top face, inset so the body shows beneath it.
  roundedPath(ctx, x, y, faceW, faceH, radius);
  const face = ctx.createLinearGradient(
    x + faceW * (0.5 + lightX * 0.5),
    y + faceH * (0.5 + lightY * 0.5),
    x + faceW * (0.5 - lightX * 0.5),
    y + faceH * (0.5 - lightY * 0.5)
  );
  // Weighted so most of the face stays close to its true colour: lightening too
  // much of it washes the map out to pastel and the file types stop being
  // distinguishable at a glance.
  face.addColorStop(0, shade(color, 0.32 * strength));
  face.addColorStop(0.32, shade(color, 0.03 * strength));
  face.addColorStop(1, shade(color, -0.3 * strength));
  ctx.fillStyle = face;
  ctx.fill();

  if (faceW > 9 && faceH > 9) {
    // Bright rim along the lit edges of the face.
    ctx.save();
    ctx.clip();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = `rgba(255,255,255,${0.36 * strength})`;
    ctx.beginPath();
    ctx.moveTo(x + 0.8, y + faceH - 0.8);
    ctx.lineTo(x + 0.8, y + 0.8);
    ctx.lineTo(x + faceW - 0.8, y + 0.8);
    ctx.stroke();
    ctx.restore();

    // A crease where the face meets the sides, so the edge reads as a corner.
    ctx.lineWidth = 1;
    ctx.strokeStyle = `rgba(0,0,0,${0.42 * strength})`;
    roundedPath(ctx, x + 0.5, y + 0.5, faceW - 1, faceH - 1, radius);
    ctx.stroke();
  }
}

function drawFolder(ctx, x, y, w, h) {
  if (w < 3 || h < 3) return;
  const radius = Math.min(8, w / 6, h / 6);

  // Folders sit back as recessed panels so the coloured file tiles read as
  // sitting on top of them.
  roundedPath(ctx, x, y, w, h, radius);
  const gradient = ctx.createLinearGradient(x, y, x, y + h);
  gradient.addColorStop(0, shade(FOLDER, -0.34));
  gradient.addColorStop(1, shade(FOLDER, -0.1));
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(150,172,198,0.42)';
  roundedPath(ctx, x + 0.5, y + 0.5, w - 1, h - 1, radius);
  ctx.stroke();
}

class Treemap {
  constructor(canvas, { onHover, onSelect, onZoom }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.base = document.createElement('canvas');
    this.baseCtx = this.base.getContext('2d');
    this.rects = [];
    this.root = null;
    this.hovered = null;
    this.selected = null;
    this.mouse = null;
    this.width = 0;
    this.height = 0;
    this.onHover = onHover;
    this.onSelect = onSelect;
    this.onZoom = onZoom;

    canvas.addEventListener('mousemove', (event) => this.handleMove(event));
    canvas.addEventListener('mouseleave', () => {
      this.hovered = null;
      this.mouse = null;
      this.onHover(null);
      this.draw();
    });
    canvas.addEventListener('click', (event) => this.handleClick(event));
    canvas.addEventListener('dblclick', (event) => this.handleDoubleClick(event));
  }

  setRoot(node) {
    this.root = node;
    this.selected = null;
    this.hovered = null;
    this.layout();
  }

  layout() {
    const bounds = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    // A zero-width canvas means the view is hidden; skip until it is shown.
    if (bounds.width < 2 || bounds.height < 2) return;

    this.width = bounds.width;
    this.height = bounds.height;

    for (const canvas of [this.canvas, this.base]) {
      canvas.width = Math.round(bounds.width * dpr);
      canvas.height = Math.round(bounds.height * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.baseCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.rects = [];
    if (this.root && this.root.children && this.root.children.length) {
      squarify(
        this.root.children.map((child) => ({ node: child, value: child.bytes })),
        0,
        0,
        bounds.width,
        bounds.height,
        0,
        this.rects,
        6
      );
    }

    this.renderBase();
    this.draw();
  }

  /** Draws the whole map once into the offscreen buffer. */
  renderBase() {
    const ctx = this.baseCtx;
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = '#0f141a';
    ctx.fillRect(0, 0, this.width, this.height);

    if (!this.rects.length) {
      ctx.fillStyle = '#5d6674';
      ctx.font = '13px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Nothing to show here.', this.width / 2, this.height / 2);
      ctx.textAlign = 'left';
      return;
    }

    for (const item of this.rects) {
      if (item.node.dir) {
        drawFolder(ctx, item.x, item.y, item.w, item.h);
        continue;
      }

      // Drop shadow, but only where it will actually be visible — running the
      // shadow filter on every sliver would cost far more than it shows.
      const shadowed = item.w > 14 && item.h > 14;
      if (shadowed) {
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.45)';
        ctx.shadowBlur = 4;
        ctx.shadowOffsetX = 1;
        ctx.shadowOffsetY = 1.5;
      }
      drawBlock(ctx, item.x, item.y, item.w, item.h, typeFor(item.node).color);
      if (shadowed) ctx.restore();
    }

    this.drawLabels(ctx);
  }

  drawLabels(ctx) {
    ctx.textBaseline = 'middle';
    for (const item of this.rects) {
      const isFolder = item.node.dir;
      const minW = isFolder ? 48 : 44;
      const minH = isFolder ? 24 : 16;
      if (item.w < minW || item.h < minH) continue;

      // Text belongs on the lit top face, not spilling onto the block's sides.
      const depth = isFolder ? 0 : depthFor(item.w, item.h);
      const faceW = item.w - depth;
      const faceH = item.h - depth;

      ctx.save();
      roundedPath(ctx, item.x + 3, item.y, faceW - 6, faceH, 2);
      ctx.clip();

      if (isFolder) {
        ctx.font = '600 11px "Segoe UI", system-ui, sans-serif';
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillText(item.node.name, item.x + 5, item.y + 8.5);
        ctx.fillStyle = '#cfdae8';
        ctx.fillText(item.node.name, item.x + 4, item.y + 7.5);
      } else {
        ctx.font = '11px "Segoe UI", system-ui, sans-serif';
        const y = item.y + faceH / 2;
        // A pale shadow behind dark text keeps it legible on every tile colour.
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.fillText(item.node.name, item.x + 5.8, y + 0.8);
        ctx.fillStyle = 'rgba(12,16,22,0.92)';
        ctx.fillText(item.node.name, item.x + 5, y);

        if (faceH > 32 && faceW > 70) {
          ctx.fillStyle = 'rgba(12,16,22,0.62)';
          ctx.fillText(formatBytes(item.node.bytes), item.x + 5, y + 13);
        }
      }
      ctx.restore();
    }
  }

  draw() {
    const ctx = this.ctx;
    if (!this.width) return;

    ctx.clearRect(0, 0, this.width, this.height);
    ctx.drawImage(this.base, 0, 0, this.width, this.height);

    if (this.selected) {
      const found = this.rects.find((item) => item.node === this.selected);
      if (found) {
        // Traces the lit top face rather than the footprint, so the marker sits
        // on the block instead of floating in a flat rectangle around it.
        const depth = found.node.dir ? 0 : depthFor(found.w, found.h);
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(255,255,255,0.92)';
        roundedPath(ctx, found.x + 1, found.y + 1, found.w - depth - 2, found.h - depth - 2, 5);
        ctx.stroke();
      }
    }

    if (this.hovered && this.mouse) this.drawHovered();
  }

  /**
   * Redraws the hovered tile lifted off the surface and tilted towards the
   * cursor. Canvas 2D has no perspective, but a small shear plus a highlight
   * and shadow that swing the opposite way reads convincingly as a tilt.
   */
  drawHovered() {
    const item = this.rects.find((entry) => entry.node === this.hovered);
    if (!item || item.w < 8 || item.h < 8) return;

    const ctx = this.ctx;
    const cx = item.x + item.w / 2;
    const cy = item.y + item.h / 2;

    // Cursor position within the tile, -1 to 1 on each axis.
    const nx = Math.max(-1, Math.min(1, (this.mouse.x - cx) / (item.w / 2)));
    const ny = Math.max(-1, Math.min(1, (this.mouse.y - cy) / (item.h / 2)));

    const lift = 1.05;
    const shear = 0.0385;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.transform(lift, ny * shear, nx * shear, lift, 0, 0);
    ctx.translate(-cx, -cy);

    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 20;
    ctx.shadowOffsetX = -nx * 5.5;
    ctx.shadowOffsetY = -ny * 5.5 + 5;

    const type = typeFor(this.hovered);
    if (this.hovered.dir) {
      drawFolder(ctx, item.x, item.y, item.w, item.h);
    } else {
      // Thicker while raised, and the highlight swings opposite the cursor as
      // if the block had tipped under it.
      drawBlock(ctx, item.x, item.y, item.w, item.h, type.color, {
        lightX: -0.4 - nx * 0.45,
        lightY: -0.4 - ny * 0.45,
        strength: 1.15,
        depthScale: HOVER_DEPTH,
      });
    }

    // No outline here on purpose. A white rectangle traced round the footprint
    // sat outside the lit face and flattened the whole illusion — the raised,
    // thickened, tilted block is the hover cue on its own.
    ctx.shadowColor = 'transparent';

    if (item.w > 44 && item.h > 16) {
      const depth = this.hovered.dir ? 0 : depthFor(item.w, item.h) * HOVER_DEPTH;
      ctx.save();
      roundedPath(ctx, item.x + 3, item.y, item.w - depth - 6, item.h - depth, 2);
      ctx.clip();
      ctx.textBaseline = 'middle';
      ctx.font = this.hovered.dir
        ? '600 11px "Segoe UI", system-ui, sans-serif'
        : '11px "Segoe UI", system-ui, sans-serif';
      const y = this.hovered.dir ? item.y + 7.5 : item.y + (item.h - depth) / 2;
      ctx.fillStyle = this.hovered.dir ? '#e8eef6' : 'rgba(12,16,22,0.95)';
      ctx.fillText(this.hovered.name, item.x + 5, y);
      ctx.restore();
    }

    ctx.restore();
  }

  hitTest(point) {
    // Reverse order: the deepest rectangles are drawn last, so they win.
    for (let i = this.rects.length - 1; i >= 0; i -= 1) {
      const item = this.rects[i];
      if (point.x >= item.x && point.x <= item.x + item.w && point.y >= item.y && point.y <= item.y + item.h) {
        return item;
      }
    }
    return null;
  }

  pointFrom(event) {
    const bounds = this.canvas.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  handleMove(event) {
    this.mouse = this.pointFrom(event);
    const hit = this.hitTest(this.mouse);
    const node = hit ? hit.node : null;
    this.hovered = node;
    this.canvas.style.cursor = node && !node.aggregate ? 'pointer' : 'default';
    this.onHover(node, event);
    // Redrawn every move so the tilt tracks the cursor; this is only a blit of
    // the cached map plus one tile.
    this.draw();
  }

  handleClick(event) {
    const hit = this.hitTest(this.pointFrom(event));
    if (!hit || hit.node.aggregate) return;
    this.selected = hit.node;
    this.onSelect(hit.node);
    this.draw();
  }

  handleDoubleClick(event) {
    const hit = this.hitTest(this.pointFrom(event));
    if (hit && hit.node.dir) this.onZoom(hit.node);
  }
}

window.Treemap = { Treemap, TYPES, OTHER, formatBytes };
