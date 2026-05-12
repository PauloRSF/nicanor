import { logger } from "./_lib/logger.js";
import * as database from "./db/index.js";
import { gifConversionWorkerPool } from "./gifs/pool.js";
import * as messageHandler from "./messages/index.js";
import { StickerStorage } from "./sticker/index.js";

async function start(): Promise<void> {
  await database.init();

  await StickerStorage.setup();

  await messageHandler.init();

  await gifConversionWorkerPool.init();
}

async function gracefulShutdown(): Promise<void> {
  logger.info("Shutting down...");

  messageHandler.shutdown();

  await gifConversionWorkerPool.shutdown();

  process.exit(0);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

start().catch((err) => {
  logger.error(err, "Failed to boot application");

  process.exit(1);
});
