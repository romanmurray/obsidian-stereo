export type VisualizerMode =
	| "bars"
	| "waveform"
	| "radio"
	| "boombox"
	| "stereo"
	| "cover";

const BAR_COUNT = 48;

/** Frequency-bars view — a real octave-band dB meter, the way a spectrum
 * analyser actually works. Two things make it read naturally, neither a fixed
 * shape:
 *   1. LOG frequency axis. The FFT gives ~46.9 Hz-wide bins on a LINEAR scale,
 *      so a bin→bar mapping spends most bars on bass and leaves the treble half
 *      dead (the old "permanently bass-heavy" look). Instead each bar spans an
 *      equal slice of OCTAVES from BARS_MIN_HZ to BARS_MAX_HZ.
 *   2. DECIBEL amplitude. getByteFrequencyData already returns dB (it maps the
 *      analyser's dBFS window onto 0…255), so bar height = byte/255 is a dB-scaled
 *      fill: every band shares the same ceiling and how far each bar fills is the
 *      dynamic part. Bass reads taller only when the bass is genuinely louder.
 * No tilt / no baked-in curve — the bars just reflect the real per-band level. */
const BARS_MIN_HZ = 20;
const BARS_MAX_HZ = 20000;
/** dBFS window mapped onto the meter's full height. Narrower than the analyser
 * default (−100…−30) so typical music fills the meter instead of hugging the
 * floor; the top stays −30 dBFS so only genuinely loud bands reach the ceiling. */
const BARS_MIN_DB = -80;
const BARS_MAX_DB = -30;
/** Per-bar temporal smoothing so single-bin peaks don't strobe (attack fast so
 * hits still pop, release slower so they fall gracefully). */
const BARS_ATTACK = 0.5;
const BARS_RELEASE = 0.25;

/** Album-art bars view. The exact same octave-band levels as the frequency bars
 * (barTargets), but each bar is a vertical SLICE of the current cover masked to
 * that band's height — the art paints in bottom-up as the music fills the
 * spectrum (loud full-spectrum reveals the whole cover, quiet leaves it mostly
 * hidden). The left of the cover reacts to bass, the right to treble. Strip count
 * is DECOUPLED from BAR_COUNT so the image resolution and the meter resolution
 * tune independently; strips tile flush (no gap) on integer pixel boundaries so a
 * full-height reveal reads as one seamless image. Falls back to the plain accent
 * bars when the track has no cover (loading, or radio — though radio never reaches
 * this mode; effectiveNowPlayingView overrides it). */
const COVER_STRIPS = 32;
/** Faint full-cover underlay so a ghost of the art is always visible and the
 * strips "light it to full brightness" (0 = dark voids between short bars). */
const COVER_GHOST = 0;
/** Optional 1px accent cap riding each strip's top edge — a subtle tie back to
 * the theme accent. Off by default (the art carries the view). */
const COVER_PEAK_CAPS = false;

/** Radio-tower view. Tuned in the standalone mockup and locked here — this is a
 * TIME-DRIVEN loop (internet radio can't be captured/analysed, so there is no
 * signal to react to; a steady broadcast animation is the right model). Radii
 * are fractions of the canvas half-size; the tip is a fraction of the canvas.
 * The wave colour is the art's own red, not the theme accent, so it always
 * matches the illustration. */
const RADIO = {
	tip: { x: 0.5, y: 0.405 },
	color: "#d1472c",
	speed: 0.19, // rings born per second
	ringCount: 3, // rings in flight at once
	thickness: 3,
	startRadius: 0.04,
	maxRadius: 0.76,
	opacity: 0.6,
	notesColor: "#2b2b2b",
} as const;

/** Portable-radio (boom box) view. Like the tower it's a base illustration
 * tinted to the theme, but this one is AUDIO-REACTIVE: the round speaker grille
 * "thumps" with the bass — the cone pumps continuously with the level, and a
 * ripple ring + room wave + note fire on each bass hit (a rising-edge onset).
 * Values were dialled in the standalone mockup (boombox-viz-mockup.html), where
 * a simulated beat stands in for the analyser. Speaker coords are fractions of
 * the drawn illustration (source art 1448×1086); ring/wave radii are multiples
 * of the grille radius. With no analyser (internet radio) it self-pulses on a
 * slow idle beat so it never sits dead. Effects take the theme accent. */
