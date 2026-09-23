import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function findProjectRoot(startDir: string): string {
	let dir = startDir;

	for (;;) {
		if (existsSync(join(dir, "package.json"))) {
			return dir;
		}

		const parent = dirname(dir);
		if (parent === dir) {
			throw new Error("Could not locate project root (package.json)");
		}
		dir = parent;
	}
}

function defaultYtDlpPath(): string {
	const root = findProjectRoot(dirname(fileURLToPath(import.meta.url)));
	const binaryName = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
	return join(root, "bin", binaryName);
}

const envPath = process.env.NICANOR_YTDLP_PATH?.trim();

export const ytDlpPath: string = envPath && envPath.length > 0 ? envPath : defaultYtDlpPath();
