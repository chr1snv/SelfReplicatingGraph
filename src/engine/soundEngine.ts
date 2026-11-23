import { BiomeId, WorldSoundEvent } from '../types/morphogenesis';

export interface MusicAdaptiveContext {
  biomeId: BiomeId;
  organismCount: number;
  totalFood: number;
  amorousCount: number;
  battleEnabled: boolean;
  barrierActive: boolean;
}

interface BiomeMusicProfile {
  scale: number[];
  wave: OscillatorType;
  baseIntervalMs: number;
  filterBaseHz: number;
  decaySec: number;
}

const BIOME_MUSIC: Record<BiomeId, BiomeMusicProfile> = {
  pond: {
    // Calm major Lydian pentatonic (warm water marimba)
    scale: [174.61, 220.0, 261.63, 293.66, 329.63, 392.0, 440.0, 523.25],
    wave: 'sine',
    baseIntervalMs: 1020,
    filterBaseHz: 680,
    decaySec: 1.75,
  },
  tidepool: {
    // Crisp Mixolydian coastal shimmer (brighter wave plucks)
    scale: [196.0, 246.94, 293.66, 349.23, 392.0, 440.0, 523.25, 587.33],
    wave: 'triangle',
    baseIntervalMs: 820,
    filterBaseHz: 940,
    decaySec: 1.35,
  },
  leaf_droplet: {
    // Delicate forest raindrop pentatonic (high chime harmonics)
    scale: [261.63, 329.63, 392.0, 493.88, 523.25, 659.25, 783.99],
    wave: 'sine',
    baseIntervalMs: 760,
    filterBaseHz: 1180,
    decaySec: 1.45,
  },
  frozen_ice: {
    // Crystalline Dorian icy bells (sparse, airy high harmonics)
    scale: [220.0, 261.63, 293.66, 329.63, 440.0, 523.25, 659.25],
    wave: 'sine',
    baseIntervalMs: 1180,
    filterBaseHz: 1350,
    decaySec: 2.15,
  },
  cave: {
    // Deep cavern Phrygian bass & resonant subterranean sonar
    scale: [110.0, 116.54, 146.83, 164.81, 174.61, 220.0, 261.63],
    wave: 'triangle',
    baseIntervalMs: 1120,
    filterBaseHz: 460,
    decaySec: 2.2,
  },
};

/**
 * Procedural Web Audio API sound effects & per-biome adaptive music synthesizer.
 * Overlays population harmony voices, food abundance shimmer arpeggios,
 * mating chimes, and battle war-drum pulses without external dependencies.
 */
class MorphoSoundEngine {
  private ctx: AudioContext | null = null;
  private sfxGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private sfxEnabled = true;
  private musicEnabled = false;
  private musicTimer: number | null = null;
  private lastEatAt = 0;
  private lastRuptureAt = 0;
  private stepIdx = 0;

  private adaptive: MusicAdaptiveContext = {
    biomeId: 'pond',
    organismCount: 6,
    totalFood: 10,
    amorousCount: 0,
    battleEnabled: false,
    barrierActive: false,
  };

  private battleScale = [146.83, 174.61, 196.0, 220.0, 261.63, 293.66, 349.23];

  private ensureContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return null;

    if (!this.ctx) {
      this.ctx = new AudioCtx();
      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = 0.24;
      this.sfxGain.connect(this.ctx.destination);

      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 0.14;
      this.musicGain.connect(this.ctx.destination);
    }

    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  setSfxEnabled(enabled: boolean): void {
    this.sfxEnabled = enabled;
    if (enabled) this.ensureContext();
  }

  setMusicEnabled(enabled: boolean): void {
    this.musicEnabled = enabled;
    if (enabled) {
      this.ensureContext();
      this.startMusicLoop();
    } else {
      this.stopMusicLoop();
    }
  }

  setBattleMode(active: boolean): void {
    this.adaptive.battleEnabled = active;
  }

  updateAdaptiveContext(ctx: Partial<MusicAdaptiveContext>): void {
    if (ctx.biomeId !== undefined) this.adaptive.biomeId = ctx.biomeId;
    if (ctx.organismCount !== undefined) this.adaptive.organismCount = ctx.organismCount;
    if (ctx.totalFood !== undefined) this.adaptive.totalFood = ctx.totalFood;
    if (ctx.amorousCount !== undefined) this.adaptive.amorousCount = ctx.amorousCount;
    if (ctx.battleEnabled !== undefined) this.adaptive.battleEnabled = ctx.battleEnabled;
    if (ctx.barrierActive !== undefined) this.adaptive.barrierActive = ctx.barrierActive;
  }