const BOOMBOX = {
	speaker: { x: 0.33, y: 0.65, r: 0.124 }, // grille centre + mesh radius
	lowBinShare: 0.012, // deep-kick band only (~first 6 of 512 bins, up to ~130 Hz)
	smoothing: 0.55, // analyser smoothing while this view runs (punchier than 0.8)
	// Speaker cone modelled as a damped spring: a bass hit kicks it outward, it
	// springs back and settles. This makes the grille physically move with the
	// beat (quick out-and-back), dark at rest — not a sustained glow. Tune
	// impulse for how far it kicks, damping for how much it rings back.
	cone: { stiffness: 200, damping: 16, impulse: 12, dispGain: 1.6, restGlow: 0.05 },
	rings: { life: 0.35, startR: 1, maxR: 2.6, thickness: 2, opacity: 0.6 },
	waves: { life: 1.8, maxR: 3.5, thickness: 2, opacity: 0.15, minAmp: 0.6 },
	notes: { rate: 0.6, size: 0.06 },
	beat: { period: 0.5, decay: 0.3 }, // steady thump: seconds per beat + how long the push lasts
	rest: 0.06, // bass below this leaves the cone at rest
	push: 4.5, // how far the cone pushes out per unit of bass over rest
	hitRise: 0.05, // upward jump in bass that counts as a fresh kick (fires ring/note)
	onset: { cooldown: 0.12, idlePeriod: 0.7 },
} as const;

/** Boom-box (stereo) view — a classic twin-speaker boom box. Same reactive
 * treatment as the portable radio (loudness-driven cone bounce, glow, ripple
 * rings, room waves, drifting notes, all in the theme accent), but applied to
 * BOTH round grilles at once so the whole box thumps in stereo. Motion reuses
 * the BOOMBOX constants (one tuned feel across both views); only the base art
 * and the two speaker anchors differ. Speaker coords are fractions of the drawn
 * illustration (source art 1254×1254); radii are fractions of its width. */
const STEREO = {
	speakers: [
		{ x: 0.261, y: 0.663, r: 0.128 }, // left grille (dust-cap centre)
		{ x: 0.743, y: 0.663, r: 0.128 }, // right grille
	],
} as const;

/** Per-speaker effect state so each grille runs its own rings/waves/notes
 * (the portable radio has one, the boom box has two). Loudness/onset are shared
 * across speakers — they pulse together with the music. */
interface SpeakerFx {
	rings: { born: number; amp: number }[];
	waves: { born: number; amp: number }[];
	notes: DriftNote[];
	noteTimer: number;
}

interface DriftNote {
	x: number; // offset from tip, in half-size units
	y: number;
	vx: number;
	vy: number;
	life: number;
	ttl: number;
	glyph: string;
	size: number;
}

/**
 * Canvas renderer. The bars/waveform views are fed by an AnalyserNode; the
 * radio view ignores it and animates on a clock. Motion is kept continuous —
 * the analyser's smoothing damps frame-to-frame jumps and colours never change,
 * so nothing strobes. When no analyser is available (or the source is silent,
 * e.g. internet radio that cannot be captured) the audio views show a calm
 * baseline instead of failing.
 */
export class Visualizer {
	private canvas: HTMLCanvasElement;
	private getAnalyser: () => AnalyserNode | null;
	private getPlaying: () => boolean;
	private mode: VisualizerMode = "bars";
	private raf = 0;

	// Radio view state
	private tower: HTMLImageElement | null = null;
	private towerReady = false;
	private towerCanvas: HTMLCanvasElement | null = null; // offscreen for theme tint
	// Boom-box view state (portable radio + twin-speaker boom box share this rig)
	private boombox: HTMLImageElement | null = null;
	private boomboxReady = false;
	private boomboxCanvas: HTMLCanvasElement | null = null; // offscreen for theme tint
	private stereo: HTMLImageElement | null = null;
	private stereoReady = false;
	private stereoCanvas: HTMLCanvasElement | null = null; // offscreen for theme tint
	private boomBaseline = 0; // smoothed loudness driving the cone bounce
	private beatCooldown = 0; // seconds until the next onset may fire
	private conePos = 0; // slow loudness average; onsets fire above it
	// Per-speaker rings/waves/notes (1 entry for portable radio, 2 for boom box).
	private speakerFx: SpeakerFx[] = [];
	private clock = 0; // accumulated seconds (survives stop/start)
	private lastFrame = 0; // performance.now() seconds of the previous frame
	private notes: DriftNote[] = [];
	private noteTimer = 0;
	// Smoothed per-bar heights (frequency-bars view), 0..1.
	private barLevels: number[] = new Array<number>(BAR_COUNT).fill(0);
	// Album-art bars view state
	private cover: HTMLImageElement | null = null;
	private coverReady = false;
	// Smoothed per-strip reveal heights (album-art bars view), 0..1.
	private coverLevels: number[] = new Array<number>(COVER_STRIPS).fill(0);

	constructor(
		canvas: HTMLCanvasElement,
		getAnalyser: () => AnalyserNode | null,
		getPlaying: () => boolean
	) {
		this.canvas = canvas;
		this.getAnalyser = getAnalyser;
		this.getPlaying = getPlaying;
	}

