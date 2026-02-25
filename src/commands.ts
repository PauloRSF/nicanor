import type { WASocket } from "baileys";
import fs from "fs";
import {
  addTags,
  deleteSticker,
  getLastSticker,
  getTagsForSticker,
  searchByTags,
} from "./db/index.js";

const HELP_TEXT = `*Sticker Search Bot*

!tag (!t) tag1 tag2 ... — Tag the last sticker you sent
!search (!s) tag1 tag2 ... — Search by tags, best matches first
!tags (!ts) — List tags on the last sticker you sent
!delete (!d) — Delete the last sticker you sent
!help (!h) — Show this message`;

async function reply(sock: WASocket, jid: string, text: string): Promise<void> {
  await sock.sendMessage(jid, { text });
}

export async function handleCommand(
  sock: WASocket,
  jid: string,
  text: string
): Promise<void> {
  const trimmed = text.trim();
  const spaceIdx = trimmed.indexOf(" ");
  const command = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  switch (command) {
    case "!tag":
    case "!t":
      await handleTag(sock, jid, args);
      break;
    case "!search":
    case "!s":
      await handleSearch(sock, jid, args);
      break;
    case "!tags":
    case "!ts":
      await handleTags(sock, jid);
      break;
    case "!delete":
    case "!d":
      await handleDelete(sock, jid);
      break;
    case "!help":
    case "!h":
      await reply(sock, jid, HELP_TEXT);
      break;
    default:
      break;
  }
}

async function handleTag(
  sock: WASocket,
  jid: string,
  args: string
): Promise<void> {
  if (!args) {
    await reply(sock, jid, "Usage: !tag tag1 tag2 ...");
    return;
  }

  const sticker = getLastSticker(jid);
  if (!sticker) {
    await reply(sock, jid, "No sticker found. Send a sticker first, then tag it.");
    return;
  }

  const tags = args
    .split(/[\s,]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  if (tags.length === 0) {
    await reply(sock, jid, "Please provide at least one tag.");
    return;
  }

  addTags(sticker.id, tags);
  await reply(sock, jid, `Sticker tagged with: ${tags.join(", ")}`);
}

async function handleSearch(
  sock: WASocket,
  jid: string,
  args: string
): Promise<void> {
  if (!args) {
    await reply(sock, jid, "Usage: !search tag1 tag2 ...");
    return;
  }

  const queryTags = args
    .split(/[\s,]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  if (queryTags.length === 0) {
    await reply(sock, jid, "Please provide at least one search tag.");
    return;
  }

  const results = searchByTags(queryTags);
  if (results.length === 0) {
    await reply(sock, jid, `No stickers found for "${queryTags.join(", ")}".`);
    return;
  }

  await reply(
    sock,
    jid,
    `Found ${results.length} sticker(s) for "${queryTags.join(", ")}":`
  );

  let missing = 0;
  for (const sticker of results) {
    if (!fs.existsSync(sticker.file_path)) {
      missing++;
      continue;
    }
    try {
      const buffer = fs.readFileSync(sticker.file_path);
      await sock.sendMessage(jid, { sticker: buffer });
    } catch {
      console.error(`Failed to send sticker ${sticker.file_path}`);
    }
  }
  if (missing > 0) {
    await reply(
      sock,
      jid,
      `${missing} sticker(s) had missing files. Send them again so I can re-save them.`
    );
  }
}

async function handleTags(sock: WASocket, jid: string): Promise<void> {
  const sticker = getLastSticker(jid);
  if (!sticker) {
    await reply(sock, jid, "No sticker found. Send a sticker first.");
    return;
  }

  const tags = getTagsForSticker(sticker.id);
  if (tags.length === 0) {
    await reply(sock, jid, "This sticker has no tags yet. Use !tag to add some.");
    return;
  }

  await reply(sock, jid, `Tags: ${tags.join(", ")}`);
}

async function handleDelete(sock: WASocket, jid: string): Promise<void> {
  const sticker = getLastSticker(jid);
  if (!sticker) {
    await reply(sock, jid, "No sticker found to delete.");
    return;
  }

  deleteSticker(sticker.id);
  await reply(sock, jid, "Sticker and its tags have been deleted.");
}
