import { supabase } from "../_lib/supabase.js";

export async function isStickerTaggingEnabled(userId: string): Promise<boolean> {
	const { data, error } = await supabase
		.from("user_settings")
		.select("sticker_tagging_enabled")
		.eq("user_id", userId)
		.maybeSingle();

	if (error) {
		throw new Error(`Failed to load user settings for ${userId}: ${error.message}`);
	}

	return data?.sticker_tagging_enabled ?? false;
}

export async function toggleStickerTagging(userId: string): Promise<boolean> {
	const currentlyEnabled = await isStickerTaggingEnabled(userId);
	const nextEnabled = !currentlyEnabled;

	const { error } = await supabase.from("user_settings").upsert(
		{
			user_id: userId,
			sticker_tagging_enabled: nextEnabled,
			updated_at: new Date().toISOString(),
		},
		{ onConflict: "user_id" },
	);

	if (error) {
		throw new Error(`Failed to toggle sticker tagging for ${userId}: ${error.message}`);
	}

	return nextEnabled;
}
