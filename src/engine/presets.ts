import { PresetDefinition, TissueType } from '../types/morphogenesis';

function setPixel(grid: Uint8Array, dim: number, x: number, y: number, tissue: TissueType): void {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix >= 0 && ix < dim && iy >= 0 && iy < dim) {
    grid[iy * dim + ix] = tissue;
  }
}

function drawDisk(
  grid: Uint8Array,
  dim: number,
  cx: number,
  cy: number,
  r: number,
  tissue: TissueType,
): void {
  const r2 = r * r;
  const minX = Math.max(0, Math.floor(cx - r));
  const maxX = Math.min(dim - 1, Math.ceil(cx + r));
  const minY = Math.max(0, Math.floor(cy - r));
  const maxY = Math.min(dim - 1, Math.ceil(cy + r));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) {
        grid[y * dim + x] = tissue;
      }
    }
  }
}

function drawCapsule(
  grid: Uint8Array,
  dim: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
  tissue: TissueType,
): void {
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 1.5));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    drawDisk(grid, dim, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r, tissue);
  }
}

function applyEpidermalShell(grid: Uint8Array, dim: number, thickness = 2): void {
  const copy = new Uint8Array(grid);
  for (let y = 0; y < dim; y++) {
    for (let x = 0; x < dim; x++) {
      const idx = y * dim + x;
      if (copy[idx] === TissueType.EMPTY) continue;
      let nearEmpty = false;
      for (let dy = -thickness; dy <= thickness && !nearEmpty; dy++) {
        for (let dx = -thickness; dx <= thickness; dx++) {
          if (dx * dx + dy * dy > thickness * thickness + 0.5) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= dim || ny < 0 || ny >= dim || copy[ny * dim + nx] === TissueType.EMPTY) {
            nearEmpty = true;
            break;
          }
        }
      }
      if (nearEmpty) {
        grid[idx] = TissueType.EPIDERMIS;
      }
    }
  }
}

