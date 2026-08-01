/**
 * MD5 (RFC 1321), used for Subsonic token auth (`t = md5(password + salt)`).
 * Implemented locally so the client needs no node builtin — the constants are
 * derived (K from sin, per the RFC) rather than transcribed, and the whole
 * thing is verified against the RFC test vectors in the build pipeline.
 */

/** Per-round left-rotate amounts, four rounds of four repeating values. */
const S = [
	7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20,
	5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4,
	11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6,
	10, 15, 21,
];

/** K[i] = floor(|sin(i + 1)| * 2^32) — the RFC's own construction. */
const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) {
	K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
}

/** MD5 of a string (UTF-8 encoded), as lowercase hex. */
export function md5Hex(input: string): string {
	const data = new TextEncoder().encode(input);

	// Pad to 56 mod 64, then append the bit length as a 64-bit LE integer.
	const padded = new Uint8Array((((data.length + 8) >> 6) << 6) + 64);
	padded.set(data);
	padded[data.length] = 0x80;
	const view = new DataView(padded.buffer);
	const bitLen = data.length * 8;
	view.setUint32(padded.length - 8, bitLen >>> 0, true);
	view.setUint32(padded.length - 4, Math.floor(bitLen / 4294967296), true);

	let a0 = 0x67452301;
	let b0 = 0xefcdab89;
	let c0 = 0x98badcfe;
	let d0 = 0x10325476;

	const m = new Uint32Array(16);
	for (let off = 0; off < padded.length; off += 64) {
		for (let i = 0; i < 16; i++) m[i] = view.getUint32(off + i * 4, true);
		let a = a0;
		let b = b0;
		let c = c0;
		let d = d0;
		for (let i = 0; i < 64; i++) {
			let f: number;
			let g: number;
			if (i < 16) {
				f = (b & c) | (~b & d);
				g = i;
			} else if (i < 32) {
				f = (d & b) | (~d & c);
				g = (5 * i + 1) % 16;
			} else if (i < 48) {
				f = b ^ c ^ d;
				g = (3 * i + 5) % 16;
			} else {
				f = c ^ (b | ~d);
				g = (7 * i) % 16;
			}
			// i is always in [0, 64) and g in [0, 16), so the lookups can't miss.
			const rot = S[i] as number;
			f = (f + a + (K[i] as number) + (m[g] as number)) | 0;
			a = d;
			d = c;
			c = b;
			b = (b + ((f << rot) | (f >>> (32 - rot)))) | 0;
		}
		a0 = (a0 + a) | 0;
		b0 = (b0 + b) | 0;
		c0 = (c0 + c) | 0;
		d0 = (d0 + d) | 0;
	}

	const out = new DataView(new ArrayBuffer(16));
	out.setUint32(0, a0, true);
	out.setUint32(4, b0, true);
	out.setUint32(8, c0, true);
	out.setUint32(12, d0, true);
	return [...new Uint8Array(out.buffer)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
