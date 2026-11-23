import {
  CompiledGenome,
  LocomotionMode,
  NeuralBlueprintConfig,
  NeuralNetState,
  NeuronState,
  TissueType,
} from '../types/morphogenesis';

export const NEURON_COUNT = 6;

// Neuron indices:
// 0: Turn   - chemotactic lateral steering drive
// 1: Seek   - forward nutrient approach & exploration drive
// 2: Brake  - hysteresis-gated plume arrival / overshoot brake
// 3: Commit - turn direction memory (anti-180° flip hesitation)
// 4: Avoid  - toxin / repellent evasion surge
// 5: Gait   - muscle CPG undulation envelope
export const NEURON_LABELS = ['Turn', 'Seek', 'Brake', 'Commit', 'Avoid', 'Gait'];

export const NEURON_DESCRIPTIONS = [
  'Lateral chemotactic steering torque from gradient sensors',
  'Forward cruising drive toward food scent or mates (latches against Brake)',
  'Hysteresis-gated overshoot brake engaging only inside food peaks',
  'Directional polarity memory preventing 180° turning hesitation',
  'Toxin, spike-danger, and stronger-rival avoidance surge',
  'Central pattern generator (CPG) amplitude envelope for muscle springs',
];

// Default 6x6 recurrent synaptic matrix W[row * 6 + col] (pre-synaptic col j -> post-synaptic row k)
// Key motif: Seek (1) and Brake (2) form a mutually inhibitory bistable latch so forward
// and reverse flagella never rapidly alternate against each other.
export const BASE_WEIGHTS: number[] = [
  //   Turn   Seek   Brake  Commit  Avoid   Gait
  /*0*/ 0.18, 0.06, -0.15,  0.42,  0.22,  0.04, // Turn: reinforced by Commit & Avoid
  /*1*/ 0.05, 0.48, -0.95,  0.12,  0.28,  0.10, // Seek: self-exciting AR latch, strongly inhibited by Brake
  /*2*/-0.08,-0.78,  0.42, -0.10, -0.35, -0.05, // Brake: suppressed while Seek or Avoid is active
  /*3*/ 0.55, 0.08, -0.12,  0.52,  0.15,  0.00, // Commit: remembers Turn polarity across blind spots
  /*4*/ 0.00, 0.10, -0.20,  0.10,  0.38,  0.05, // Avoid: evasive persistence
  /*5*/ 0.20, 0.45, -0.35,  0.12,  0.32,  0.30, // Gait: couples muscle CPG to active Seek/Turn/Avoid
];

const DEFAULT_AR_DECAY = [0.68, 0.80, 0.82, 0.88, 0.70, 0.78];
const DEFAULT_RES_GAIN = [0.42, 0.32, 0.24, 0.28, 0.46, 0.34];
const DEFAULT_BIAS = [0.0, 0.22, -0.32, 0.0, -0.08, 0.14];
const INIT_STATES = [0.0, 0.45, 0.0, 0.0, 0.0, 0.45];