  private startMusicLoop(): void {
    if (this.musicTimer !== null || typeof window === 'undefined') return;
    const playStep = () => {
      if (!this.musicEnabled) return;
      const ctx = this.ctx;
      const out = this.musicGain;
      const profile = BIOME_MUSIC[this.adaptive.biomeId] ?? BIOME_MUSIC.pond;
      const scale = this.adaptive.battleEnabled ? this.battleScale : profile.scale;
      const popFactor = Math.min(1, this.adaptive.organismCount / 20);
      const foodFactor = Math.min(1, this.adaptive.totalFood / 14);
      const battleCombatActive = this.adaptive.battleEnabled && !this.adaptive.barrierActive;

      if (ctx && out && ctx.state === 'running') {
        const now = ctx.currentTime;
        const noteIdx = (this.stepIdx * 3 + Math.floor(Math.random() * 2)) % scale.length;
        const note = scale[noteIdx];

        // Primary Biome Melody Voice (brightness shifts with food abundance)
        const osc = ctx.createOscillator();
        const filter = ctx.createBiquadFilter();
        const env = ctx.createGain();
        osc.type = this.adaptive.battleEnabled ? 'triangle' : profile.wave;
        osc.frequency.setValueAtTime(note, now);
        filter.type = 'lowpass';
        const cutoff = profile.filterBaseHz * (0.7 + foodFactor * 0.7) + (battleCombatActive ? 350 : 0);
        filter.frequency.setValueAtTime(cutoff, now);

        const dec = battleCombatActive ? profile.decaySec * 0.72 : profile.decaySec;
        env.gain.setValueAtTime(0.0001, now);
        env.gain.exponentialRampToValueAtTime(0.16, now + 0.06);
        env.gain.exponentialRampToValueAtTime(0.0001, now + dec);

        osc.connect(filter);
        filter.connect(env);
        env.connect(out);
        osc.start(now);
        osc.stop(now + dec + 0.1);

        // Adaptive Overlay 1: Population Harmony Fifth (scales softly with live organism count)
        if (this.adaptive.organismCount >= 5 && this.stepIdx % 2 === 0) {
          const harm = ctx.createOscillator();
          const hEnv = ctx.createGain();
          const fifth = scale[(noteIdx + 2) % scale.length];
          harm.type = 'sine';
          harm.frequency.setValueAtTime(fifth, now + 0.03);
          const hVol = 0.04 + popFactor * 0.11;
          hEnv.gain.setValueAtTime(0.0001, now + 0.03);
          hEnv.gain.exponentialRampToValueAtTime(hVol, now + 0.14);
          hEnv.gain.exponentialRampToValueAtTime(0.0001, now + 1.45);
          harm.connect(hEnv);
          hEnv.connect(out);
          harm.start(now + 0.03);
          harm.stop(now + 1.55);
        }

        // Adaptive Overlay 2: Food-Abundance / Mating Shimmer Arpeggio
        if ((foodFactor > 0.48 || this.adaptive.amorousCount >= 2) && this.stepIdx % 3 === 1) {
          const shimmer = ctx.createOscillator();
          const sEnv = ctx.createGain();
          shimmer.type = 'sine';
          shimmer.frequency.setValueAtTime(note * 2, now + 0.12);
          sEnv.gain.setValueAtTime(0.0001, now + 0.12);
          sEnv.gain.exponentialRampToValueAtTime(0.075, now + 0.16);
          sEnv.gain.exponentialRampToValueAtTime(0.0001, now + 0.65);
          shimmer.connect(sEnv);
          sEnv.connect(out);
          shimmer.start(now + 0.12);
          shimmer.stop(now + 0.72);
        }

        // Adaptive Overlay 3: Bass / Battle War-Drum Pulse
        if (this.stepIdx % 4 === 0 || (battleCombatActive && this.stepIdx % 2 === 0)) {
          const bass = ctx.createOscillator();
          const bEnv = ctx.createGain();
          bass.type = battleCombatActive ? 'triangle' : 'sine';
          const rootHz = scale[0] * 0.5;
          bass.frequency.setValueAtTime(battleCombatActive ? rootHz * 1.15 : rootHz, now);
          if (battleCombatActive) {
            bass.frequency.exponentialRampToValueAtTime(Math.max(45, rootHz * 0.75), now + 0.25);
          }
          bEnv.gain.setValueAtTime(0.0001, now);
          bEnv.gain.exponentialRampToValueAtTime(battleCombatActive ? 0.26 : 0.2, now + (battleCombatActive ? 0.04 : 0.3));
          bEnv.gain.exponentialRampToValueAtTime(0.0001, now + (battleCombatActive ? 0.65 : 2.6));
          bass.connect(bEnv);
          bEnv.connect(out);
          bass.start(now);
          bass.stop(now + 2.75);
        }

        this.stepIdx++;
      }

      const tempoScale = 1 - popFactor * 0.22 - (battleCombatActive ? 0.24 : this.adaptive.battleEnabled ? 0.14 : 0);
      const intervalMs = Math.max(420, Math.round(profile.baseIntervalMs * tempoScale));
      this.musicTimer = window.setTimeout(playStep, intervalMs);
    };

    playStep();
  }

