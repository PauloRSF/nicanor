import { downloadContentFromMessage, proto } from "baileys";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";

const STICKERS_DIR = path.resolve("stickers");

export interface SavedSticker {
  filePath: string;
  fileHash: string;
}

function ensureStickersDir(): void {
  if (!fs.existsSync(STICKERS_DIR)) {
    fs.mkdirSync(STICKERS_DIR, { recursive: true });
  }
}

/**
 * Downloads a sticker from a WhatsApp message, hashes it, and saves to disk.
 * Returns the file path and SHA-256 hash. Skips writing if the file already exists.
 */
export async function downloadAndSaveSticker(
  stickerMessage: proto.Message.IStickerMessage
): Promise<SavedSticker> {
  ensureStickersDir();

  const stream = await downloadContentFromMessage(stickerMessage, "sticker");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  const buffer = Buffer.concat(chunks);

  const fileHash = createHash("sha256").update(buffer).digest("hex");
  const filePath = path.join(STICKERS_DIR, `${fileHash}.webp`);

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, buffer);
  }

  return { filePath, fileHash };
}

export async function downloadSticker(stickerMessage: proto.Message.IStickerMessage): Promise<Buffer> {
  const stream = await downloadContentFromMessage(stickerMessage, "sticker");
  
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  
  return Buffer.concat(chunks);
}
