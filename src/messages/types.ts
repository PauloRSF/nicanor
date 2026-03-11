import type { Logger } from "../_lib/logger.js";

export type Context = {
	userId: string;
	logger: Logger;
	sticker?: Buffer;
	image?: Buffer;
	gif?: Buffer;
	video?: Buffer;
	sendText: (text: string) => Promise<void>;
	sendSticker: (bytes: Buffer) => Promise<void>;
};