  private stopMusicLoop(): void {
    if (this.musicTimer !== null) {
      window.clearTimeout(this.musicTimer);
      this.musicTimer = null;
    }
  }

  playEvents(events: WorldSoundEvent[]): void {
    if (!this.sfxEnabled || events.length === 0) return;
    const ctx = this.ctx;
    const out = this.sfxGain;
    if (!ctx || !out || ctx.state !== 'running') return;

    const nowMs = performance.now();
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (ev.type === 'eat') {
        if (nowMs - this.lastEatAt < 110) continue;
        this.lastEatAt = nowMs;
        this.playDropTone(520 + Math.random() * 180, 740, 0.11, 0.22);
      } else if (ev.type === 'mate') {
        this.playMateChime();
      } else if (ev.type === 'spawn') {
        this.playDropTone(340, 560, 0.18, 0.25);
      } else if (ev.type === 'split' || ev.type === 'rupture') {
        if (nowMs - this.lastRuptureAt < 140) continue;
        this.lastRuptureAt = nowMs;
        this.playSnapTone(210, 95, 0.14);
      } else if (ev.type === 'reconnect') {
        this.playDropTone(392, 587, 0.22, 0.32);
      } else if (ev.type === 'breach') {
        this.playBreachFanfare();
      } else if (ev.type === 'victory') {
        this.playVictoryChord();
      }
    }
  }

  triggerUiSound(type: WorldSoundEvent['type']): void {
    if (!this.sfxEnabled) return;
    this.ensureContext();
    this.playEvents([{ type, intensity: 1 }]);
  }

  private playDropTone(startHz: number, endHz: number, dur: number, vol: number): void {
    const ctx = this.ctx!;
    const out = this.sfxGain!;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(startHz, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, endHz), t + dur);
    env.gain.setValueAtTime(0.001, t);
    env.gain.exponentialRampToValueAtTime(vol, t + 0.015);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(env);
    env.connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private playMateChime(): void {
    this.playDropTone(523.25, 659.25, 0.16, 0.24);
    if (typeof window !== 'undefined') {
      window.setTimeout(() => {
        if (this.ctx && this.ctx.state === 'running') {
          this.playDropTone(659.25, 783.99, 0.22, 0.22);
        }
      }, 95);
    }
  }

  private playSnapTone(startHz: number, endHz: number, dur: number): void {
    const ctx = this.ctx!;
    const out = this.sfxGain!;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(startHz, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, endHz), t + dur);
    env.gain.setValueAtTime(0.28, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(env);
    env.connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private playBreachFanfare(): void {
    this.playSnapTone(160, 48, 0.42);
    this.playDropTone(293.66, 587.33, 0.35, 0.34);
  }

  private playVictoryChord(): void {
    const freqs = [261.63, 329.63, 392.0, 523.25];
    freqs.forEach((f, idx) => {
      window.setTimeout(() => {
        if (this.ctx && this.ctx.state === 'running') {
          this.playDropTone(f, f * 1.02, 0.45, 0.22);
        }
      }, idx * 80);
    });
  }
}

export const soundEngine = new MorphoSoundEngine();
