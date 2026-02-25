import crypto from "crypto";
import path from "path";
import fs from "fs/promises";

const STICKERS_DIR = path.resolve("stickers");

type UnsavedStickerConstructorOptions = {
  userId: string;
  data: Buffer;
};

export class UnsavedSticker {
  private userId: string;
  private data: Buffer;

  constructor(options: UnsavedStickerConstructorOptions) {
    this.userId = options.userId;
    this.data = options.data;
  }

  async save(): Promise<Sticker> {
    const stickerFilePath = path.join(STICKERS_DIR, this.userId, `${this.hash}.webp`);

    if (!(await fs.stat(stickerFilePath)).isFile()) {
      await fs.writeFile(stickerFilePath, this.data);
    }

    return new Sticker({ userId: this.userId, path: stickerFilePath });
  }

  get hash(): string {
    return crypto.createHash("sha256").update(this.data).digest("hex");
  }
}

type StickerConstructorOptions = {
  userId: string;
  path: string;
};

export class Sticker {
  private userId: string;
  private path: string;

  constructor(options: StickerConstructorOptions) {
    this.userId = options.userId;
    this.path = options.path;
  }

  async getByHash(hash: string): Promise<Sticker | null> {
    const stickerFilePath = path.join(STICKERS_DIR, this.userId, `${hash}.webp`);

    if (!(await fs.stat(stickerFilePath)).isFile()) return null;
 
    return new Sticker({ userId: this.userId, path: stickerFilePath });
  }
} 
