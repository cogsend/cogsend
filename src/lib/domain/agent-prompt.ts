import { platformName } from './platforms';
import {
	PLATFORM_SETUP,
	callbackUri,
	platformSecretNames,
	secretLabel,
	type OAuthPlatformId
} from './platform-setup';

/**
 * A prompt the operator pastes into a browser-driving agent (Claude in Chrome,
 * any computer-use agent) to create the platform's OAuth app for them.
 *
 * Built from the same data as the setup dialog, with this deployment's exact
 * redirect URI, so the agent has nothing to guess. Two rules are the point of
 * it: the credentials go straight into CogSend's own form and never into the
 * chat, and the agent hands control back at every step that is the person's to
 * take (signing in, verifying a phone, paying, solving a CAPTCHA).
 */
export function buildAgentPrompt(
	id: OAuthPlatformId,
	appUrl: string,
	instanceName: string
): string {
	const setup = PLATFORM_SETUP[id];
	const name = platformName(id);
	const origin = appUrl.replace(/\/+$/, '');
	const fields = platformSecretNames(id)
		.map((secret) => {
			const optional = setup.optionalSecrets?.includes(secret) ? ' (optional)' : '';
			return `   - ${secretLabel(secret)}${optional}`;
		})
		.join('\n');
	// "an X app", "a LinkedIn app": X is read as "ex".
	const article = /^(?:[aeiou]|x$)/i.test(name) ? 'an' : 'a';
	// The note is written for whoever sets Worker secrets; the agent fills a form.
	const note = setup.note?.replace(/\b[A-Z]+(?:_[A-Z]+)+\b/g, (secret) => secretLabel(secret));
	const lines = [
		`Set up ${article} ${name} developer app for my self-hosted ${instanceName} instance, so it can post to my ${name} account.`,
		'',
		'Steps:',
		`1. Open ${setup.consoleUrl} (${setup.consoleName}).`,
		`2. ${setup.consoleRequirement}`,
		`3. In ${setup.redirectField}, add exactly this redirect URI, character for character:`,
		`   ${callbackUri(id, origin)}`,
		`4. Open ${origin}/accounts in a new tab, choose "Connect new", pick ${name}, and type the app's credentials into these fields there:`,
		fields,
		'   Then press "Save and connect", and stop there: approving the connection on the next page is mine to do.',
		...(note ? [`   Note: ${note}`] : []),
		'',
		'Rules:',
		'- Never paste, repeat or summarise any client secret or app secret in this chat, in notes, or anywhere other than the field in step 4.',
		'- Stop and hand control back to me whenever a step needs me: signing in, two-factor or phone verification, identity checks, CAPTCHAs, accepting terms, or anything that costs money.',
		'- Do not change any other setting of an existing app or account.',
		'- When you are done, tell me which steps you completed and anything you could not finish.'
	];
	return lines.join('\n');
}
