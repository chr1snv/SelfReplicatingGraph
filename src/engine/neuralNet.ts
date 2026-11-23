import {
  CompiledGenome,
  LocomotionMode,
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
const NEURON_LABELS = ['Turn', 'Seek', 'Brake', 'Commit', 'Avoid', 'Gait'];

// Default 6x6 recurrent synaptic matrix W[row * 6 + col] (pre-synaptic col j -> post-synaptic row k)
// Key motif: Seek (1) and Brake (2) form a mutually inhibitory bistable latch so forward
// and reverse flagella never rapidly alternate against each other.
const BASE_WEIGHTS: number[] = [
  //   Turn   Seek   Brake  Commit  Avoid   Gait
  /*0*/ 0.18, 0.06, -0.15,  0.42,  0.22,  0.04, // Turn: reinforced by Commit & Avoid
  /*1*/ 0.05, 0.48, -0.95,  0.12,  0.28,  0.10, // Seek: self-exciting AR latch, strongly inhibited by Brake
  /*2*/-0.08,-0.78,  0.42, -0.10, -0.35, -0.05, // Brake: suppressed while Seek or Avoid is active
  /*3*/ 0.55, 0.08, -0.12,  0.52,  0.15,  0.00, // Commit: remembers Turn polarity across blind spots
  /*4*/ 0.00, 0.10, -0.20,  0.10,  0.38,  0.05, // Avoid: evasive persistence
  /*5*/ 0.20, 0.45, -0.35,  0.12,  0.32,  0.30, // Gait: couples muscle CPG to active Seek/Turn/Avoid
];

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
  gradientSensitivity: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function createNeuralNetState(genome?: CompiledGenome): NeuralNetState {
  // Derive subtle baseline specialization from the organism's neural & sensor genome ratios
  let neuralBias = 0;
  let flagellaBias = 0;
  if (genome) {
    const l0 = genome.layers[0];
    const active = Math.max(1, l0.activeCount);
    neuralBias = clamp(l0.tissueCounts[TissueType.NEURAL] / active, 0, 0.3);
    flagellaBias = clamp(l0.tissueCounts[TissueType.FLAGELLA] / active, 0, 0.3);
  }

  const specs: Array<{ arDecay: number; resGain: number; bias: number; initState: number }> = [
    { arDecay: 0.68, resGain: 0.42, bias: 0.0, initState: 0.0 }, // 0 Turn
    { arDecay: 0.80, resGain: 0.32, bias: 0.22 + flagellaBias * 0.4, initState: 0.45 }, // 1 Seek
    { arDecay: 0.82, resGain: 0.24, bias: -0.32, initState: 0.0 }, // 2 Brake
    { arDecay: 0.88, resGain: 0.28, bias: 0.0, initState: 0.0 }, // 3 Commit
    { arDecay: 0.70, resGain: 0.46, bias: -0.08, initState: 0.0 }, // 4 Avoid
    { arDecay: 0.78, resGain: 0.34, bias: 0.14 + neuralBias * 0.25, initState: 0.45 }, // 5 Gait
  ];

  const neurons: NeuronState[] = specs.map((sp, id) => ({
    id,
    label: NEURON_LABELS[id],
    state: sp.initState,
    residual: sp.initState,
    input: 0,
    arDecay: sp.arDecay,
    resGain: sp.resGain,
    bias: sp.bias,
  }));

  return {
    neurons,
    weights: [...BASE_WEIGHTS],
    cruiseOut: 0.65,
    brakeOut: 0.0,
    steerOut: 0.0,
    gaitOut: 0.75,
    mode: 'seek',
    atFoodTicks: 0,
  };
}

export function cloneNeuralNetState(src: NeuralNetState): NeuralNetState {
  return {
    neurons: src.neurons.map((n) => ({ ...n })),
    weights: [...src.weights],
    cruiseOut: src.cruiseOut,
    brakeOut: src.brakeOut,
    steerOut: src.steerOut,
    gaitOut: src.gaitOut,
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
      0.52,
      0.92,
    );
    child.neurons[i].resGain = clamp(
      base.resGain * 0.7 + other.resGain * 0.3 + (Math.random() - 0.5) * 0.04,
      0.18,
      0.55,
    );
    child.neurons[i].bias = clamp(
      base.bias * 0.65 + other.bias * 0.35 + (Math.random() - 0.5) * 0.05,
      -0.6,
      0.6,
    );
  }
  for (let i = 0; i < child.weights.length; i++) {
    const wa = netA.weights[i] ?? BASE_WEIGHTS[i];
    const wb = netB.weights[i] ?? BASE_WEIGHTS[i];
    child.weights[i] = clamp(
      (Math.random() < 0.5 ? wa * 0.7 + wb * 0.3 : wb * 0.7 + wa * 0.3) +
        (Math.random() - 0.5) * 0.04,
      -1.35,
      1.35,
    );
  }
  return child;
}

export function blendNeuralNetState(host: NeuralNetState, frag: NeuralNetState): void {
  for (let i = 0; i < NEURON_COUNT; i++) {
    host.neurons[i].state = host.neurons[i].state * 0.65 + frag.neurons[i].state * 0.35;
  }
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

  // Living NEURAL cells amplify recurrent synaptic integration across the network
  const neuralGain = 0.72 + Math.min(0.68, obs.neuralDensity * 2.4);

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
}