	setMode(mode: VisualizerMode): void {
		this.mode = mode;
	}

	/** Point the radio view at its base illustration (a plugin-folder resource
	 * URL). Loaded once and cached; safe to call repeatedly with the same URL. */
	setTowerImage(url: string): void {
		if (this.tower && this.tower.src === url) return;
		const img = new Image();
		img.onload = () => {
			this.towerReady = true;
		};
		img.src = url;
		this.tower = img;
		this.towerReady = img.complete && img.naturalWidth > 0;
	}

	/** Point the boom-box view at its base illustration (a plugin-folder
	 * resource URL). Loaded once and cached; safe to call repeatedly. */
	setBoomboxImage(url: string): void {
		if (this.boombox && this.boombox.src === url) return;
		const img = new Image();
		img.onload = () => {
			this.boomboxReady = true;
		};
		img.src = url;
		this.boombox = img;
		this.boomboxReady = img.complete && img.naturalWidth > 0;
	}

	/** Point the boom-box (stereo) view at its base illustration (a plugin-folder
	 * resource URL). Loaded once and cached; safe to call repeatedly. */
	setStereoImage(url: string): void {
		if (this.stereo && this.stereo.src === url) return;
		const img = new Image();
		img.onload = () => {
			this.stereoReady = true;
		};
		img.src = url;
		this.stereo = img;
		this.stereoReady = img.complete && img.naturalWidth > 0;
	}

	/** Point the album-art bars view at the current cover (a full cover-art URL),
	 * or clear it with null for a track that has no art (the view then falls back
	 * to the plain accent bars). Cached; safe to call repeatedly with the same URL.
	 * The cover is only drawn/masked, never read back, so a cross-origin cover
	 * tainting the canvas is harmless (no CORS attribute needed). */
	setCoverImage(url: string | null): void {
		if (!url) {
			this.cover = null;
			this.coverReady = false;
			return;
		}
		if (this.cover && this.cover.src === url) return;
		const img = new Image();
		img.onload = () => {
			this.coverReady = true;
		};
		img.src = url;
		this.cover = img;
		this.coverReady = img.complete && img.naturalWidth > 0;
	}

	start(): void {
		if (this.raf === 0) {
			this.lastFrame = 0; // avoid a huge dt on the first frame after a stop
			this.tick();
		}
	}

	stop(): void {
		if (this.raf !== 0) cancelAnimationFrame(this.raf);
		this.raf = 0;
	}

	private tick = (): void => {
		this.raf = requestAnimationFrame(this.tick);
		this.draw();
	};

	private draw(): void {
		const ctx = this.canvas.getContext("2d");
		if (!ctx) return;
		const dpr = window.devicePixelRatio || 1;
		const width = Math.floor(this.canvas.clientWidth * dpr);
		const height = Math.floor(this.canvas.clientHeight * dpr);
		if (width === 0 || height === 0) return;
		if (this.canvas.width !== width || this.canvas.height !== height) {
			this.canvas.width = width;
			this.canvas.height = height;
		}
		ctx.clearRect(0, 0, width, height);

		if (this.mode === "radio") {
			this.drawRadio(ctx, width, height, dpr);
			return;
		}

		if (this.mode === "boombox") {
			this.drawBoombox(ctx, width, height, dpr);
			return;
		}

		if (this.mode === "stereo") {
			this.drawStereo(ctx, width, height, dpr);
			return;
		}

		// The canvas's CSS `color` carries the theme accent.
		const color = getComputedStyle(this.canvas).color;
		const analyser = this.getAnalyser();
		if (this.mode === "bars") {
			this.drawBars(ctx, analyser, width, height, dpr, color);
		} else if (this.mode === "cover") {
			this.drawCoverBars(ctx, analyser, width, height, dpr, color);
		} else {
			this.drawWaveform(ctx, analyser, width, height, dpr, color);
		}
	}

	private drawBars(
		ctx: CanvasRenderingContext2D,
		analyser: AnalyserNode | null,
		width: number,
		height: number,
		dpr: number,
		color: string
	): void {
		const targets = this.barTargets(analyser);
		// Smooth each bar toward its target — quick to rise, gentler to fall.
		for (let i = 0; i < BAR_COUNT; i++) {
			const target = targets[i] ?? 0;
			const prev = this.barLevels[i] ?? 0;
			const rate = target > prev ? BARS_ATTACK : BARS_RELEASE;
			this.barLevels[i] = prev + (target - prev) * rate;
		}

		const gap = 2 * dpr;
		const barWidth = (width - gap * (BAR_COUNT - 1)) / BAR_COUNT;
		const minHeight = 2 * dpr;
		ctx.fillStyle = color;
		this.barLevels.forEach((level, i) => {
			const barHeight = Math.max(minHeight, level * height);
			ctx.fillRect(
				i * (barWidth + gap),
				height - barHeight,
				barWidth,
				barHeight
			);
		});
	}

