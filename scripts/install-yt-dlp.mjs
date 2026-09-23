import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN_DIR = join(ROOT, "bin");
const FORCE = process.argv.includes("--force");
const RELEASE = "latest";
const BASE_URL = `https://github.com/yt-dlp/yt-dlp/releases/${RELEASE}/download`;

function resolveAsset() {
	const { platform, arch } = process;

	if (platform === "win32") {
		return { asset: "yt-dlp.exe", outputName: "yt-dlp.exe" };
	}

	if (platform === "darwin") {
		return { asset: "yt-dlp_macos", outputName: "yt-dlp" };
	}

	if (platform === "linux") {
		if (arch === "arm64") {
			return { asset: "yt-dlp_linux_aarch64", outputName: "yt-dlp" };
		}
		return { asset: "yt-dlp_linux", outputName: "yt-dlp" };
	}

	throw new Error(`Unsupported platform for yt-dlp: ${platform}/${arch}`);
}

async function fileExists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function main() {
	const { asset, outputName } = resolveAsset();
	const outputPath = join(BIN_DIR, outputName);

	if (!FORCE && (await fileExists(outputPath))) {
		console.log(`yt-dlp already installed at ${outputPath} (use --force to reinstall)`);
		return;
	}

	await mkdir(BIN_DIR, { recursive: true });

	const url = `${BASE_URL}/${asset}`;
	console.log(`Downloading yt-dlp from ${url}...`);

	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok) {
		throw new Error(`Failed to download yt-dlp: HTTP ${response.status}`);
	}

	const bytes = Buffer.from(await response.arrayBuffer());
	const tempPath = `${outputPath}.tmp`;

	try {
		await writeFile(tempPath, bytes);
		if (platformIsUnix()) {
			await chmod(tempPath, 0o755);
		}
		await rename(tempPath, outputPath);
	} catch (error) {
		await rm(tempPath, { force: true });
		throw error;
	}

	console.log(`yt-dlp installed at ${outputPath}`);
}

function platformIsUnix() {
	return process.platform !== "win32";
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
