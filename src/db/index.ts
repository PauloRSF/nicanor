import { logger } from "../_lib/logger.js";
import { supabase } from "../_lib/supabase.js";

export async function init(): Promise<void> {
	const { error } = await supabase.from("stickers").select("id").limit(1);

	if (error) throw new Error(`Supabase connectivity check failed: ${error.message}`, { cause: error });

	logger.info("Database initialized.");
}