	/**
	 * Map the FFT onto BAR_COUNT log-spaced frequency bands from BARS_MIN_HZ to
	 * BARS_MAX_HZ (each bar = an equal slice of octaves), take the loudest bin in
	 * each band in dBFS, and map that through the display window onto 0..1. A
	 * plain dB meter — no shaping. Silent bands map below the floor and read zero.
	 * Returns per-bar levels in 0..1; all-zero when there is no analyser.
	 */
	private barTargets(analyser: AnalyserNode | null): number[] {
		const levels = new Array<number>(BAR_COUNT).fill(0);
		if (!analyser) return levels;

		// Float dB per bin (−Infinity when silent) — the analyser's true output,
		// mapped here through our own window so the shared node keeps its defaults.
		const bins = new Float32Array(analyser.frequencyBinCount);
		analyser.getFloatFrequencyData(bins);
		const sampleRate = analyser.context.sampleRate || 48000;
		const binHz = sampleRate / analyser.fftSize; // width of one FFT bin
		const nyquist = sampleRate / 2;
		const fMax = Math.min(BARS_MAX_HZ, nyquist);
		const ratio = Math.pow(fMax / BARS_MIN_HZ, 1 / BAR_COUNT); // per-bar octave step
		const span = BARS_MAX_DB - BARS_MIN_DB;
		const last = bins.length - 1;

		for (let i = 0; i < BAR_COUNT; i++) {
			const fLo = BARS_MIN_HZ * Math.pow(ratio, i);
			const fHi = BARS_MIN_HZ * Math.pow(ratio, i + 1);
			const binLoF = fLo / binHz;
			const binHiF = fHi / binHz;

			let db: number;
			if (binHiF - binLoF >= 1) {
				// Wide band (upper frequencies span several bins): loudest bin wins.
				const binLo = Math.max(0, Math.floor(binLoF));
				const binHi = Math.min(bins.length, Math.ceil(binHiF));
				let peak = -Infinity;
				for (let b = binLo; b < binHi; b++) {
					const v = bins[b];
					if (v != null && v > peak) peak = v;
				}
				db = peak;
			} else {
				// Narrow band (low frequencies, under one bin wide): interpolate the
				// dB at the band's centre between neighbouring bins, so adjacent bars
				// get distinct values instead of all snapping to one bin (plateaus).
				const center = Math.sqrt(fLo * fHi) / binHz;
				const lo = Math.max(0, Math.min(last, Math.floor(center)));
				const hi = Math.min(last, lo + 1);
				const t = center - lo;
				// Floor each end so a silent (−Infinity) bin can't poison the lerp.
				const a = Math.max(BARS_MIN_DB, bins[lo] ?? BARS_MIN_DB);
				const b = Math.max(BARS_MIN_DB, bins[hi] ?? BARS_MIN_DB);
				db = a + (b - a) * t;
			}
			levels[i] = Math.max(0, Math.min(1, (db - BARS_MIN_DB) / span));
		}
		return levels;
	}

	/**
	 * Album-art bars: the same octave-band levels as the frequency bars, but each
	 * strip is a vertical slice of the current cover masked to its band height,
	 * revealing the art bottom-up. A faint full-cover ghost sits underneath so it
	 * always reads as one image. With no cover (loading / no art) it falls back to
	 * the plain accent bars. Paused/stopped reveals the whole cover (strips → 1)
	 * so a still track shows its art, like the album-art view.
	 */
	private drawCoverBars(
		ctx: CanvasRenderingContext2D,
		analyser: AnalyserNode | null,
		width: number,
		height: number,
		dpr: number,
		color: string
	): void {
		if (!this.coverReady || !this.cover) {
			this.drawBars(ctx, analyser, width, height, dpr, color);
			return;
		}
		const iw = this.cover.naturalWidth || width;
		const ih = this.cover.naturalHeight || height;

		// Faint ghost of the whole cover so the art is always legible and the
		// strips light it to full brightness.
		if (COVER_GHOST > 0) {
			ctx.save();
			ctx.globalAlpha = COVER_GHOST;
			ctx.drawImage(this.cover, 0, 0, iw, ih, 0, 0, width, height);
			ctx.restore();
		}

		// Per-strip targets aggregate the log-frequency bands under each strip, so
		// the left of the cover reacts to bass and the right to treble. Paused ⇒
		// reveal the whole cover.
		const bands = this.barTargets(analyser);
		const playing = this.getPlaying();
		for (let s = 0; s < COVER_STRIPS; s++) {
			let target: number;
			if (!playing) {
				target = 1;
			} else {
				const lo = Math.floor((s * BAR_COUNT) / COVER_STRIPS);
				const hi = Math.max(lo + 1, Math.floor(((s + 1) * BAR_COUNT) / COVER_STRIPS));
				let sum = 0;
				let n = 0;
				for (let b = lo; b < hi && b < BAR_COUNT; b++) {
					sum += bands[b] ?? 0;
					n++;
				}
				target = n > 0 ? sum / n : 0;
			}
			const prev = this.coverLevels[s] ?? 0;
			const rate = target > prev ? BARS_ATTACK : BARS_RELEASE;
			this.coverLevels[s] = prev + (target - prev) * rate;
		}

		// Draw each strip flush against the next (integer pixel edges so no seams),
		// masked bottom-up to its current level.
		for (let s = 0; s < COVER_STRIPS; s++) {
			const level = this.coverLevels[s] ?? 0;
			if (level <= 0) continue;
			const dx0 = Math.floor((s * width) / COVER_STRIPS);
			const dx1 = Math.floor(((s + 1) * width) / COVER_STRIPS);
			const dw = dx1 - dx0;
			const sx0 = Math.floor((s * iw) / COVER_STRIPS);
			const sx1 = Math.floor(((s + 1) * iw) / COVER_STRIPS);
			const sw = sx1 - sx0;
			if (dw <= 0 || sw <= 0) continue;
			const dh = level * height;
			const sh = level * ih;
			ctx.drawImage(this.cover, sx0, ih - sh, sw, sh, dx0, height - dh, dw, dh);
			if (COVER_PEAK_CAPS) {
				ctx.fillStyle = color;
				ctx.fillRect(dx0, height - dh, dw, Math.max(1, dpr));
			}
		}
	}