export interface NeuralObservation {
  gradCross: number; // normalized perpendicular scent gradient (-1..1)
  gradDot: number; // normalized forward scent alignment (-1..1)
  avgGradMag: number; // average sensor gradient magnitude
  localFood: number; // attractant field at COM
  localToxin: number; // repellent field at COM
  forwardSpeed: number; // velocity projected onto organism heading
  speed: number; // total COM speed
  energyFactor: number; // energyReserve / 100
  neuralDensity: number; // average NEURAL tissue density across body
  neuralEfficiency?: number; // topological sensor->neural->effector connectivity factor
  gradientSensitivity: number;
  hostileProx?: number; // [0..1] proximity/engagement with non-colony rival or combat target
  spikeDensity?: number; // fraction of living cells equipped with Chitin Spikes
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function createDefaultNeuralConfig(genome?: CompiledGenome): NeuralBlueprintConfig {
  if (genome?.neuralConfig) {
    return {
      arDecay: [...genome.neuralConfig.arDecay],
      resGain: [...genome.neuralConfig.resGain],
      bias: [...genome.neuralConfig.bias],
      weights: [...genome.neuralConfig.weights],
    };
  }
  let neuralBias = 0;
  let flagellaBias = 0;
  if (genome) {
    const l0 = genome.layers[0];
    const active = Math.max(1, l0.activeCount);
    neuralBias = clamp(l0.tissueCounts[TissueType.NEURAL] / active, 0, 0.3);
    flagellaBias = clamp(l0.tissueCounts[TissueType.FLAGELLA] / active, 0, 0.3);
  }
  const bias = [...DEFAULT_BIAS];
  bias[1] += flagellaBias * 0.4;
  bias[5] += neuralBias * 0.25;
  return {
    arDecay: [...DEFAULT_AR_DECAY],
    resGain: [...DEFAULT_RES_GAIN],
    bias,
    weights: [...BASE_WEIGHTS],
  };
}

export function createNeuralNetState(
  genome?: CompiledGenome,
  configOverride?: NeuralBlueprintConfig,
): NeuralNetState {
  const cfg = configOverride ?? createDefaultNeuralConfig(genome);

  const neurons: NeuronState[] = new Array(NEURON_COUNT);
  for (let id = 0; id < NEURON_COUNT; id++) {
    const init = INIT_STATES[id];
    neurons[id] = {
      id,
      label: NEURON_LABELS[id],
      state: init,
      residual: init,
      input: 0,
      arDecay: clamp(cfg.arDecay[id] ?? DEFAULT_AR_DECAY[id], 0.3, 0.96),
      resGain: clamp(cfg.resGain[id] ?? DEFAULT_RES_GAIN[id], 0.05, 0.8),
      bias: clamp(cfg.bias[id] ?? DEFAULT_BIAS[id], -0.8, 0.8),
    };
  }

  return {
    neurons,
    weights: cfg.weights.length === 36 ? [...cfg.weights] : [...BASE_WEIGHTS],
    cruiseOut: 0.65,
    brakeOut: 0.0,
    steerOut: 0.0,
    gaitOut: 0.75,
    aggressionOut: 0.0,
    isAggressive: false,
    mode: 'seek',
    atFoodTicks: 0,
  };
}

export function extractNeuralConfigFromState(net: NeuralNetState): NeuralBlueprintConfig {
  return {
    arDecay: net.neurons.map((n) => n.arDecay),
    resGain: net.neurons.map((n) => n.resGain),
    bias: net.neurons.map((n) => n.bias),
    weights: [...net.weights],
  };
}

export function crossoverNeuralConfigs(
  cfgA?: NeuralBlueprintConfig,
  cfgB?: NeuralBlueprintConfig,
): NeuralBlueprintConfig | undefined {
  if (!cfgA && !cfgB) return undefined;
  const a = cfgA ?? createDefaultNeuralConfig();
  const b = cfgB ?? createDefaultNeuralConfig();
  const arDecay = new Array<number>(NEURON_COUNT);
  const resGain = new Array<number>(NEURON_COUNT);
  const bias = new Array<number>(NEURON_COUNT);
  const weights = new Array<number>(36);

  for (let i = 0; i < NEURON_COUNT; i++) {
    const pickA = Math.random() < 0.5;
    arDecay[i] = clamp((pickA ? a.arDecay[i] * 0.7 + b.arDecay[i] * 0.3 : b.arDecay[i] * 0.7 + a.arDecay[i] * 0.3) + (Math.random() - 0.5) * 0.03, 0.45, 0.94);
    resGain[i] = clamp((pickA ? a.resGain[i] * 0.7 + b.resGain[i] * 0.3 : b.resGain[i] * 0.7 + a.resGain[i] * 0.3) + (Math.random() - 0.5) * 0.03, 0.12, 0.7);
    bias[i] = clamp((pickA ? a.bias[i] * 0.65 + b.bias[i] * 0.35 : b.bias[i] * 0.65 + a.bias[i] * 0.35) + (Math.random() - 0.5) * 0.04, -0.75, 0.75);
  }
  for (let i = 0; i < 36; i++) {
    const wa = a.weights[i] ?? BASE_WEIGHTS[i];
    const wb = b.weights[i] ?? BASE_WEIGHTS[i];
    weights[i] = clamp((Math.random() < 0.5 ? wa * 0.7 + wb * 0.3 : wb * 0.7 + wa * 0.3) + (Math.random() - 0.5) * 0.04, -1.5, 1.5);
  }
  return { arDecay, resGain, bias, weights };
}

export function cloneNeuralNetState(src: NeuralNetState): NeuralNetState {
  return {
    neurons: src.neurons.map((n) => ({ ...n })),
    weights: [...src.weights],
    cruiseOut: src.cruiseOut,
    brakeOut: src.brakeOut,
    steerOut: src.steerOut,
    gaitOut: src.gaitOut,
    aggressionOut: src.aggressionOut,
    isAggressive: src.isAggressive,
    mode: src.mode,
    atFoodTicks: src.atFoodTicks,
  };
}

export function crossoverNeuralNetStates(
  netA: NeuralNetState,
  netB: NeuralNetState,
): NeuralNetState {
  const child = createNeuralNetState();
  for (let i = 0; i < NEURON_COUNT; i++) {
    const na = netA.neurons[i];
    const nb = netB.neurons[i];
    const pickA = Math.random() < 0.5;
    const base = pickA ? na : nb;
    const other = pickA ? nb : na;
    child.neurons[i].arDecay = clamp(
      base.arDecay * 0.7 + other.arDecay * 0.3 + (Math.random() - 0.5) * 0.04,
      0.45,
      0.94,
    );
    child.neurons[i].resGain = clamp(
      base.resGain * 0.7 + other.resGain * 0.3 + (Math.random() - 0.5) * 0.04,
      0.12,
      0.7,
    );
    child.neurons[i].bias = clamp(
      base.bias * 0.65 + other.bias * 0.35 + (Math.random() - 0.5) * 0.05,
      -0.75,
      0.75,
    );
  }
  for (let i = 0; i < child.weights.length; i++) {
    const wa = netA.weights[i] ?? BASE_WEIGHTS[i];
    const wb = netB.weights[i] ?? BASE_WEIGHTS[i];
    child.weights[i] = clamp(
      (Math.random() < 0.5 ? wa * 0.7 + wb * 0.3 : wb * 0.7 + wa * 0.3) +
        (Math.random() - 0.5) * 0.04,
      -1.5,
      1.5,
    );
  }
  return child;
}

export function blendNeuralNetState(host: NeuralNetState, frag: NeuralNetState): void {
  for (let i = 0; i < NEURON_COUNT; i++) {
    host.neurons[i].state = host.neurons[i].state * 0.65 + frag.neurons[i].state * 0.35;
  }
  host.aggressionOut = host.aggressionOut * 0.65 + frag.aggressionOut * 0.35;
  host.isAggressive = host.aggressionOut >= 0.46;
  host.atFoodTicks = Math.max(host.atFoodTicks, frag.atFoodTicks);
}

// Pre-allocated scratch buffers so stepping 30+ organisms creates zero per-tick GC
const PREV_H = new Float64Array(NEURON_COUNT);
const INPUTS = new Float64Array(NEURON_COUNT);

/**
 * Steps the 6-neuron Auto-Regressive Residual Neural Network (AR-ResNet).
 * Every neuron k computes:
 *   act_k^(t) = tanh(x_k^(t) + neuralGain * (b_k + sum_j W_kj * h_j^(t-1)))
 *   res_k^(t) = clamp(x_k^(t), -1, 1)
 *   h_k^(t)   = alpha_k * h_k^(t-1) + (1 - alpha_k) * (rho_k * res_k^(t) + (1 - rho_k) * act_k^(t))
 *
 * Outputs mutually exclusive cruise vs. brake throttles so opposing flagella never fight in place.
 */
export function stepNeuralNet(net: NeuralNetState, obs: NeuralObservation): void {
  const neurons = net.neurons;
  const weights = net.weights;

  for (let i = 0; i < NEURON_COUNT; i++) {
    PREV_H[i] = neurons[i].state;
  }

  const hasGrad = obs.avgGradMag > 1e-6;
  const gradStrength = clamp(obs.avgGradMag * 34, 0, 1.5);
  const foodAlign = hasGrad ? obs.gradDot : 1.0;

  // Determine genuine flat peak arrival vs. still climbing an uphill scent slope toward nutrients
  const insideFoodPeak = obs.localFood > 0.65 && obs.avgGradMag < 0.0022;
  if (insideFoodPeak) {
    net.atFoodTicks = Math.min(60, net.atFoodTicks + 1);
  } else {
    net.atFoodTicks = Math.max(0, net.atFoodTicks - 2);
  }

  // 0: Turn input — lateral scent gradient + anti-180° commit aid when facing away
  let turnInput = hasGrad ? obs.gradCross * obs.gradientSensitivity * 1.15 : 0;
  if (hasGrad && foodAlign < -0.15) {
    // Break symmetry near 180 deg behind organism using remembered Commit sign (or small nudge)
    const commitSign =
      Math.abs(PREV_H[3]) > 0.06
        ? Math.sign(PREV_H[3])
        : Math.abs(obs.gradCross) > 1e-3
          ? Math.sign(obs.gradCross)
          : 1;
    turnInput += commitSign * (-foodAlign) * 0.65;
  }
  INPUTS[0] = clamp(turnInput, -1.5, 1.5);

  // 1: Seek input — brisk forward cruise when aligned with food; gentle pivot cruise when turning sharply
  let seekInput: number;
  if (insideFoodPeak) {
    // At the flat peak of the nutrient core: cease pushing forward so organism stays parked to feed
    seekInput = -0.55 - Math.max(0, obs.localFood - 0.65) * 0.85;
  } else if (hasGrad) {
    // Facing scent -> brisk cruise all the way up the slope; facing away -> gentle pivot cruise
    const alignDrive =
      foodAlign >= 0.35
        ? 0.58 + 0.42 * foodAlign
        : foodAlign >= 0
          ? 0.32 + 0.65 * foodAlign
          : Math.max(0.08, 0.24 + foodAlign * 0.16);
    const hungerBonus = (1 - obs.energyFactor) * 0.18;
    seekInput = clamp(alignDrive * (0.65 + 0.45 * Math.min(1, gradStrength)) + hungerBonus, 0.08, 1.35);
  } else {
    // No strong scent gradient yet: calm exploratory cruise
    seekInput = 0.42 + (1 - obs.energyFactor) * 0.18;
  }
  INPUTS[1] = seekInput;

  // 2: Brake input — strictly gated to dense flat food-peak coasting or high-speed overshoot past a peak
  let brakeInput = -0.75;
  if (insideFoodPeak && obs.forwardSpeed > 0.24) {
    brakeInput = clamp((obs.forwardSpeed - 0.18) * 1.45, 0.15, 1.25);
  } else if (obs.localFood > 0.6 && foodAlign < -0.5 && obs.forwardSpeed > 0.48 && net.atFoodTicks > 0) {
    brakeInput = clamp((obs.forwardSpeed - 0.35) * 1.1, 0.1, 1.0);
  } else if (obs.forwardSpeed < 0.15) {
    // Already stationary: explicitly release brake so flagella stay idle cleanly
    brakeInput = -0.9;
  }
  INPUTS[2] = brakeInput;

  // 3: Commit input — holds turn polarity only while sharply off-axis; releases cleanly once facing food
  INPUTS[3] = clamp(
    hasGrad && foodAlign < 0.25 && (Math.abs(obs.gradCross) > 0.1 || foodAlign < -0.1)
      ? Math.sign(turnInput || PREV_H[3] || 1) * (0.4 + 0.5 * Math.min(1, Math.abs(turnInput)))
      : PREV_H[0] * 0.12,
    -1.1,
    1.1,
  );

  // 4: Avoid input — responds to toxins / negative gradient potential
  const toxinUrgency = obs.localToxin > 0.06 ? clamp((obs.localToxin - 0.06) * 2.8, 0, 1.4) : 0;
  INPUTS[4] = toxinUrgency > 0 ? toxinUrgency : -0.35;

  // 5: Gait input — drives smooth muscle wave amplitude
  INPUTS[5] = insideFoodPeak
    ? -0.25
    : clamp(0.3 + Math.abs(turnInput) * 0.25 + Math.max(0, seekInput) * 0.5 + toxinUrgency * 0.4, -0.5, 1.3);

  // Living NEURAL cells + sensor->neural->effector connectivity modulate synaptic integration
  const eff = obs.neuralEfficiency !== undefined ? obs.neuralEfficiency : 0.85;
  const neuralGain = (0.48 + 0.52 * eff) * (0.72 + Math.min(0.68, obs.neuralDensity * 2.4));

  // Update every neuron k with recurrent matrix W, per-neuron residual skip, and AR smoothing
  for (let k = 0; k < NEURON_COUNT; k++) {
    const n = neurons[k];
    const xk = INPUTS[k];
    n.input = xk;

    let recDrive = n.bias;
    const rowOff = k * NEURON_COUNT;
    for (let j = 0; j < NEURON_COUNT; j++) {
      recDrive += weights[rowOff + j] * PREV_H[j];
    }

    const nonlinear = Math.tanh(xk + recDrive * neuralGain);
    const resPath = clamp(xk, -1, 1);
    n.residual = resPath;

    const combined = n.resGain * resPath + (1 - n.resGain) * nonlinear;
    n.state = clamp(n.arDecay * PREV_H[k] + (1 - n.arDecay) * combined, -1, 1);
  }

  // Decode mutually exclusive locomotion commands from post-residual AR neuron states
  const turnH = neurons[0].state;
  const seekH = neurons[1].state;
  const brakeH = neurons[2].state;
  const commitH = neurons[3].state;
  const avoidH = neurons[4].state;
  const gaitH = neurons[5].state;

  // Steering torque blends Turn + Commit residual + toxin Avoidance
  const commitBlend = foodAlign < 0.4 ? 0.28 : 0.05;
  const steerDir = clamp(turnH * 0.9 + commitH * commitBlend + avoidH * 0.25 * (Math.sign(turnH) || 1), -1, 1);
  net.steerOut = steerDir;
  net.gaitOut = clamp(0.65 + gaitH * 0.55, 0.2, 1.25);

  const positiveSeek = Math.max(0, seekH);
  const positiveBrake = Math.max(0, brakeH);
  const turnMag = Math.abs(steerDir);

  let cruiseOut = 0;
  let brakeOut = 0;
  let mode: LocomotionMode = 'coast';

  // Strict hysteresis gate: Brake ONLY fires when Brake neuron beats Seek neuron by margin AND
  // the organism is genuinely drifting forward near/into a nutrient plume.
  if (positiveBrake > positiveSeek + 0.14 && obs.forwardSpeed > 0.16 && obs.localFood > 0.34) {
    cruiseOut = 0;
    brakeOut = clamp((positiveBrake - 0.1) * 1.25, 0, 1);
    mode = 'brake';
  } else if (positiveSeek > 0.08 || (turnMag > 0.22 && !insideFoodPeak)) {
    const turnThrottleCap = foodAlign < 0.1 && hasGrad ? 0.38 : 1.0;
    cruiseOut = clamp(positiveSeek * 1.12 + turnMag * 0.12, 0, turnThrottleCap);
    brakeOut = 0;
    mode = turnMag > 0.36 && foodAlign < 0.45 ? 'turn' : 'seek';
  } else {
    cruiseOut = 0;
    brakeOut = 0;
    mode = 'coast';
  }

  net.cruiseOut = cruiseOut;
  net.brakeOut = brakeOut;
  net.mode = mode;

  // AR-smoothed neural aggression output: activates spikes only when pursuing/engaging a target
  // with sufficient ATP and neural Seek > Avoid/Brake dominance (calm foraging retracts spikes).
  const hostileDrive = clamp(obs.hostileProx ?? 0, 0, 1);
  const spikeFactor = obs.spikeDensity !== undefined ? Math.min(1, 0.35 + obs.spikeDensity * 4.0) : 1.0;
  const engageDrive =
    obs.energyFactor >= 0.36 && !insideFoodPeak
      ? clamp(
          hostileDrive * (0.48 + 0.52 * positiveSeek + 0.18 * turnMag) * spikeFactor -
            Math.max(0, avoidH) * 0.65 -
            positiveBrake * 0.32,
          0,
          1,
        )
      : 0;
  net.aggressionOut = clamp(net.aggressionOut * 0.72 + engageDrive * 0.28, 0, 1);
  const threshold = net.isAggressive ? 0.36 : 0.46;
  net.isAggressive =
    net.aggressionOut >= threshold && obs.energyFactor >= 0.34 && avoidH < 0.48;
}
