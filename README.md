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

### 2. Seven Specialized Tissue Types
- **Epidermis**: Protective outer membrane that retains internal pressure and metabolic ATP.
- **Mesoderm**: Elastic structural matrix anchoring soft-body geometry.
- **Vascular**: Harvests surrounding nutrients and accelerates cellular ATP distribution.
- **Neural**: Integrates sensory signals and drives coordinated motor waves.
- **Gradient Sensor**: Detects ambient food, pheromone scent trails, and toxins for chemotaxis.
- **Muscle**: Contractile springs modulate rest lengths to deform and undulate body shape.
- **Flagella**: Directional fluid propulsion cilia/whips with dedicated steering and braking pairs.

### 3. BoxEye Soft-Body Physics & Auto-Regressive Residual Neural Network (`AR-ResNet`)
- **Deformable Soft Mesh**: Cells map to shared quad vertices connected by structural/diagonal springs and pushed apart by an internal ideal-gas pressure model (inspired by BoxEye) to resist collapse.
- **Crush Rupture, Cleavage & Reconnection**: High-compression impacts rupture cell membranes, split disconnected components while strictly conserving metabolic energy, and allow same-colony fragments to fuse back together if morphogenesis regrows matching boundary tissue.
- **6-Neuron AR-ResNet Controller**: Each organism carries a heritable 6-neuron Auto-Regressive Residual Neural Network (`SensL`, `SensR`, `Cruise`, `Steer`, `Brake`, `Gait`) that blends smooth temporal persistence with residual skip connections and mutual Cruise/Brake inhibition so swimmers home cleanly on nutrients without oscillating in place.
- **Sexual DNA Crossover**: Organisms mate on proximity (or via the **Mate** action) by recombining their directive connectivity graphs and AR-ResNet weights into Generation 2+ hybrids.

### 4. WebGL2 GPU Shader Rendering (`Canvas 3D`)
- **World Ecosystem (`WorldGLRenderer`)**: Runs a `128×80` ping-pong GPU reaction-diffusion shader for food/scent/toxin plumes, fullscreen grid & isoline backdrop shader, batched deformable cell quad SDF shader, `gl.LINES` membrane/spring/sensor ray batching, procedural radial-glow `gl.POINTS` pellets, and a **GPU Flagella Whip Vertex Shader** computing travelling sinusoidal waveforms on the GPU.
- **Morphogenesis Growth (`MorphGLRenderer`)**: Runs a GPU ping-pong nutrient glow pass and a single-pass **`L3 → L0` Mipmap Composite Fragment Shader** evaluating progenitor somas, nuclei, cell walls, neural flashes, target ghost overlay, and directive graph overlays.
- **Blueprint & Level-Set φ (`BlueprintGLRenderer`)**: Renders real-time tissue painting, sub-cell resolution grids, and topographic level-set distance isolines (`φ`) directly in fragment shaders.

### 5. Missions, Achievements & Mobile Controls
- **6 Research Missions & 8 Achievements** tracked live across both the World Ecosystem and Blueprint Designer with `localStorage` persistence.
- **Mobile-First Controls**: Canvas-first responsive layout on phones and tablets, thumb-reachable 56px bottom dock (`Tools` / `Brushes`, `Physics` / `Growth`, `Inspect`, `Play/Pause`), enlarged touch range sliders, and touch-friendly hit radii when selecting moving swimmers.

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
