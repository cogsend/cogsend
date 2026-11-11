/** "1 draft", "2 drafts": the count and the word that agrees with it. */
export function plural(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}
