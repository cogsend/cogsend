/**
 * The claim form asks for the password twice, because a typo there locks the
 * operator out until they reach for the terminal. A generated password is
 * shown on screen instead, so there is nothing to repeat.
 */
export function claimPasswordProblem(
	password: string,
	confirm: string,
	shown: boolean
): string | null {
	if (shown) return null;
	return password === confirm ? null : "The two passwords don't match";
}