	private drawWaveform(
		ctx: CanvasRenderingContext2D,
		analyser: AnalyserNode | null,
		width: number,
		height: number,
		dpr: number,
		color: string
	): void {
		ctx.strokeStyle = color;
		ctx.lineWidth = 2 * dpr;
		ctx.lineJoin = "round";
		ctx.beginPath();
		if (!analyser) {
			ctx.moveTo(0, height / 2);
			ctx.lineTo(width, height / 2);
			ctx.stroke();
			return;
		}
		const samples = new Uint8Array(analyser.fftSize);
		analyser.getByteTimeDomainData(samples);
		for (let i = 0; i < samples.length; i++) {
			const x = (i / (samples.length - 1)) * width;
			const y = ((samples[i] ?? 128) / 255) * height;
			if (i === 0) ctx.moveTo(x, y);
			else ctx.lineTo(x, y);
		}
		ctx.stroke();
	}

	private drawRadio(
		ctx: CanvasRenderingContext2D,
		width: number,
		height: number,
		dpr: number
	): void {
		// advance the clock
		const now = performance.now() / 1000;
		const dt = this.lastFrame ? Math.min(0.05, now - this.lastFrame) : 0;
		this.lastFrame = now;
		this.clock += dt;

		// Theme colours: the tower linework takes --text-normal (carried on the
		// canvas via CSS), the broadcast rings/glow/notes take the accent (the
		// canvas `color`), so the whole view follows the Obsidian theme live.
		const style = getComputedStyle(this.canvas);
		const accent = parseColor(style.color) ?? hexToRgb(RADIO.color);
		const towerColor =
			style.getPropertyValue("--text-normal").trim() || style.color;

		// base illustration, contain-fit, centred, tinted to the theme text colour
		if (this.towerReady && this.tower) {
			this.towerCanvas ??= document.createElement("canvas");
			this.drawTintedContain(
				ctx,
				this.tower,
				this.towerCanvas,
				width,
				height,
				towerColor,
				1254,
				1254
			);
		}

		const cx = RADIO.tip.x * width;
		const cy = RADIO.tip.y * height;
		const half = Math.min(width, height) / 2;
		const rgb = accent;

		// broadcast rings: born at the tip, expand outward, fade
		for (let i = 0; i < RADIO.ringCount; i++) {
			const p = frac(this.clock * RADIO.speed + i / RADIO.ringCount);
			const r =
				(RADIO.startRadius + (RADIO.maxRadius - RADIO.startRadius) * easeOut(p)) *
				half;
			let a = p < 0.12 ? p / 0.12 : 1 - (p - 0.12) / 0.88;
			a = Math.max(0, a) * RADIO.opacity;
			if (a <= 0.01 || r <= 0) continue;
			ctx.beginPath();
			ctx.arc(cx, cy, r, 0, Math.PI * 2);
			ctx.lineWidth = RADIO.thickness * dpr;
			ctx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${a.toFixed(3)})`;
			ctx.stroke();
		}

		// beacon glow at the antenna tip
		const gp = 0.5 + 0.5 * Math.sin(this.clock * Math.PI * 1.4);
		const gr = (0.02 + 0.05 * gp) * half;
		const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, gr * 3);
		glow.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},${(0.55 * gp).toFixed(3)})`);
		glow.addColorStop(1, `rgba(${rgb.r},${rgb.g},${rgb.b},0)`);
		ctx.fillStyle = glow;
		ctx.beginPath();
		ctx.arc(cx, cy, gr * 3, 0, Math.PI * 2);
		ctx.fill();

