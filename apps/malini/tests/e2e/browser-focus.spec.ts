import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
	captureFlow,
	createSourceRepo,
	expectCleanConsole,
	launchMalini,
	openWorkstream,
	seedTwoChats,
	seedWorkstream,
	selectChat,
	sendPrompt,
	withoutConsoleErrors,
	type LaunchedApp,
} from './harness';

const GRABBY = './.context/grabby.html';
const FIELD = './.context/field.html';
const PAGES = {
	'grabby.html': [
		'<!doctype html><title>Grabby page</title>',
		'<h1>Grabby page</h1>',
		'<input aria-label="Page field" autofocus>',
		'<script>',
		"const field = document.querySelector('input');",
		'field.focus();',
		'window.focus();',
		'setInterval(() => {',
		'	window.focus();',
		'	field.focus();',
		'}, 200);',
		'</script>',
	].join('\n'),
	'field.html': '<!doctype html><title>Field page</title><input aria-label="Page field">',
	'modal.html': [
		'<!doctype html><title>Modal prototype</title>',
		'<input aria-label="Prototype field" autofocus>',
		'<dialog aria-label="Prototype dialog">',
		'<input aria-label="Dialog field" autofocus>',
		'<div popover="manual"><input aria-label="Popover field" autofocus></div>',
		'</dialog>',
		'<script>',
		"document.querySelector('dialog').showModal();",
		"setTimeout(() => document.querySelector('[popover]').showPopover(), 300);",
		'</script>',
	].join('\n'),
};

function writePages(worktree: string): void {
	mkdirSync(join(worktree, '.context'), { recursive: true });
	for (const [name, html] of Object.entries(PAGES)) {
		writeFileSync(join(worktree, '.context', name), html);
	}
}

function composerOf(page: Page): Locator {
	return page.getByTestId('chat-composer-input');
}

function pageHoldsFocus(app: LaunchedApp, title: string): Promise<boolean> {
	return app.electronApp.evaluate(
		({ webContents }, wanted) =>
			webContents
				.getAllWebContents()
				.some((contents) => contents.getTitle() === wanted && contents.isFocused()),
		title,
	);
}

async function expectComposerHolds(app: LaunchedApp, text: string, title: string): Promise<void> {
	const composer = composerOf(app.page);
	await expect(composer).toBeFocused();
	await expect(composer).toHaveText(text);
	expect(await pageHoldsFocus(app, title)).toBe(false);
}

async function clearComposer(page: Page): Promise<void> {
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.press('Backspace');
	await expect(composerOf(page)).toHaveText('');
}

async function typeWhileTheAgent(
	app: LaunchedApp,
	request: { readonly action: string } & Record<string, unknown>,
	answer: string | RegExp,
): Promise<void> {
	const { page } = app;
	const encoded = Buffer.from(JSON.stringify(request)).toString('base64url');
	const answers = page.getByText(answer);
	const before = await answers.count();
	await sendPrompt(page, `Browser ${request.action} BROWSER_REQUEST:${encoded}`);
	await composerOf(page).click();
	await page.keyboard.type('Still', { delay: 20 });
	await expect(answers).toHaveCount(before + 1, { timeout: 20_000 });
	await page.waitForTimeout(500);
	await page.keyboard.type(' mine', { delay: 20 });
	await expectComposerHolds(app, 'Still mine', 'Grabby page');
	await clearComposer(page);
}

async function openFilesPanel(page: Page): Promise<void> {
	const inspector = page.getByRole('region', { name: 'Inspector' });
	await inspector.getByRole('button', { name: 'Open inspector panel' }).click();
	await page.getByRole('menuitem', { name: 'Open Files' }).click();
	await expect(inspector.getByRole('tab', { name: 'Files', selected: true })).toBeVisible();
}

function clickAndTypeInto(app: LaunchedApp, title: string, text: string): Promise<unknown> {
	return app.electronApp.evaluate(
		async ({ webContents }, { title, text }) => {
			const contents = webContents.getAllWebContents().find((each) => each.getTitle() === title);
			if (!contents) throw new Error(`no page titled ${title}`);
			const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));
			const point = (await contents.executeJavaScript(`(() => {
				const field = document.querySelector('input');
				field.value = '';
				field.blur();
				const box = field.getBoundingClientRect();
				return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
			})()`)) as { x: number; y: number };
			contents.sendInputEvent({ type: 'mouseMove', ...point });
			await pause();
			contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
			await pause();
			contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
			for (const keyCode of text) {
				await pause();
				contents.sendInputEvent({ type: 'char', keyCode });
			}
			await pause();
			return contents.executeJavaScript(
				`document.activeElement === document.querySelector('input') && document.activeElement.value`,
			);
		},
		{ title, text },
	);
}

