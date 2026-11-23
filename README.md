# MorphoGraph — Multi-Tissue Mipmap Morphogenesis & Soft-Body Ecosystem

> **Made with AI Studio** — Designed, simulated, and built with Google AI Studio.

**MorphoGraph** is an interactive WebGL2 cellular morphogenesis workbench and soft-body artificial life ecosystem inspired by [chr1snv/SelfReplicatingGraph](https://github.com/chr1snv/SelfReplicatingGraph). Design multi-tissue organisms, compile them into hierarchical `L3 → L0` directive connectivity graphs, and release them into a fluid chemotaxis ecosystem where they swim, deform, sense chemical scents, rupture, split, regenerate, and crossbreed DNA.

- **Repository**: https://github.com/chr1snv/SelfReplicatingGraph/
- **Live GitHub Pages**: https://chr1snv.github.io/SelfReplicatingGraph/

---

## Core Systems & Architecture

### 1. Reverse-Compiled Level-Set Mipmap Morphogenesis (`L3 → L0`)
Instead of getting grid-locked on a dense 2D cellular grid where interior cells have no room to divide, MorphoGraph compiles any `128×128` target blueprint backwards into a 4-level level-set mipmap pyramid (`L0 128×128 → L1 64×64 → L2 32×32 → L3 16×16`) and grows forwards:
1. **Sparse L3 Macro-Scaffold** establishes the coarse body axis first.
2. **L2 Organ Domains** subdivide from L3 progenitors.
3. **L1 Tissue Architecture** refines organs & vascular nutrient channels.
4. **L0 Fine Cellular Resolution** completes full specialized anatomy.

### 2. Ten Specialized Tissue Types & Physiological Connectivity
- **Epidermis**: Protective outer membrane that retains internal pressure and metabolic ATP.
- **Mesoderm**: Elastic structural matrix anchoring soft-body geometry.
- **Vascular**: Harvests surrounding nutrients and delivers ATP across organs via connected BFS channels (`vascularSupply`).
- **Neural**: Relays chemo-sensory gradients (`SENSOR` → `NEURAL` → effectors) into coordinated flagella steering and braking.
- **Gradient Sensor**: Detects ambient food, pheromone scent trails, and toxins for chemotaxis.
- **Muscle**: Contractile springs modulate rest lengths to deform and undulate body shape (scaled by vascular ATP and neural coupling).
- **Flagella**: Directional fluid propulsion cilia/whips with dedicated steering and braking pairs.
- **Digestive**: Metabolic gut cells boosting ATP extraction efficiency from consumed food pellets and ambient nutrients.
- **Excretory**: Renal waste-filtering cells clearing metabolic waste buildup and shielding against environmental toxins.
- **Chitin Spike**: Calcified boundary spines reinforcing shell crush resistance and inflicting piercing collision damage on rival organisms.

### 3. BoxEye Soft-Body Physics & Auto-Regressive Residual Neural Network (`AR-ResNet`)
- **Deformable Soft Mesh (Pre-Allocated Zero-GC Buffers)**: Cells map to shared quad vertices connected by structural/diagonal springs and pushed apart by an internal ideal-gas pressure model (inspired by BoxEye), running on fixed pre-allocated module typed arrays (`Float32Array`/`Int32Array`/`Uint8Array`) to minimize garbage collection stalls.
- **Crush Rupture, Cleavage & Reconnection**: High-compression impacts or spike strikes rupture cell membranes, split disconnected components while strictly conserving metabolic energy and waste, and allow same-colony fragments to fuse back together if morphogenesis regrows matching boundary tissue.
- **Interactive AR-ResNet Controller Editor**: Blueprint Designer includes live per-neuron tuning (`α` auto-regressive decay, `ρ` residual skip gain, `b` bias), synaptic latch weights, presets, and a genetic recombination guide showing how directive graphs and AR-ResNet parameters cross over during mating.
- **Sexual DNA Crossover**: Organisms mate on proximity (or via the **Mate** action) by recombining both their `L3 → L0` morphogenesis directive graphs and 6-neuron AR-ResNet weights into Generation 2+ hybrids.

### 4. WebGL2 GPU Shader Rendering (`Canvas 3D`) & Adaptive Per-Biome Music
- **Enlarged `1600×1000` World Ecosystem (`WorldGLRenderer`)**: Runs a `160×100` diffusion simulation for edge-reaching food plumes, fast post-consumption dissipation, organism identity/mood scents (`foraging`, `amorous`, `threatened`, `exhausted`, `aggressive`), and toxin hazards, plus volumetric sunlight shafts, `9×8` pixel-art mating hearts, chitin spikes, faction rings/diamonds, energy barrier shaders, and a **GPU Flagella Whip Vertex Shader**.
- **Sunlight & Photosynthesizing Flora**: Sunbeams nourish photosynthetic algal colonies that regrow dynamically inside sunlit zones and supply solar ATP trickle.
- **Procedural SFX & Adaptive Biome Music (`soundEngine`)**: Each of the 5 aquatic biomes has a unique musical scale, synth waveform, filter timbre, and tempo that dynamically layers extra harmonic fifths, foraging/mating shimmers, and battle rhythm accents based on population, food abundance, and barrier state.
- **Morphogenesis Growth (`MorphGLRenderer`)**: Runs a GPU ping-pong nutrient glow pass and a single-pass **`L3 → L0` Mipmap Composite Fragment Shader**.
- **Blueprint & Level-Set φ (`BlueprintGLRenderer`)**: Renders real-time tissue painting and topographic level-set distance isolines (`φ`) directly in fragment shaders.

### 5. Five Aquatic Biomes, Battle vs AI, Missions & Mobile Controls
- **5 Progressive Biomes**: Unlock **Sunlit Garden Pond**, **Coastal Tidepool**, **Forest Leaf Droplet**, **Under Frozen Ice**, and **Bioluminescent Cave** sequentially by completing each biome's research mission.
- **Battle vs AI Mode**: Player (left, cyan glow) and AI Commander (right, crimson glow + diamond reticle) grow colonies by consuming territory pellets before the containment wall breaks (`10,000 PWR` or `15 organisms`). Once shattered, manual spawning locks and survival depends on replication, mating, and spike combat until one side controls the tank.
- **Missions, Achievements & Mobile Controls**: 11 research missions and 10 achievements persisted in `localStorage`, plus a mobile-first bottom dock and enlarged touch sliders/hit targets.

---

## Local Development

```bash
npm install
npm run dev
```

Build static production output (`dist/index.html` + relative `./assets/`):

```bash
npm run build
```

---

## Deploying to GitHub Pages (`https://chr1snv.github.io/SelfReplicatingGraph/`)

`vite.config.ts` is configured with `base: './'` and `.github/workflows/deploy.yml` automates deployment so `index.html` works seamlessly under `/SelfReplicatingGraph/`:

1. Push this repository to `https://github.com/chr1snv/SelfReplicatingGraph/`.
2. In the GitHub repository go to **Settings → Pages → Build and deployment**.
3. Set **Source** to **GitHub Actions**.
4. Every push to `main` (or `master`) builds the Vite app and publishes `dist/index.html` directly to `https://chr1snv.github.io/SelfReplicatingGraph/`.

*(Alternatively, if hosting static built files directly from a branch without Actions, copy the contents of `dist/` after running `npm run build`—`index.html` and `./assets/`—to the root of your published branch.)*
