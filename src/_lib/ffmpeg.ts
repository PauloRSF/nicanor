import { createRequire } from "node:module";

const requireFromFile = createRequire(import.meta.url);
export const ffmpegPath: string = requireFromFile("ffmpeg-static");

if (!ffmpegPath) {
	throw new Error("Bundled ffmpeg binary path is unavailable (ffmpeg-static)");
}

type GetAnimatedWebpOptionsParams = {
	inputPath: string;
	outputPath: string;
	maxFps?: number;
	quality: number;
	size: number;
};

export function getAnimatedWebpOptions({ inputPath, outputPath, maxFps, quality, size }: GetAnimatedWebpOptionsParams) {
	// Contain in size×size at maximum scale: factor = min(size/iw, size/ih) (may upscale small sources),
	// then transparent pad to a square so clients don't stretch non-square frames.
	const scaleContain = `scale=iw*min(${size}/iw\\,${size}/ih):ih*min(${size}/iw\\,${size}/ih):flags=lanczos+accurate_rnd+full_chroma_int`;
	const padSquare = `pad=w=${size}:h=${size}:x=(ow-iw)/2:y=(oh-ih)/2:color=black@0`;

	const filterGraphParts = ["setpts=PTS-STARTPTS"];

	if (maxFps !== undefined) {
		filterGraphParts.push(`fps=${maxFps}:round=down`);
	}

	filterGraphParts.push(scaleContain, "format=bgra", padSquare);

	const filterGraph = filterGraphParts.join(",");

	return [
		"-y",
		"-hide_banner",
		"-loglevel",
		"error",
		"-sws_flags",
		"accurate_rnd+full_chroma_int",
		"-i",
		inputPath,
		"-an",
		"-vcodec",
		"libwebp_anim",
		"-loop",
		"0",
		"-pix_fmt",
		"bgra",
		"-vf",
		filterGraph,
		"-lossless",
		"0",
		"-compression_level",
		"4",
		"-quality",
		String(quality),
		outputPath,
	];
}
