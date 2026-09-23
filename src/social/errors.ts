import type { SocialPlatform } from "./detect.js";

export class SocialDownloadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SocialDownloadError";
	}
}

export class UnsupportedUrlError extends SocialDownloadError {
	constructor(message = "Unsupported URL") {
		super(message);
		this.name = "UnsupportedUrlError";
	}
}

export class InvalidUrlError extends SocialDownloadError {
	constructor(
		readonly platform: SocialPlatform,
		message?: string,
	) {
		super(message ?? `Invalid ${platform} URL`);
		this.name = "InvalidUrlError";
	}
}

export class MediaNotFoundError extends SocialDownloadError {
	constructor(message = "No video found") {
		super(message);
		this.name = "MediaNotFoundError";
	}
}

export class MediaIndexOutOfRangeError extends SocialDownloadError {
	constructor(readonly mediaIndex: number) {
		super(`Media index ${mediaIndex} out of range`);
		this.name = "MediaIndexOutOfRangeError";
	}
}

export class AmbiguousMediaError extends SocialDownloadError {
	constructor(message = "Multiple videos without media index") {
		super(message);
		this.name = "AmbiguousMediaError";
	}
}

export class AccessFailedError extends SocialDownloadError {
	constructor(
		readonly platform: SocialPlatform,
		message?: string,
	) {
		super(message ?? `Failed to access ${platform} content`);
		this.name = "AccessFailedError";
	}
}

export class NoWatermarkFreeVideoError extends SocialDownloadError {
	constructor(message = "No watermark-free TikTok URL") {
		super(message);
		this.name = "NoWatermarkFreeVideoError";
	}
}

export class VideoTooLargeError extends SocialDownloadError {
	constructor(readonly maxBytes: number) {
		super(`Video exceeds ${maxBytes} bytes`);
		this.name = "VideoTooLargeError";
	}
}

export class DownloadFailedError extends SocialDownloadError {
	constructor(message = "Download failed") {
		super(message);
		this.name = "DownloadFailedError";
	}
}
