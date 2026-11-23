export enum TissueType {
  EMPTY = 0,
  EPIDERMIS = 1,
  MESODERM = 2,
  VASCULAR = 3,
  NEURAL = 4,
  SENSOR = 5,
  MUSCLE = 6,
  FLAGELLA = 7,
}

export type MipLevel = 0 | 1 | 2 | 3;

export type GrowthMode = 'mipmap' | 'legacy';

export type BrushTool =
  | 'epidermis'
  | 'mesoderm'
  | 'vascular'
  | 'neural'
  | 'sensor'
  | 'muscle'
  | 'flagella'
  | 'eraser'
  | 'scalpel';

export type WorldTool = 'select' | 'poke' | 'food' | 'toxin' | 'spawn' | 'scalpel';

export interface TissueSpec {
  id: TissueType;
  name: string;
  shortName: string;
  role: string;
  color: string;
  glowColor: string;
  borderColor: string;
}

export const TISSUE_SPECS: Record<TissueType, TissueSpec> = {
  [TissueType.EMPTY]: {
    id: TissueType.EMPTY,
    name: 'Extracellular Void',
    shortName: 'Empty',
    role: 'Unoccupied nutrient medium',
    color: '#090C12',
    glowColor: 'rgba(0,0,0,0)',
    borderColor: '#1E293B',
  },
  [TissueType.EPIDERMIS]: {
    id: TissueType.EPIDERMIS,
    name: 'Epidermis',
    shortName: 'Epidermal',
    role: 'Outer protective membrane · Retains internal pressure & ATP',
    color: '#10B981',
    glowColor: 'rgba(16, 185, 129, 0.45)',
    borderColor: '#34D399',
  },
  [TissueType.MESODERM]: {
    id: TissueType.MESODERM,
    name: 'Mesoderm',
    shortName: 'Mesodermal',
    role: 'Structural elastic matrix · Anchors soft-body form',
    color: '#F59E0B',
    glowColor: 'rgba(245, 158, 11, 0.45)',
    borderColor: '#FBBF24',
  },
  [TissueType.VASCULAR]: {
    id: TissueType.VASCULAR,
    name: 'Vascular',
    shortName: 'Vascular',
    role: 'Harvests medium nutrients & distributes ATP',
    color: '#EF4444',
    glowColor: 'rgba(239, 68, 68, 0.5)',
    borderColor: '#F87171',
  },
  [TissueType.NEURAL]: {
    id: TissueType.NEURAL,
    name: 'Neural',
    shortName: 'Neural',
    role: 'Integrates sensor cues & drives coordinated motor waves',
    color: '#38BDF8',
    glowColor: 'rgba(56, 189, 248, 0.55)',
    borderColor: '#7DD3FC',
  },
  [TissueType.SENSOR]: {
    id: TissueType.SENSOR,
    name: 'Gradient Sensor',
    shortName: 'Sensor',
    role: 'Detects chemical scent gradients for chemotactic steering',
    color: '#A3E635',
    glowColor: 'rgba(163, 230, 53, 0.6)',
    borderColor: '#BEF264',
  },
  [TissueType.MUSCLE]: {
    id: TissueType.MUSCLE,
    name: 'Muscle',
    shortName: 'Muscle',
    role: 'Contractile springs modulate rest length to deform body shape',
    color: '#EC4899',
    glowColor: 'rgba(236, 72, 153, 0.55)',
    borderColor: '#F472B6',
  },
  [TissueType.FLAGELLA]: {
    id: TissueType.FLAGELLA,
    name: 'Flagella',
    shortName: 'Flagella',
    role: 'Oscillating cilia/whips generate directional fluid propulsion',
    color: '#A78BFA',
    glowColor: 'rgba(167, 139, 250, 0.6)',
    borderColor: '#C4B5FD',
  },
};

export const ACTIVE_TISSUE_TYPES: TissueType[] = [
  TissueType.EPIDERMIS,
  TissueType.MESODERM,
  TissueType.VASCULAR,
  TissueType.NEURAL,
  TissueType.SENSOR,
  TissueType.MUSCLE,
  TissueType.FLAGELLA,
];

export const BASE_DIM = 128;
export const MAX_MIP_LEVEL: MipLevel = 3;
export const MIP_LEVELS: MipLevel[] = [3, 2, 1, 0];

export function mipDim(level: MipLevel): number {
  return BASE_DIM >> level;
}

