/**
 * Length-prefixed JSON frames shared by the resident PowerShell 5.1 host and
 * its clients.
 *
 * Wire format: uint32 little-endian payload length, then the UTF-8 JSON body.
 * The host emits the same shape on its stdout pipe, so one decoder serves both
 * the socket hop and the child-process hop.
 */

/** Refuse absurd frames instead of allocating them. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

const HEADER_BYTES = 4;

/**
 * Serialize one value as a frame.
 * @param {unknown} value JSON-serializable payload
 * @returns {Buffer}
 */
export function encodeFrame(value) {
	const body = Buffer.from(JSON.stringify(value), 'utf8');
	if (body.length > MAX_FRAME_BYTES) {
		throw new RangeError('frame body of ' + body.length + ' bytes exceeds the ' + MAX_FRAME_BYTES + ' byte limit');
	}
	const frame = Buffer.allocUnsafe(HEADER_BYTES + body.length);
	frame.writeUInt32LE(body.length, 0);
	body.copy(frame, HEADER_BYTES);
	return frame;
}

/**
 * Incremental decoder: feed it whatever arrived from the socket or pipe and it
 * returns every frame that is now complete. Partial frames stay buffered.
 */
export class FrameDecoder {
	constructor() {
		this.buffer = Buffer.alloc(0);
	}

	/**
	 * @param {Buffer} chunk
	 * @returns {unknown[]} complete frames, in arrival order
	 */
	push(chunk) {
		this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
		const frames = [];
		while (this.buffer.length >= HEADER_BYTES) {
			const length = this.buffer.readUInt32LE(0);
			if (length > MAX_FRAME_BYTES) {
				throw new RangeError('frame body of ' + length + ' bytes exceeds the ' + MAX_FRAME_BYTES + ' byte limit');
			}
			if (this.buffer.length < HEADER_BYTES + length) break;
			const body = this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + length);
			this.buffer = this.buffer.subarray(HEADER_BYTES + length);
			frames.push(JSON.parse(body.toString('utf8')));
		}
		return frames;
	}

	/** Bytes of an incomplete frame still waiting for more input. */
	get pendingBytes() {
		return this.buffer.length;
	}
}
