export type CommandParams<TContext> = TContext & { args: string[] };

type CommandOptions<TContext> = {
	command: string[];
	help: string;
	handler: (context: CommandParams<TContext>) => Promise<void>;
};

type CommandRouterType<TContext> = {
	handle: (context: TContext, text: string) => Promise<void>;
	command: (options: CommandOptions<TContext>) => void;
	helpText: () => string;
};

export function CommandRouter<TContext>(): CommandRouterType<TContext> {
	const aliasMap = new Map<string, CommandOptions<TContext>>();
	const registered: CommandOptions<TContext>[] = [];

	const command = (options: CommandOptions<TContext>) => {
		registered.push(options);
		for (const alias of options.command) {
			aliasMap.set(alias, options);
		}
	};

	const helpText = () =>
		registered
			.map((cmd) => {
				const visible = cmd.command.filter((c) => c !== "<default>");
				if (visible.length === 0) return null;
				return `*${visible.join(", ")}* — ${cmd.help}`;
			})
			.filter(Boolean)
			.join("\n");

	const handle = async (context: TContext, text: string) => {
		const [command, ...args] =
			text
				?.trim()
				.split(/[\s,]+/)
				.filter(Boolean) ?? [];

		const commandOptions = aliasMap.get(command);

		if (commandOptions) {
			await commandOptions.handler({ ...context, args });
		} else {
			const defaultHandler = aliasMap.get("<default>");

			if (defaultHandler) await defaultHandler.handler({ ...context, args });
		}
	};

	return { command, handle, helpText };
}