export function mipStride(level: MipLevel): number {
  return 1 << level;
}

export interface DirectiveNode {
  id: number;
  level: MipLevel;
  gx: number;
  gy: number;
  physX: number;
  physY: number;
  tissue: TissueType;
  lineageMask: number;
  isProgenitor: boolean;
  levelSetPhi: number;
  parentId: number;
  bfsDepth: number;
  lateralNeighbors: [number, number, number, number];
  subdivisionChildren: [number, number, number, number];
  bridgeTargetIds: number[];
}

export interface MipLayerCompiled {
  level: MipLevel;
  dim: number;
  stride: number;
  tissueGrid: Uint8Array;
  lineageGrid: Uint8Array;
  phiGrid: Float32Array;
  nodeIdGrid: Int32Array;
  activeCount: number;
  tissueCounts: Record<TissueType, number>;
}

export interface CompiledGenome {
  blueprint: Uint8Array;
  layers: Record<MipLevel, MipLayerCompiled>;
  nodes: DirectiveNode[];
  nodeById: Map<number, DirectiveNode>;
  seedNodeId: number;
  legacyNodes: DirectiveNode[];
  legacyNodeById: Map<number, DirectiveNode>;
  legacySeedNodeId: number;
  legacyGrid: Int32Array;
  compileTimeMs: number;
}

export interface SimLayerState {
  level: MipLevel;
  dim: number;
  stride: number;
  alive: Uint8Array;
  nodeId: Int32Array;
  tissue: Uint8Array;
  age: Uint16Array;
  energy: Float32Array;
  flash: Float32Array;
  signal: Float32Array;
  activeCount: number;
}

export interface SimParams {
  growthMode: GrowthMode;
  subdivisionDelay: number;
  lateralDelay: number;
  divisionCost: number;
  nutrientDensity: number;
  vascularBoost: number;
  stagedWaves: boolean;
  legacyNodeCap: number;
}

export interface TelemetryPoint {
  tick: number;
  iouPercent: number;
  l3Count: number;
  l2Count: number;
  l1Count: number;
  l0Count: number;
  epidermis: number;
  mesoderm: number;
  vascular: number;
  neural: number;
  sensor: number;
  muscle: number;
  flagella: number;
}

export interface SimState {
  tick: number;
  layers: Record<MipLevel, SimLayerState>;
  nutrients: Float32Array;
  compositeTissue: Uint8Array;
  compositeLevel: Int8Array;
  compositeNodeId: Int32Array;
  lastDivisions: number;
  iouPercent: number;
  totalVisibleCoverage: number;
  targetCoverage: number;
  activeWaveLevel: MipLevel;
  history: TelemetryPoint[];
}

export interface InspectedCell {
  physX: number;
  physY: number;
  level: MipLevel;
  gx: number;
  gy: number;
  nodeId: number;
  tissue: TissueType;
  age: number;
  energy: number;
  signal: number;
  nutrientHere: number;
  directive: DirectiveNode | null;
}

export interface PresetDefinition {
  id: string;
  name: string;
  subtitle: string;
  generate: (dim: number) => Uint8Array;
}

// ============================================================================
// Soft-Body Deformable Mesh & Multi-Organism World Simulation Types
// ============================================================================

export interface SoftVertex {
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number;
  fy: number;
  mass: number;
  gx: number; // lattice corner index [0..meshDim]
  gy: number;
  pinned?: boolean;
}

export interface SoftSpring {
  v0: number;
  v1: number;
  baseLength: number;
  currentRestLength: number;
  stiffness: number;
  damping: number;
  isDiagonal: boolean;
  isMuscle: boolean;
  musclePhase: number;
  sideBias: number; // -1 left side, +1 right side relative to organism centroid
  activation: number; // current contraction [-1..1]
}

export interface SoftCell {
  key: number; // gy * meshDim + gx
  gx: number;
  gy: number;
  meshLevel: MipLevel;
  vTL: number;
  vTR: number;
  vBR: number;
  vBL: number;
  tissue: TissueType;
  targetArea: number;
  currentArea: number;
  // Fine L0 composition ratios inside this mesh cell
  sensorWeight: number;
  muscleWeight: number;
  flagellaWeight: number;
  neuralWeight: number;
  epidermisWeight: number;
  mesodermWeight: number;
  vascularWeight: number;
  // Dynamic physics state
  activation: number;
  thrustDirX: number;
  thrustDirY: number;
  thrustDotForward: number; // > -0.15 main/steering flagella, < -0.15 opposing braking flagella
  gradientX: number;
  gradientY: number;
  crushStress: number;
}

