export class UserQueue {
	private chains = new Map<string, Promise<void>>();

	enqueue(userId: string, fn: () => Promise<void>): void {
		const prev = this.chains.get(userId) ?? Promise.resolve();
		const next = prev.then(fn, fn);

		this.chains.set(userId, next);

		next.finally(() => {
			if (this.chains.get(userId) === next) {
				this.chains.delete(userId);
			}
		});
	}
}
