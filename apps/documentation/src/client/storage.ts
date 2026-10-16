/** Reads and writes storage, ignoring browsers that block it, such as some private windows. */
export const store = {
	get(storage: "local" | "session", key: string): string | null {
		try {
			return (storage === "local" ? localStorage : sessionStorage).getItem(key);
		} catch {
			return null;
		}
	},
	set(storage: "local" | "session", key: string, value: string) {
		try {
			(storage === "local" ? localStorage : sessionStorage).setItem(key, value);
		} catch {}
	},
};