export interface SoftBodyMesh {
  meshLevel: MipLevel; // L2 (32x32) once grown, L3 (16x16) during early embryo
  cellSize: number; // world px per lattice cell
  vertices: SoftVertex[];
  vertexIndexByCorner: Map<number, number>; // cornerKey -> index in vertices
  springs: SoftSpring[];
  springKeySet: Set<string>;
  springIndexByKey: Map<number, number>; // fast numeric key (a*65536+b) -> index in springs
  cells: SoftCell[];
  cellMap: Map<number, SoftCell>;
  boundaryEdges: Array<[number, number]>; // ordered directed perimeter edges [vA, vB] for global gas pressure
  comX: number;
  comY: number;
  boundRadius: number;
  headingAngle: number;
  angularVelocity: number;
  totalArea: number;
  targetTotalArea: number;
  lastSyncedTick: number;
  lastSyncedCount: number;
}

export type LocomotionMode = 'seek' | 'turn' | 'coast' | 'brake';

export interface NeuronState {
  id: number;
  label: string;
  state: number; // h_k^(t): auto-regressive output [-1..1]
  residual: number; // r_k^(t): residual skip component
  input: number; // x_k^(t): raw sensory/drive input
  arDecay: number; // alpha_k: temporal AR persistence [0.55..0.92]
  resGain: number; // rho_k: residual skip strength inside neuron [0.22..0.52]
  bias: number; // b_k: heritable tonic bias
}

export interface NeuralNetState {
  neurons: NeuronState[];
  weights: number[]; // 6x6 flat recurrent matrix W (prev h_j -> current pre-activation)
  cruiseOut: number; // [0..1] main propulsion throttle
  brakeOut: number; // [0..1] mutually exclusive opposing brake throttle
  steerOut: number; // [-1..1] continuous directional steering torque
  gaitOut: number; // [0.25..1.25] smooth muscle CPG amplitude factor
  mode: LocomotionMode;
  atFoodTicks: number;
}

export interface WorldOrganism {
  id: number;
  colonyId: number; // Shared organism ID across disconnected fragments for reconnection
  isFragment: boolean;
  fragmentBirthCellCount: number;
  fragmentTicks: number;
  name: string;
  presetId: string;
  generation: number;
  parentIds: [number, number] | null;
  genome: CompiledGenome;
  simState: SimState;
  params: SimParams;
  mesh: SoftBodyMesh;
  energyReserve: number; // 0..100 metabolic world energy
  lastMetabolicDrain: number; // ATP drained per tick by muscles & flagella
  steerBias: number; // -1..1 from Gradient Sensors -> AR-ResNet Neural Controller
  sensorMagnitude: number; // strength of detected chemical gradient
  neuralNet: NeuralNetState; // 6-neuron Auto-Regressive Residual Neural Network
  musclePhaseTime: number;
  speed: number;
  ageTicks: number;
  matingCooldown: number;
  consumedFood: number;
  rupturedCells: number;
  damageFlash: number;
}

export interface FoodPellet {
  id: number;
  x: number;
  y: number;
  radius: number;
  amount: number;
}

export interface WorldParams {
  fluidDrag: number;
  internalPressure: number; // BoxEye ideal gas pressure multiplier
  muscleStrength: number; // contraction amplitude 0..0.55
  muscleFrequency: number; // Hz-like oscillation speed
  flagellaThrust: number; // thrust force multiplier
  gradientSensitivity: number; // sensor gain
  scentDiffusion: number; // chemical diffusion rate
  growthRate: number; // morphogenesis ticks per N world frames
  metabolismRate: number; // energy burn multiplier for muscles & flagella
  autoMating: boolean;
  maxOrganisms: number;
}

export interface WorldState {
  width: number;
  height: number;
  chemCols: number;
  chemRows: number;
  foodField: Float32Array; // nutrient/food scent gradient
  scentField: Float32Array; // organism pheromone trail
  toxinField: Float32Array; // repellent gradient
  pellets: FoodPellet[];
  organisms: WorldOrganism[];
  nextOrgId: number;
  nextPelletId: number;
  worldTick: number;
  totalBirths: number;
  deathsStarved: number;
  deathsExited: number;
  deathsRuptured: number;
  totalReconnections: number;
  totalSplits: number;
}

