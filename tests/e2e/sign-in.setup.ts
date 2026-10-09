import { expect, test as setup } from '@playwright/test';
import { E2E_ACCOUNT, E2E_AUTH_STATE, fillUntilKept } from './e2e-env';

setup('sign in once for the specs that only need a session', async ({ page }) => {
	await page.goto('/login');
	await fillUntilKept(page.getByLabel('Email'), E2E_ACCOUNT.email);
	await fillUntilKept(page.getByLabel('Password'), E2E_ACCOUNT.password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(/\/compose$/, { timeout: 20000 });
	await page.context().storageState({ path: E2E_AUTH_STATE });
});
