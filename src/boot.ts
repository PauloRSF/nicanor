import { logger } from "./_lib/logger.js";
import * as database from "./db/index.js";
import * as messageHandler from "./messages/index.js";
import { StickerStorage } from "./sticker/index.js";

async function start(): Promise<void> {
	database.init();

	await StickerStorage.setup();

	await messageHandler.init();
}

function gracefulShutdown(): void {
	logger.info("Shutting down...");

	messageHandler.shutdown();
	database.shutdown();

	process.exit(0);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

start().catch((err) => {
	logger.error(err, "Failed to boot application");

	process.exit(1);
});
