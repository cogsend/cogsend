/** Hands the browser a text file to save, without a round trip to the server. */
export function downloadText(filename: string, text: string) {
	const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
	const link = document.createElement('a');
	link.href = url;
	link.download = filename;
	document.body.append(link);
	link.click();
	link.remove();
	// Revoked on the next task: some browsers start the save only after click returns.
	setTimeout(() => URL.revokeObjectURL(url), 0);
}
