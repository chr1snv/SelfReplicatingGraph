import { BiomeId } from '../types/morphogenesis';

export interface BiomeDefinition {
  id: BiomeId;
  order: number;
  name: string;
  shortName: string;
  subtitle: string;
  ambientSunlight: number; // 0..1
  fluidDragMod: number; // multiplier on worldParams.fluidDrag
  metabolismMod: number; // multiplier on worldParams.metabolismRate
  currentX: number; // subtle horizontal water current
  currentY: number; // subtle vertical water current
  photosynthTargetCount: number;
  detritusTargetCount: number;
  unlockMissionId: string | null; // null = unlocked at start
  unlockHint: string;
  // Color palette for WebGL2 backdrop shader [r, g, b] 0..1
  bgInnerRgb: [number, number, number];
  bgOuterRgb: [number, number, number];
  sunTintRgb: [number, number, number];
  shaderStyle: number; // 0: pond, 1: tidepool, 2: leaf_droplet, 3: frozen_ice, 4: cave
}

export const BIOMES: BiomeDefinition[] = [
  {
    id: 'pond',
    order: 0,
    name: 'Sunlit Garden Pond',
    shortName: 'Pond',
    subtitle: 'Calm freshwater basin warmed by dappled midday sunbeams feeding drifting algae blooms.',
    ambientSunlight: 0.78,
    fluidDragMod: 1.0,
    metabolismMod: 0.95,
    currentX: 0.0,
    currentY: 0.0,
    photosynthTargetCount: 9,
    detritusTargetCount: 5,
    unlockMissionId: null,
    unlockHint: 'Starter Biome · Complete Pond missions to unlock Coastal Tidepool',
    bgInnerRgb: [0.039, 0.068, 0.105],
    bgOuterRgb: [0.018, 0.032, 0.052],
    sunTintRgb: [0.95, 0.92, 0.62],
    shaderStyle: 0,
  },
  {
    id: 'tidepool',
    order: 1,
    name: 'Coastal Tidepool',
    shortName: 'Tidepool',
    subtitle: 'Brisk tidal eddies & brilliant coastal sunlight surge energy into muscular swimmers.',
    ambientSunlight: 0.95,
    fluidDragMod: 0.9,
    metabolismMod: 1.05,
    currentX: 0.014,
    currentY: 0.004,
    photosynthTargetCount: 11,
    detritusTargetCount: 4,
    unlockMissionId: 'mission_pond_clear',
    unlockHint: 'Unlock: Complete "Pond Pioneer" mission (sustain 8+ organisms & 1 G2 hybrid)',
    bgInnerRgb: [0.035, 0.088, 0.128],
    bgOuterRgb: [0.016, 0.042, 0.072],
    sunTintRgb: [0.82, 0.97, 0.92],
    shaderStyle: 1,
  },
  {
    id: 'leaf_droplet',
    order: 2,
    name: 'Forest Leaf Droplet',
    shortName: 'Leaf Drop',
    subtitle: 'A luminous bead of morning dew resting on an emerald leaf—focused canopy sunlight drives hyper-photosynthesis.',
    ambientSunlight: 1.15,
    fluidDragMod: 1.15,
    metabolismMod: 0.85,
    currentX: 0.0,
    currentY: 0.0,
    photosynthTargetCount: 13,
    detritusTargetCount: 2,
    unlockMissionId: 'mission_tidepool_clear',
    unlockHint: 'Unlock: Complete "Tidepool Surge" mission (consume 6.0 food & breed/split in Tidepool)',
    bgInnerRgb: [0.045, 0.105, 0.075],
    bgOuterRgb: [0.016, 0.045, 0.032],
    sunTintRgb: [0.78, 1.0, 0.56],
    shaderStyle: 2,
  },
  {
    id: 'frozen_ice',
    order: 3,
    name: 'Under Frozen Ice',
    shortName: 'Frozen Ice',
    subtitle: 'Frigid water sealed beneath crystalline ice sheets; dim filtered blue rays & dense cold fluid.',
    ambientSunlight: 0.36,
    fluidDragMod: 1.32,
    metabolismMod: 1.22,
    currentX: -0.006,
    currentY: 0.003,
    photosynthTargetCount: 6,
    detritusTargetCount: 8,
    unlockMissionId: 'mission_leaf_clear',
    unlockHint: 'Unlock: Complete "Canopy Dew Bloom" mission (10+ living organisms in Leaf Droplet)',
    bgInnerRgb: [0.042, 0.082, 0.145],
    bgOuterRgb: [0.022, 0.042, 0.085],
    sunTintRgb: [0.58, 0.88, 1.0],
    shaderStyle: 3,
  },
  {
    id: 'cave',
    order: 4,
    name: 'Bioluminescent Cave',
    shortName: 'Cave',
    subtitle: 'Subterranean darkness with zero sunlight, mineral detritus vents, and stinging chemical pockets.',
    ambientSunlight: 0.05,
    fluidDragMod: 0.96,
    metabolismMod: 0.9,
    currentX: 0.0,
    currentY: -0.004,
    photosynthTargetCount: 2,
    detritusTargetCount: 13,
    unlockMissionId: 'mission_ice_clear',
    unlockHint: 'Unlock: Complete "Cryo Lineage" mission (reach Generation 3+ Under Frozen Ice)',
    bgInnerRgb: [0.044, 0.034, 0.082],
    bgOuterRgb: [0.018, 0.014, 0.038],
    sunTintRgb: [0.68, 0.52, 1.0],
    shaderStyle: 4,
  },
];

export function getBiomeDef(id: BiomeId): BiomeDefinition {
  return BIOMES.find((b) => b.id === id) ?? BIOMES[0];
}