test("a browser tab the agent loads, sizes and captures out of sight never takes the composer's focus, nor once you show it", async () => {
	test.setTimeout(180_000);
	const app = await launchMalini();
	try {
		const { page } = app;
		const source = await createSourceRepo(app.root, 'browser-focus-hidden');
		const seeded = await seedWorkstream(page, source, 'e2e-browser-focus-hidden', 'Hidden tab');
		writePages(seeded.worktree);
		await openWorkstream(page, seeded.workstreamId);
		const inspector = page.getByRole('region', { name: 'Inspector' });
		const tab = inspector.getByRole('tab', { name: 'Grabby page' });
		await sendPrompt(page, `Open it BROWSER_OPEN:${GRABBY}`);
		await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 20_000 });
		await openFilesPanel(page);
		await expect(tab).toHaveAttribute('aria-selected', 'false');

		await typeWhileTheAgent(app, { action: 'open', url: GRABBY }, /Call browser_screenshot/u);
		await typeWhileTheAgent(
			app,
			{ action: 'resize', width: 390, height: 844 },
			'The page is now 390px wide and 844px tall.',
		);
		await typeWhileTheAgent(app, { action: 'screenshot', fullPage: false }, /saved to /u);
		await expect(tab).toHaveAttribute('aria-selected', 'false');

		await tab.click();
		await expect(tab).toHaveAttribute('aria-selected', 'true');
		await composerOf(page).click();
		await page.keyboard.type('Shown', { delay: 20 });
		await page.waitForTimeout(1_000);
		await page.keyboard.type(' and still mine', { delay: 20 });
		await expectComposerHolds(app, 'Shown and still mine', 'Grabby page');
		await captureFlow(app, 'browser-focus-hidden-tab-shown');
		expectCleanConsole(app);
	} finally {
		await app.close();
	}
});

test("a page in the browser tab that focuses itself on load and on a timer never takes the composer's focus", async () => {
	test.setTimeout(120_000);
	const app = await launchMalini();
	try {
		const { page } = app;
		const source = await createSourceRepo(app.root, 'browser-focus-grabby');
		const seeded = await seedWorkstream(page, source, 'e2e-browser-focus-grabby', 'Grabby tab');
		writePages(seeded.worktree);
		await openWorkstream(page, seeded.workstreamId);
		const tab = page
			.getByRole('region', { name: 'Inspector' })
			.getByRole('tab', { name: 'Grabby page' });

		await sendPrompt(page, `Open it BROWSER_OPEN:${GRABBY}`);
		await composerOf(page).click();
		await page.keyboard.type('Loading', { delay: 20 });
		await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 20_000 });
		await page.waitForTimeout(1_000);
		await page.keyboard.type(' and loaded', { delay: 20 });
		await expectComposerHolds(app, 'Loading and loaded', 'Grabby page');
		await clearComposer(page);

		await typeWhileTheAgent(app, { action: 'reload' }, /^Reloaded /u);
		await captureFlow(app, 'browser-focus-grabby-page');
		expectCleanConsole(app);
	} finally {
		await app.close();
	}
});

test('a click into the page in the browser tab gives it focus, and the keys you type there reach it', async () => {
	test.setTimeout(120_000);
	const app = await launchMalini();
	try {
		const { page } = app;
		const source = await createSourceRepo(app.root, 'browser-focus-click');
		const seeded = await seedWorkstream(page, source, 'e2e-browser-focus-click', 'Field tab');
		writePages(seeded.worktree);
		await openWorkstream(page, seeded.workstreamId);
		await sendPrompt(page, `Open it BROWSER_OPEN:${FIELD}`);
		await expect(
			page
				.getByRole('region', { name: 'Inspector' })
				.getByRole('tab', { name: 'Field page', selected: true }),
		).toBeVisible({ timeout: 20_000 });

		await expect.poll(() => clickAndTypeInto(app, 'Field page', 'mine')).toBe('mine');
		await captureFlow(app, 'browser-focus-user-click');
		expectCleanConsole(app);
	} finally {
		await app.close();
	}
});

test("a report's prototype that opens a modal dialog and a popover with autofocus fields never takes the composer's focus, also when it reloads after a chat switch", async () => {
	test.setTimeout(180_000);
	const app = await launchMalini();
	try {
		const { page } = app;
		const source = await createSourceRepo(app.root, 'browser-focus-report');
		const { worktree, chatA, chatB } = await seedTwoChats(
			page,
			source,
			'e2e-browser-focus-report',
			'Report remount',
		);
		writePages(worktree);
		writeFileSync(
			join(worktree, 'report.md'),
			['![Modal prototype](.context/modal.html)', '', 'Outcome: A prototype.'].join('\n'),
		);
		await sendPrompt(page, 'Show me REPLY_FILE:report.md');
		const prototype = page.locator('iframe[title="Modal prototype"]').contentFrame();
		const popoverField = prototype.getByRole('textbox', { name: 'Popover field' });
		await expect(popoverField).toBeVisible({ timeout: 30_000 });
		await prototype.locator('html').evaluate((root) => root.setAttribute('data-first-load', ''));

		const composer = composerOf(page);
		await composer.click();
		await page.keyboard.type('Still', { delay: 20 });
		await selectChat(page, chatA);
		await selectChat(page, chatB);
		await page.keyboard.type(' mine', { delay: 20 });
		await expect(prototype.getByRole('dialog', { name: 'Prototype dialog' })).toBeVisible({
			timeout: 30_000,
		});
		await expect(popoverField).toBeVisible({ timeout: 30_000 });
		await expect(prototype.locator('html[data-first-load]')).toHaveCount(0);
		await page.waitForTimeout(500);
		await page.keyboard.type(' still', { delay: 20 });

		await expect(composer).toBeFocused();
		await expect(composer).toHaveText('Still mine still');
		await expect(prototype.getByRole('textbox', { name: 'Dialog field' })).toHaveValue('');
		await expect(popoverField).toHaveValue('');
		await captureFlow(app, 'browser-focus-report-remount');
		withoutConsoleErrors(
			app,
			/Blocked autofocusing on a <input> element in a cross-origin subframe/u,
		);
		expectCleanConsole(app);
	} finally {
		await app.close();
	}
});
