import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { ffmpegPath } from "../../_lib/ffmpeg.js";
import { ytDlpPath } from "../../_lib/yt-dlp.js";
import type { SocialPlatform } from "../detect.js";
import { DownloadFailedError, SocialDownloadError, VideoTooLargeError } from "../errors.js";

const execFileAsync = promisify(execFile);

const YTDLP_TIMEOUT_MS = 90_000;

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

export type YtDlpDownloadResult = {
	bytes: Buffer;
	mediaType: "video" | "image";
};

type DownloadWithYtDlpParams = {
	url: string;
	platform: SocialPlatform;
	maxBytes: number;
	/** 1-based playlist / carousel item (Instagram `img_index`) */
	playlistItem?: number;
};

function mediaTypeFromFilename(name: string): "video" | "image" {
	const ext = name.split(".").pop()?.toLowerCase() ?? "";
	return IMAGE_EXTENSIONS.has(ext) ? "image" : "video";
}

export async function downloadWithYtDlp({
	url,
	platform,
	maxBytes,
	playlistItem,
}: DownloadWithYtDlpParams): Promise<YtDlpDownloadResult> {
	const workDir = await mkdtemp(join(tmpdir(), "nicanor-ytdlp-"));
	const outputTemplate = join(workDir, "media.%(ext)s");

	const args = [
		"--no-warnings",
		"--ffmpeg-location",
		ffmpegPath,
		"--merge-output-format",
		"mp4",
		"-S",
		"vcodec:h264,ext:mp4:m4a",
		"--max-filesize",
		String(maxBytes),
		"-o",
		outputTemplate,
	];

	if (playlistItem !== undefined) {
		// Instagram carousels are playlists; -I selects the slide (do not pass --no-playlist).
		args.push("-I", String(playlistItem));
	} else {
		args.push("--no-playlist");
	}

	if (platform === "tiktok") {
		// TikTok's "download" format is watermarked; h264_* play formats usually have no format_note,
		// so filtering on format_note rejects them. Prefer any non-download format under the size cap.
		args.push("-f", `best[format_id!^=download][filesize<${maxBytes}]/best[format_id!^=download]/best`);
	}

	const cookiesFile = process.env.NICANOR_YTDLP_COOKIES_FILE?.trim();
	if (cookiesFile) {
		args.push("--cookies", cookiesFile);
	}

	args.push(url);

	try {
		await execFileAsync(ytDlpPath, args, {
			timeout: YTDLP_TIMEOUT_MS,
			maxBuffer: 10 * 1024 * 1024,
		});

		const files = await readdir(workDir);
		const mediaFile = files.find((name) => name.startsWith("media."));

		if (!mediaFile) {
			throw new DownloadFailedError("yt-dlp produced no output");
		}

		const bytes = await readFile(join(workDir, mediaFile));

		if (bytes.length === 0) {
			throw new DownloadFailedError("yt-dlp produced empty file");
		}

		if (bytes.length > maxBytes) {
			throw new VideoTooLargeError(maxBytes);
		}

		return { bytes, mediaType: mediaTypeFromFilename(mediaFile) };
	} catch (error) {
		if (error instanceof SocialDownloadError) {
			throw error;
		}

		const message = error instanceof Error ? error.message : String(error);
		throw new DownloadFailedError(`yt-dlp failed: ${message}`);
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
}