export const ORGANISM_PRESETS: PresetDefinition[] = [
  {
    id: 'planarian',
    name: 'Planarian Swimmer',
    subtitle: 'Auricle gradient sensors, lateral muscle bands, caudal flagella & dual nerve cords',
    generate: (dim: number) => {
      const g = new Uint8Array(dim * dim);
      const cx = dim / 2;

      for (let y = 16; y <= 108; y++) {
        const t = (y - 16) / 92;
        let halfW = 22 * Math.sin(Math.PI * Math.pow(t, 0.72));
        if (t < 0.25) {
          halfW += 7 * Math.exp(-Math.pow((t - 0.14) / 0.06, 2));
        }
        halfW = Math.max(2, halfW);
        for (let x = Math.floor(cx - halfW); x <= Math.ceil(cx + halfW); x++) {
          setPixel(g, dim, x, y, TissueType.MESODERM);
        }
      }

      applyEpidermalShell(g, dim, 2);

      // Lateral contractile Muscle bands along left and right body wall
      drawCapsule(g, dim, cx - 14, 34, cx - 12, 92, 2.4, TissueType.MUSCLE);
      drawCapsule(g, dim, cx + 14, 34, cx + 12, 92, 2.4, TissueType.MUSCLE);

      // Branched gastrovascular tract (Vascular)
      drawCapsule(g, dim, cx, 32, cx, 60, 2.0, TissueType.VASCULAR);
      drawCapsule(g, dim, cx, 60, cx - 7, 92, 1.6, TissueType.VASCULAR);
      drawCapsule(g, dim, cx, 60, cx + 7, 92, 1.6, TissueType.VASCULAR);

      // Bilobed cephalic ganglion + ventral nerve cords (Neural)
      drawDisk(g, dim, cx - 5, 28, 3.2, TissueType.NEURAL);
      drawDisk(g, dim, cx + 5, 28, 3.2, TissueType.NEURAL);
      drawCapsule(g, dim, cx - 5, 28, cx + 5, 28, 1.5, TissueType.NEURAL);
      drawCapsule(g, dim, cx - 6, 30, cx - 9, 92, 1.1, TissueType.NEURAL);
      drawCapsule(g, dim, cx + 6, 30, cx + 9, 92, 1.1, TissueType.NEURAL);

      // Anterior chemosensory auricle lobes (Gradient Sensors)
      drawDisk(g, dim, cx - 16, 28, 3.2, TissueType.SENSOR);
      drawDisk(g, dim, cx + 16, 28, 3.2, TissueType.SENSOR);
      drawDisk(g, dim, cx, 19, 2.6, TissueType.SENSOR);

      // Anterior opposing pectoral braking cilia (Flagella on front shoulders)
      drawDisk(g, dim, cx - 19, 34, 2.4, TissueType.FLAGELLA);
      drawDisk(g, dim, cx + 19, 34, 2.4, TissueType.FLAGELLA);

      // Caudal propulsion tuft (Flagella)
      drawCapsule(g, dim, cx - 4, 105, cx - 6, 117, 2.2, TissueType.FLAGELLA);
      drawCapsule(g, dim, cx, 106, cx, 119, 2.5, TissueType.FLAGELLA);
      drawCapsule(g, dim, cx + 4, 105, cx + 6, 117, 2.2, TissueType.FLAGELLA);

      return g;
    },
  },
  {
    id: 'trilobite',
    name: 'Segmented Arthropod',
    subtitle: 'Anterior antennae sensors, metameric flexor muscles & swimmeret flagella',
    generate: (dim: number) => {
      const g = new Uint8Array(dim * dim);
      const cx = dim / 2;

      for (let y = 18; y <= 40; y++) {
        const t = (y - 18) / 22;
        const halfW = 34 * Math.sqrt(Math.sin((t * Math.PI) / 2));
        for (let x = Math.floor(cx - halfW); x <= Math.ceil(cx + halfW); x++) {
          setPixel(g, dim, x, y, TissueType.MESODERM);
        }
      }
      drawCapsule(g, dim, cx - 32, 36, cx - 38, 54, 2.2, TissueType.MESODERM);
      drawCapsule(g, dim, cx + 32, 36, cx + 38, 54, 2.2, TissueType.MESODERM);

      for (let seg = 0; seg < 6; seg++) {
        const sy = 44 + seg * 10;
        const halfW = 32 - seg * 2.4;
        drawCapsule(g, dim, cx - halfW, sy, cx + halfW, sy, 4.0, TissueType.MESODERM);
      }
      drawDisk(g, dim, cx, 103, 11, TissueType.MESODERM);

      applyEpidermalShell(g, dim, 2);

      // Paired segmental flexor muscles
      for (let seg = 0; seg < 5; seg++) {
        const sy = 44 + seg * 10;
        drawCapsule(g, dim, cx - 22, sy, cx - 9, sy, 2.0, TissueType.MUSCLE);
        drawCapsule(g, dim, cx + 9, sy, cx + 22, sy, 2.0, TissueType.MUSCLE);
      }

      // Axial dorsal vessel (Vascular) + segmental nerve cord (Neural)
      drawCapsule(g, dim, cx, 28, cx, 100, 2.2, TissueType.VASCULAR);
      for (let seg = 0; seg < 6; seg++) {
        drawDisk(g, dim, cx, 44 + seg * 10, 2.0, TissueType.NEURAL);
      }

      // Compound sensory eyes & anterior chemoreceptor horns
      drawDisk(g, dim, cx - 15, 28, 3.6, TissueType.SENSOR);
      drawDisk(g, dim, cx + 15, 28, 3.6, TissueType.SENSOR);
      drawCapsule(g, dim, cx - 10, 20, cx - 18, 13, 2.0, TissueType.SENSOR);
      drawCapsule(g, dim, cx + 10, 20, cx + 18, 13, 2.0, TissueType.SENSOR);

      // Anterior opposing swimmeret brakes
      drawDisk(g, dim, cx - 35, 36, 2.3, TissueType.FLAGELLA);
      drawDisk(g, dim, cx + 35, 36, 2.3, TissueType.FLAGELLA);

      // Posterior swimmeret flagella paddles
      drawCapsule(g, dim, cx - 7, 109, cx - 11, 119, 2.2, TissueType.FLAGELLA);
      drawCapsule(g, dim, cx + 7, 109, cx + 11, 119, 2.2, TissueType.FLAGELLA);
      drawCapsule(g, dim, cx, 111, cx, 121, 2.2, TissueType.FLAGELLA);

      return g;
    },
  },
  {
    id: 'hydra',
    name: 'Pulsing Medusa',
    subtitle: 'Radial bell muscles, tentacle gradient sensors & velum propulsion flagella',
    generate: (dim: number) => {
      const g = new Uint8Array(dim * dim);
      const cx = dim / 2;
      const cy = dim / 2 - 4;

      drawDisk(g, dim, cx, cy, 24, TissueType.MESODERM);

      const arms = 5;
      for (let a = 0; a < arms; a++) {
        const baseAngle = (a * 2 * Math.PI) / arms - Math.PI / 2;
        let prevX = cx + Math.cos(baseAngle) * 18;
        let prevY = cy + Math.sin(baseAngle) * 18;
        for (let s = 1; s <= 16; s++) {
          const t = s / 16;
          const r = 18 + t * 34;
          const curve = Math.sin(t * Math.PI * 1.2) * 0.22;
          const ang = baseAngle + curve;
          const nx = cx + Math.cos(ang) * r;
          const ny = cy + Math.sin(ang) * r;
          const rad = 5.2 * (1 - 0.5 * t);
          drawCapsule(g, dim, prevX, prevY, nx, ny, rad, TissueType.MESODERM);
          prevX = nx;
          prevY = ny;
        }
      }

      applyEpidermalShell(g, dim, 2);

      // Circular bell contractile muscle ring (Muscle)
      for (let deg = 0; deg < 360; deg += 5) {
        const rad = (deg * Math.PI) / 180;
        drawDisk(g, dim, cx + Math.cos(rad) * 18, cy + Math.sin(rad) * 18, 2.0, TissueType.MUSCLE);
      }

      // Gastrovascular central cavity + canals (Vascular)
      drawDisk(g, dim, cx, cy, 7.5, TissueType.VASCULAR);
      for (let a = 0; a < arms; a++) {
        const baseAngle = (a * 2 * Math.PI) / arms - Math.PI / 2;
        drawCapsule(
          g,
          dim,
          cx,
          cy,
          cx + Math.cos(baseAngle) * 32,
          cy + Math.sin(baseAngle) * 32,
          1.3,
          TissueType.VASCULAR,
        );
      }

      // Nerve ring (Neural)
      for (let deg = 0; deg < 360; deg += 6) {
        const rad = (deg * Math.PI) / 180;
        drawDisk(g, dim, cx + Math.cos(rad) * 12, cy + Math.sin(rad) * 12, 1.3, TissueType.NEURAL);
      }

      // Tentacle-tip rhopalia sensors + flagella tufts
      for (let a = 0; a < arms; a++) {
        const baseAngle = (a * 2 * Math.PI) / arms - Math.PI / 2;
        const ang = baseAngle + Math.sin(0.95 * Math.PI * 1.2) * 0.22;
        const tx = cx + Math.cos(ang) * 50;
        const ty = cy + Math.sin(ang) * 50;
        if (a === 0 || a === 1 || a === 4) {
          drawDisk(g, dim, tx, ty, 3.0, TissueType.SENSOR);
        } else {
          drawDisk(g, dim, tx, ty, 3.0, TissueType.FLAGELLA);
        }
      }

      return g;
    },
  },
  {
    id: 'somite_embryo',
    name: 'Chordate Larva',
    subtitle: 'Paired myotome muscles, dorsal nerve tube, rostral sensor & tail flagellum',
    generate: (dim: number) => {
      const g = new Uint8Array(dim * dim);
      const cx = dim / 2;

      // Streamlined tadpole-like chordate larva
      for (let y = 18; y <= 104; y++) {
        const t = (y - 18) / 86;
        const halfW = t < 0.42 ? 26 * Math.sin((t / 0.42) * (Math.PI / 2)) + 2 : 28 * Math.pow(1 - (t - 0.42) / 0.58, 0.7) + 3;
        for (let x = Math.floor(cx - halfW); x <= Math.ceil(cx + halfW); x++) {
          setPixel(g, dim, x, y, TissueType.MESODERM);
        }
      }

      applyEpidermalShell(g, dim, 2);

      // Paired somite myotome muscles along flanks
      for (let s = 0; s < 5; s++) {
        const sy = 50 + s * 10;
        const offset = Math.max(5, 14 - s * 2);
        drawDisk(g, dim, cx - offset, sy, 3.4, TissueType.MUSCLE);
        drawDisk(g, dim, cx + offset, sy, 3.4, TissueType.MUSCLE);
      }

      // Notochord & gut (Vascular)
      drawCapsule(g, dim, cx, 36, cx, 88, 2.5, TissueType.VASCULAR);
      drawDisk(g, dim, cx, 46, 5.0, TissueType.VASCULAR);

      // Neural vesicle + spinal cord (Neural)
      drawDisk(g, dim, cx, 31, 4.8, TissueType.NEURAL);
      drawCapsule(g, dim, cx, 33, cx, 94, 1.6, TissueType.NEURAL);

      // Rostral olfactory / gradient sensors
      drawDisk(g, dim, cx - 8, 22, 3.0, TissueType.SENSOR);
      drawDisk(g, dim, cx + 8, 22, 3.0, TissueType.SENSOR);

      // Pectoral opposing brake flagella
      drawDisk(g, dim, cx - 24, 38, 2.5, TissueType.FLAGELLA);
      drawDisk(g, dim, cx + 24, 38, 2.5, TissueType.FLAGELLA);

      // Whip-like tail flagella fin
      drawCapsule(g, dim, cx, 100, cx, 119, 3.0, TissueType.FLAGELLA);

      return g;
    },
  },
  {
    id: 'vascular_leaf',
    name: 'Motile Phyto-Organism',
    subtitle: 'Vascular lamina, phototropic leaf-tip sensors, turgor muscles & rootlet flagella',
    generate: (dim: number) => {
      const g = new Uint8Array(dim * dim);
      const cx = dim / 2;

      drawCapsule(g, dim, cx, 98, cx, 114, 3.2, TissueType.MESODERM);
      for (let y = 16; y <= 100; y++) {
        const t = (y - 16) / 84;
        const halfW = 38 * Math.sin(Math.pow(t, 0.85) * Math.PI) * (0.78 + 0.22 * t);
        if (halfW < 1) continue;
        for (let x = Math.floor(cx - halfW); x <= Math.ceil(cx + halfW); x++) {
          setPixel(g, dim, x, y, TissueType.MESODERM);
        }
      }

      applyEpidermalShell(g, dim, 2);

      // Midrib + dichotomous vascular network
      drawCapsule(g, dim, cx, 24, cx, 110, 2.0, TissueType.VASCULAR);
      const branches = [
        [88, 28, 66],
        [72, 32, 50],
        [56, 28, 36],
        [42, 20, 25],
      ];
      for (const [sy, span, ey] of branches) {
        drawCapsule(g, dim, cx, sy, cx - span, ey, 1.3, TissueType.VASCULAR);
        drawCapsule(g, dim, cx, sy, cx + span, ey, 1.3, TissueType.VASCULAR);
      }

      // Contracting turgor/pulvinus muscles along margins
      drawCapsule(g, dim, cx - 26, 56, cx - 22, 82, 2.2, TissueType.MUSCLE);
      drawCapsule(g, dim, cx + 26, 56, cx + 22, 82, 2.2, TissueType.MUSCLE);

      // Signaling nodes (Neural)
      drawDisk(g, dim, cx, 56, 3.0, TissueType.NEURAL);
      drawDisk(g, dim, cx - 14, 62, 2.2, TissueType.NEURAL);
      drawDisk(g, dim, cx + 14, 62, 2.2, TissueType.NEURAL);

      // Apical gradient sensors
      drawDisk(g, dim, cx, 20, 3.2, TissueType.SENSOR);
      drawDisk(g, dim, cx - 14, 32, 2.4, TissueType.SENSOR);
      drawDisk(g, dim, cx + 14, 32, 2.4, TissueType.SENSOR);

      // Apical opposing braking flagella
      drawDisk(g, dim, cx - 22, 34, 2.4, TissueType.FLAGELLA);
      drawDisk(g, dim, cx + 22, 34, 2.4, TissueType.FLAGELLA);

      // Basal rootlet flagella
      drawCapsule(g, dim, cx - 4, 112, cx - 8, 121, 2.0, TissueType.FLAGELLA);
      drawCapsule(g, dim, cx + 4, 112, cx + 8, 121, 2.0, TissueType.FLAGELLA);

      return g;
    },
  },
];
