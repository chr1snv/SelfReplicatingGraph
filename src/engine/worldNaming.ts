import { WorldOrganism, WorldState } from '../types/morphogenesis';

/**
 * Curated biological & hydro-planktonic short nicknames assigned to newly hatched
 * hybrid offspring and separated cellular colony clones. Prevents exponential
 * name concatenation (e.g. `A×B×C×D`) across successive generations.
 */
const NICKNAME_ROOTS: readonly string[] = [
  'Nixie',
  'Kora',
  'Zelo',
  'Vira',
  'Tethy',
  'Mirex',
  'Luma',
  'Cilia',
  'Sora',
  'Piko',
  'Nori',
  'Orbi',
  'Vexi',
  'Auri',
  'Kino',
  'Cyte',
  'Lyra',
  'Rhea',
  'Thal',
  'Nere',
  'Seta',
  'Vola',
  'Keli',
  'Flix',
  'Glia',
  'Myx',
  'Bryo',
  'Pori',
  'Astra',
  'Dune',
  'Ephy',
  'Gale',
  'Hydra',
  'Iona',
  'Juno',
  'Kaia',
  'Liri',
  'Maris',
  'Naiad',
  'Opal',
  'Plume',
  'Quill',
  'Riff',
  'Salp',
  'Tide',
  'Ula',
  'Vell',
  'Wren',
  'Xylo',
  'Yara',
  'Zyg',
  'Bryn',
];

const ROMAN_SUFFIXES: readonly string[] = ['', ' II', ' III', ' IV', ' V', ' VI', ' VII', ' VIII'];

/**
 * Strips any legacy cross suffixes or `(Split)` tags to obtain a short root token.
 */
export function normalizeBaseNickname(name: string): string {
  const firstToken = name.split(/[\s×(]/)[0]?.trim() || 'Cell';
  return firstToken.slice(0, 10);
}

/**
 * Picks a short, readable, unique biological nickname for a hybrid offspring without
 * concatenating ancestor names. Blends lineage deterministically + counter entropy
 * so names stay crisp in HUD overlays and tooltips across arbitrary generations.
 */
export function generateOffspringNickname(
  world: WorldState,
  parentA: WorldOrganism,
  parentB: WorldOrganism,
  generation: number,
): string {
  const seedHash =
    ((parentA.colonyId * 73 +
      parentB.colonyId * 137 +
      generation * 31 +
      world.totalBirths * 17 +
      world.nextOrgId * 13) >>>
      0) %
    NICKNAME_ROOTS.length;

  // Scan candidate roots to prefer one not currently living in the world
  for (let offset = 0; offset < NICKNAME_ROOTS.length; offset++) {
    const candidate = NICKNAME_ROOTS[(seedHash + offset) % NICKNAME_ROOTS.length];
    let used = false;
    for (let i = 0; i < world.organisms.length; i++) {
      if (world.organisms[i].name === candidate) {
        used = true;
        break;
      }
    }
    if (!used) return candidate;
  }

  // Fallback with compact Roman suffix if > 52 organisms simultaneously inhabit the tank
  const base = NICKNAME_ROOTS[seedHash];
  const tier = ((world.nextOrgId + generation) % (ROMAN_SUFFIXES.length - 1)) + 1;
  return `${base}${ROMAN_SUFFIXES[tier]}`;
}

/**
 * Generates a distinct short nickname when a severed fragment matures into an
 * independent autonomous colony.
 */
export function generateSplitNickname(world: WorldState, originName: string): string {
  const baseHash =
    ((originName.charCodeAt(0) || 65) * 29 + world.totalSplits * 43 + world.nextOrgId * 19) %
    NICKNAME_ROOTS.length;

  for (let offset = 0; offset < NICKNAME_ROOTS.length; offset++) {
    const candidate = NICKNAME_ROOTS[(baseHash + offset) % NICKNAME_ROOTS.length];
    let used = false;
    for (let i = 0; i < world.organisms.length; i++) {
      if (world.organisms[i].name === candidate) {
        used = true;
        break;
      }
    }
    if (!used) return candidate;
  }

  const root = normalizeBaseNickname(originName);
  const tag = 2 + (world.totalSplits % 8);
  return `${root}-${tag}`;
}