		// drifting notes
		this.noteTimer += dt;
		if (this.noteTimer > 0.6) {
			this.noteTimer = 0;
			this.notes.push({
				x: (Math.random() - 0.5) * 0.5,
				y: 0,
				vx: (Math.random() - 0.5) * 0.12,
				vy: -(0.12 + Math.random() * 0.08),
				life: 0,
				ttl: 2.2 + Math.random() * 1.2,
				glyph: Math.random() < 0.5 ? "♪" : "♫",
				size: 0.05 + Math.random() * 0.03,
			});
		}
		const note = rgb; // drifting notes ride the accent, like the rings
		for (let n = this.notes.length - 1; n >= 0; n--) {
			const no = this.notes[n]!;
			no.life += dt;
			no.x += no.vx * dt;
			no.y += no.vy * dt;
			if (no.life > no.ttl) {
				this.notes.splice(n, 1);
				continue;
			}
			const lp = no.life / no.ttl;
			const na = (lp < 0.2 ? lp / 0.2 : 1 - (lp - 0.2) / 0.8) * 0.8;
			ctx.font = `${Math.round(no.size * half * 2)}px serif`;
			ctx.fillStyle = `rgba(${note.r},${note.g},${note.b},${Math.max(0, na).toFixed(3)})`;
			ctx.fillText(no.glyph, cx + no.x * half, cy + no.y * half);
		}
	}

	/**
	 * Draw an illustration contain-fit and centred, recoloured to `color` via an
	 * offscreen `source-in` fill (so line art follows the theme). Returns the
	 * drawn rectangle in canvas pixels, or null if the offscreen context failed
	 * — callers overlay effects (e.g. the boom-box grille) onto that rect.
	 */
	private drawTintedContain(
		ctx: CanvasRenderingContext2D,
		img: HTMLImageElement,
		off: HTMLCanvasElement,
		width: number,
		height: number,
		color: string,
		fallbackW: number,
		fallbackH: number
	): { dx: number; dy: number; dw: number; dh: number } | null {
		const iw = img.naturalWidth || fallbackW;
		const ih = img.naturalHeight || fallbackH;
		const scale = Math.min(width / iw, height / ih);
		const dw = iw * scale;
		const dh = ih * scale;
		const dx = (width - dw) / 2;
		const dy = (height - dh) / 2;
		if (off.width !== width || off.height !== height) {
			off.width = width;
			off.height = height;
		}
		const octx = off.getContext("2d");
		if (!octx) return null;
		octx.clearRect(0, 0, width, height);
		octx.drawImage(img, dx, dy, dw, dh);
		octx.globalCompositeOperation = "source-in"; // recolour the linework
		octx.fillStyle = color;
		octx.fillRect(0, 0, width, height);
		octx.globalCompositeOperation = "source-over";
		ctx.drawImage(off, 0, 0);
		return { dx, dy, dw, dh };
	}

	/** Portable radio — one round grille reacting to the music. */
	private drawBoombox(
		ctx: CanvasRenderingContext2D,
		width: number,
		height: number,
		dpr: number
	): void {
		this.boomboxCanvas ??= document.createElement("canvas");
		this.drawBoomboxLike(
			ctx,
			width,
			height,
			dpr,
			this.boombox,
			this.boomboxReady,
			this.boomboxCanvas,
			[BOOMBOX.speaker],
			1448,
			1086
		);
	}

	/** Twin-speaker boom box — both grilles react to the music at once. */
	private drawStereo(
		ctx: CanvasRenderingContext2D,
		width: number,
		height: number,
		dpr: number
	): void {
		this.stereoCanvas ??= document.createElement("canvas");
		this.drawBoomboxLike(
			ctx,
			width,
			height,
			dpr,
			this.stereo,
			this.stereoReady,
			this.stereoCanvas,
			STEREO.speakers,
			1254,
			1254
		);
	}

	/**
	 * Shared engine behind both boom-box views. Tints the base illustration to the
	 * theme, measures overall loudness once, derives a single cone displacement +
	 * onset from it, then paints that same reaction onto every speaker in
	 * `speakers` (one for the portable radio, two for the boom box). Loudness =
	 * RMS of the time-domain waveform (robust, forgiving); no analyser or silence
	 * leaves the grilles at rest.
	 */
	private drawBoomboxLike(
		ctx: CanvasRenderingContext2D,
		width: number,
		height: number,
		dpr: number,
		img: HTMLImageElement | null,
		ready: boolean,
		off: HTMLCanvasElement,
		speakers: readonly { x: number; y: number; r: number }[],
		fallbackW: number,
		fallbackH: number
	): void {
		// advance the shared clock
		const now = performance.now() / 1000;
		const dt = this.lastFrame ? Math.min(0.05, now - this.lastFrame) : 0;
		this.lastFrame = now;
		this.clock += dt;

		// Theme colours: the body takes --text-normal, the grille glow takes the
		// accent — same scheme as the tower, so every illustration view matches.
		const style = getComputedStyle(this.canvas);
		const accent = parseColor(style.color) ?? hexToRgb(RADIO.color);
		const bodyColor =
			style.getPropertyValue("--text-normal").trim() || style.color;

		if (!ready || !img) return;
		const rect = this.drawTintedContain(
			ctx,
			img,
			off,
			width,
			height,
			bodyColor,
			fallbackW,
			fallbackH
		);
		if (!rect) return;

		// Overall loudness drives the bounce — the classic bouncing-speaker: the
		// grille pushes out with how loud the music is and settles as it quiets.
		const analyser = this.getAnalyser();
		let loud = 0;
		if (analyser) {
			const wave = new Uint8Array(analyser.fftSize);
			analyser.getByteTimeDomainData(wave);
			let sum = 0;
			for (let i = 0; i < wave.length; i++) {
				const v = ((wave[i] ?? 128) - 128) / 128; // -1..1 around silence
				sum += v * v;
			}
			loud = Math.sqrt(sum / wave.length); // 0..~1 RMS amplitude
		}
		// Light smoothing so the bounce is springy, not jittery (boomBaseline reused
		// as the smoothed level). Map loudness over a rest floor to how far it pushes.
		this.boomBaseline += (loud - this.boomBaseline) * Math.min(1, dt * 14);
		const level = this.boomBaseline;
		const disp = Math.min(1, Math.max(0, level - BOOMBOX.rest) * BOOMBOX.push);
		const amp = disp;
		const bright = Math.min(1, disp * BOOMBOX.cone.dispGain);

		// Ring on the louder swells — a forgiving relative rise over a slow average
		// (conePos reused as that average), not a narrow-band kick gate. One onset
		// per frame, shared so both speakers fire together (in stereo).
		this.beatCooldown -= dt;
		let onset = false;
		const slow = this.conePos;
		this.conePos += (level - this.conePos) * Math.min(1, dt * 3);
		if (
			analyser &&
			level > BOOMBOX.rest &&
			level - slow > BOOMBOX.hitRise &&
			this.beatCooldown <= 0
		) {
			onset = true;
			this.beatCooldown = BOOMBOX.onset.cooldown;
		}

		const list = speakers;
		// Give each grille its own rings/waves/notes state.
		while (this.speakerFx.length < list.length) {
			this.speakerFx.push({ rings: [], waves: [], notes: [], noteTimer: 0 });
		}
		const half = Math.min(width, height) / 2;
		list.forEach((sp, i) => {
			const sx = rect.dx + sp.x * rect.dw;
			const sy = rect.dy + sp.y * rect.dh;
			const sr = sp.r * rect.dw;
			this.drawSpeaker(
				ctx,
				dpr,
				half,
				accent,
				sx,
				sy,
				sr,
				disp,
				bright,
				amp,
				onset,
				dt,
				this.speakerFx[i]!
			);
		});
	}

	/** Paint one reacting grille: room waves, cone bloom, membrane rim, ripple
	 * rings, and drifting notes — all in the accent, driven by the shared cone
	 * displacement/onset computed in drawBoomboxLike. */
	private drawSpeaker(
		ctx: CanvasRenderingContext2D,
		dpr: number,
		half: number,
		rgb: { r: number; g: number; b: number },
		sx: number,
		sy: number,
		sr: number,
		disp: number,
		bright: number,
		amp: number,
		onset: boolean,
		dt: number,
		fx: SpeakerFx
	): void {
		if (onset) {
			fx.rings.push({ born: this.clock, amp });
			// only the bigger thumps throw a room wave, so it stays tight
			if (amp > BOOMBOX.waves.minAmp) {
				fx.waves.push({ born: this.clock, amp });
			}
			this.spawnNote(fx.notes);
		}

		// outward room waves (behind the rings) — subtle, radiating past the box
		for (let i = fx.waves.length - 1; i >= 0; i--) {
			const wv = fx.waves[i]!;
			const p = (this.clock - wv.born) / BOOMBOX.waves.life;
			if (p >= 1) {
				fx.waves.splice(i, 1);
				continue;
			}
			const wr = sr * (1 + (BOOMBOX.waves.maxR - 1) * easeOut(p));
			const wa = (1 - p) * BOOMBOX.waves.opacity * wv.amp;
			ctx.beginPath();
			ctx.arc(sx, sy, wr, 0, Math.PI * 2);
			ctx.lineWidth = BOOMBOX.waves.thickness * dpr;
			ctx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${wa.toFixed(3)})`;
			ctx.stroke();
		}

		// cone thump: a bright bloom from the grille centre on the kick, clipped to
		// the mesh; nearly dark at rest
		ctx.save();
		ctx.beginPath();
		ctx.arc(sx, sy, sr, 0, Math.PI * 2);
		ctx.clip();
		const gr = sr * (0.45 + 1.2 * bright);
		const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, gr);
		glow.addColorStop(
			0,
			`rgba(${rgb.r},${rgb.g},${rgb.b},${(BOOMBOX.cone.restGlow + 0.9 * bright).toFixed(3)})`
		);
		glow.addColorStop(1, `rgba(${rgb.r},${rgb.g},${rgb.b},0)`);
		ctx.fillStyle = glow;
		ctx.fillRect(sx - sr, sy - sr, sr * 2, sr * 2);
		ctx.restore();

		// membrane rim physically pushes out and pulls back with the cone
		const rimR = sr * (0.95 + 0.14 * disp);
		ctx.beginPath();
		ctx.arc(sx, sy, rimR, 0, Math.PI * 2);
		ctx.lineWidth = Math.max(1, 2 * dpr);
		ctx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${(0.1 + 0.7 * bright).toFixed(3)})`;
		ctx.stroke();

		// ripple rings launched on each bass hit — the "bounce"
		for (let j = fx.rings.length - 1; j >= 0; j--) {
			const ring = fx.rings[j]!;
			const rp = (this.clock - ring.born) / BOOMBOX.rings.life;
			if (rp >= 1) {
				fx.rings.splice(j, 1);
				continue;
			}
			const rr =
				sr *
				(BOOMBOX.rings.startR +
					(BOOMBOX.rings.maxR - BOOMBOX.rings.startR) * easeOut(rp));
			let ra = rp < 0.1 ? rp / 0.1 : 1 - (rp - 0.1) / 0.9;
			ra = Math.max(0, ra) * BOOMBOX.rings.opacity * ring.amp;
			ctx.beginPath();
			ctx.arc(sx, sy, rr, 0, Math.PI * 2);
			ctx.lineWidth = BOOMBOX.rings.thickness * dpr;
			ctx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${ra.toFixed(3)})`;
			ctx.stroke();
		}

		// floating notes drift up off the grille (steady rate + on each hit)
		fx.noteTimer += dt;
		if (BOOMBOX.notes.rate > 0 && fx.noteTimer > 1 / BOOMBOX.notes.rate) {
			fx.noteTimer = 0;
			this.spawnNote(fx.notes);
		}
		for (let n = fx.notes.length - 1; n >= 0; n--) {
			const no = fx.notes[n]!;
			no.life += dt;
			no.x += no.vx * dt;
			no.y += no.vy * dt;
			if (no.life > no.ttl) {
				fx.notes.splice(n, 1);
				continue;
			}
			const lp = no.life / no.ttl;
			const na = (lp < 0.2 ? lp / 0.2 : 1 - (lp - 0.2) / 0.8) * 0.85;
			ctx.font = `${Math.round(no.size * half * 2)}px serif`;
			ctx.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${Math.max(0, na).toFixed(3)})`;
			ctx.fillText(no.glyph, sx + no.x * half, sy + no.y * half);
		}
	}

	private spawnNote(notes: DriftNote[]): void {
		notes.push({
			x: (Math.random() - 0.5) * 0.4,
			y: 0,
			vx: (Math.random() - 0.5) * 0.14,
			vy: -(0.14 + Math.random() * 0.08),
			life: 0,
			ttl: 2.0 + Math.random() * 1.2,
			glyph: Math.random() < 0.5 ? "♪" : "♫",
			size: BOOMBOX.notes.size * (0.85 + Math.random() * 0.4),
		});
	}
}

function frac(x: number): number {
	return x - Math.floor(x);
}

function easeOut(p: number): number {
	return 1 - (1 - p) * (1 - p);
}

/** Parse a CSS colour string into rgb. Handles the `rgb()`/`rgba()` form that
 * getComputedStyle returns, and falls back to hex. Returns null if unparseable. */
function parseColor(input: string): { r: number; g: number; b: number } | null {
	const s = input.trim();
	const m = s.match(/rgba?\(([^)]+)\)/i);
	if (m) {
		const parts = m[1]!.split(",").map((v) => parseFloat(v));
		if (parts.length >= 3) {
			return { r: parts[0]!, g: parts[1]!, b: parts[2]! };
		}
	}
	if (s.startsWith("#")) return hexToRgb(s);
	return null;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
	let h = hex.replace("#", "");
	if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
	const num = parseInt(h, 16);
	return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}
