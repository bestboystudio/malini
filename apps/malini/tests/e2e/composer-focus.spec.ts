import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { holdAgentRuns } from './fake-github';
import {
	captureFlow,
	createSourceRepo,
	currentSessionId,
	expectAssistantReply,
	expectCleanConsole,
	invoke,
	launchMalini,
	listEvents,
	openWorkstream,
	seedWorkstream,
	sendPrompt,
	tabTo,
	withoutConsoleErrors,
	type LaunchedApp,
} from './harness';

const GRABBY_PAGE = [
	'<!doctype html><title>Grabby prototype</title>',
	'<h1>Grabby prototype</h1>',
	'<input aria-label="Prototype field">',
	'<script>',
	"const field = document.querySelector('input');",
	'field.focus();',
	'setInterval(() => {',
	'	window.focus();',
	'	field.select();',
	'	field.focus();',
	'}, 200);',
	'</script>',
].join('\n');

test("a live prototype in the chat or the browser tab never takes the composer's focus", async () => {
	test.setTimeout(120_000);
	const app = await launchMalini();
	try {
		const { page } = app;
		const source = await createSourceRepo(app.root, 'composer-focus');
		const seeded = await seedWorkstream(page, source, 'e2e-composer-focus', 'Composer focus');
		mkdirSync(join(seeded.worktree, '.context'), { recursive: true });
		writeFileSync(join(seeded.worktree, '.context', 'grabby.html'), GRABBY_PAGE);
		writeFileSync(
			join(seeded.worktree, 'report.md'),
			['![Grabby prototype](.context/grabby.html)', '', 'Outcome: A prototype.'].join('\n'),
		);
		await openWorkstream(page, seeded.workstreamId);
		await sendPrompt(page, 'Open it BROWSER_OPEN:./.context/grabby.html');
		await expect(
			page
				.getByRole('region', { name: 'Inspector' })
				.getByRole('tab', { name: 'Grabby prototype' }),
		).toBeVisible({ timeout: 20_000 });
		const typeInto = Buffer.from(
			JSON.stringify({ action: 'type', selector: 'input', text: 'agent', submit: false }),
		).toString('base64url');
		await sendPrompt(page, `Type BROWSER_REQUEST:${typeInto}`);
		await expect(page.getByText('Typed into `input`')).toBeVisible({ timeout: 20_000 });
		await sendPrompt(page, 'Show me REPLY_FILE:report.md');
		const prototype = page.locator('iframe[title="Grabby prototype"]').contentFrame();
		await expect(prototype.getByRole('heading', { name: 'Grabby prototype' })).toBeVisible({
			timeout: 30_000,
		});

		const composer = page.getByTestId('chat-composer-input');
		await page.keyboard.type('Still', { delay: 20 });
		await page.waitForTimeout(1_000);
		await page.keyboard.type(' mine', { delay: 20 });
		await expect(composer).toBeFocused();
		await expect(composer).toHaveText('Still mine');

		await expect(prototype.getByRole('textbox', { name: 'Prototype field' })).toHaveValue('');
		await captureFlow(app, 'composer-focus-prototype');
		expectCleanConsole(app);
	} finally {
		await app.close();
	}
});

const STEAL_FOCUS = [
	"const thief = document.createElement('input');",
	"thief.setAttribute('aria-label', 'Thief');",
	"thief.style.cssText = 'position: fixed; top: 40px; left: 40px; z-index: 1000';",
	'document.body.append(thief);',
	'thief.focus();',
].join('\n');

test('the focus journal names a loss the user did not cause, and only that', async () => {
	test.setTimeout(90_000);
	const app = await launchMalini({ allowedDiagnostics: [/composer-focus-lost/u] });
	try {
		const { page } = app;
		const source = await createSourceRepo(app.root, 'composer-focus-journal');
		const seeded = await seedWorkstream(page, source, 'e2e-focus-journal', 'Focus journal');
		await openWorkstream(page, seeded.workstreamId);
		const composer = page.getByTestId('chat-composer-input');
		const losses = (): string[] =>
			app.consoleErrors.filter((line) => line.includes('composer-focus-lost'));

		await composer.click();
		await page.keyboard.type('Mine', { delay: 20 });
		await page.waitForTimeout(400);
		await page.evaluate(STEAL_FOCUS);
		await expect.poll(losses).toEqual([expect.stringContaining('"cause":"moved_to_field"')]);

		await composer.click();
		await page.waitForTimeout(400);
		const footer = page.getByTestId('chat-footer-stack');
		await footer.evaluate((element) => element.setAttribute('inert', ''));
		await expect.poll(losses).toHaveLength(2);
		expect(losses()[1]).toContain('"cause":"dropped_inert"');
		expect(losses()[1]).toContain('chat-footer-stack] inert');
		await footer.evaluate((element) => element.removeAttribute('inert'));
		withoutConsoleErrors(app, /composer-focus-lost/u);

		await composer.click();
		await page.waitForTimeout(1_100);
		await page.evaluate(`document.activeElement.blur()`);
		await expect.poll(losses).toEqual([expect.stringContaining('"cause":"dropped"')]);
		await expect(composer).toBeFocused();
		withoutConsoleErrors(app, /composer-focus-lost/u);

		await composer.click();
		await page.getByRole('textbox', { name: 'Thief' }).click();
		await composer.click();
		await page.keyboard.press('Tab');
		await page.waitForTimeout(400);
		expect(losses()).toEqual([]);
		expectCleanConsole(app);
	} finally {
		await app.close();
	}
});

type FocusChat = Readonly<{
	app: LaunchedApp;
	page: Page;
	composer: Locator;
	workstreamId: string;
}>;

async function openFocusChat(name: string, app?: LaunchedApp): Promise<FocusChat> {
	const launched = app ?? (await launchMalini());
	const { page } = launched;
	const source = await createSourceRepo(launched.root, name);
	const seeded = await seedWorkstream(page, source, `e2e-${name}`, name);
	await openWorkstream(page, seeded.workstreamId);
	const composer = page.locator('[data-testid="chat-composer-input"][aria-disabled="false"]');
	await expect(composer).toBeVisible({ timeout: 20_000 });
	return { app: launched, page, composer, workstreamId: seeded.workstreamId };
}

async function startTyping({ page, composer }: FocusChat, text: string): Promise<void> {
	await composer.click();
	await page.keyboard.type(text, { delay: 15 });
}

async function keepsTyping(
	{ page, composer }: FocusChat,
	more: string,
	all: string,
): Promise<void> {
	await page.keyboard.type(more, { delay: 15 });
	await expect(composer).toBeFocused();
	await expect(composer).toHaveText(all);
}

async function runStarted(page: Page): Promise<void> {
	await expect
		.poll(
			async () =>
				(await listEvents(page, currentSessionId(page) ?? '')).some(
					({ event }) => event.type === 'run.started',
				),
			{ timeout: 20_000 },
		)
		.toBe(true);
}

test('typing goes on while an agent run starts and ends in the chat', async () => {
	test.setTimeout(120_000);
	const app = await launchMalini();
	try {
		const chat = await openFocusChat('focus-run', app);
		const { page } = chat;
		holdAgentRuns(app, true);
		await startTyping(chat, 'Talk while I type');
		await page.keyboard.press('Enter');
		await runStarted(page);
		await keepsTyping(chat, 'Still ', 'Still ');
		holdAgentRuns(app, false);
		await expectAssistantReply(page);
		await expect(page.getByTestId('agent-working-loader')).toHaveCount(0, { timeout: 20_000 });
		await keepsTyping(chat, 'mine', 'Still mine');
		expectCleanConsole(app);
	} finally {
		await app.close();
	}
});

test('typing goes on while a second chat appears in the workstream, runs and stops', async () => {
	test.setTimeout(120_000);
	const app = await launchMalini();
	try {
		const chat = await openFocusChat('focus-second-chat', app);
		const { page, workstreamId } = chat;
		await sendPrompt(page, 'hello');
		await expectAssistantReply(page);
		await startTyping(chat, 'Still ');
		const second = await invoke<string>(page, 'chat.start-session', { workstreamId });
		await invoke(page, 'chat.send-prompt', { sessionId: second, prompt: 'HANG' });
		await expect(page.getByTestId('chat-agent-tab')).toHaveCount(2, { timeout: 20_000 });
		await keepsTyping(chat, 'mine', 'Still mine');
		await invoke(page, 'chat.cancel-run', { sessionId: second });
		await expect
			.poll(
				async () =>
					(await listEvents(page, second)).some(
						({ event }) =>
							event.type === 'turn.ended' ||
							event.type === 'run.failed' ||
							event.type === 'run.completed',
					),
				{ timeout: 20_000 },
			)
			.toBe(true);
		await keepsTyping(chat, ', all of it', 'Still mine, all of it');
		expectCleanConsole(app);
	} finally {
		await app.close();
	}
});

test('a file the agent opens while you type waits behind the chat, and closing a document hands the composer back', async () => {
	test.setTimeout(120_000);
	const app = await launchMalini();
	try {
		const source = await createSourceRepo(app.root, 'focus-document');
		const seeded = await seedWorkstream(app.page, source, 'e2e-focus-document', 'Document');
		writeFileSync(join(seeded.worktree, 'notes.md'), '# Notes\n');
		await openWorkstream(app.page, seeded.workstreamId);
		const composer = app.page.locator('[data-testid="chat-composer-input"][aria-disabled="false"]');
		const chat: FocusChat = { app, page: app.page, composer, workstreamId: seeded.workstreamId };
		const { page } = chat;
		await expect(page.getByTestId('extension-inspector-shell')).toHaveAttribute(
			'data-workstream-ready',
			'true',
			{ timeout: 20_000 },
		);
		writeFileSync(
			join(app.home, 'malini-tool.json'),
			JSON.stringify({
				tool: 'files_open',
				input: { path: 'notes.md', line: 1 },
				releasedBy: 'open-notes',
			}),
		);
		await sendPrompt(page, 'MALINI_UNASKED_TOOL');
		await startTyping(chat, 'Still ');
		writeFileSync(join(app.home, 'open-notes'), '');
		const tab = page.getByRole('tab', { name: 'notes.md', exact: true });
		await expect(tab).toBeVisible({ timeout: 20_000 });
		await expect(tab).toHaveAttribute('aria-selected', 'false');
		await keepsTyping(chat, 'mine', 'Still mine');

		await tab.click();
		await expect(tab).toHaveAttribute('aria-selected', 'true');
		await tab.hover();
		await page.getByRole('button', { name: 'Close notes.md' }).click();
		await expect(tab).toHaveCount(0);
		await keepsTyping(chat, ', all of it', 'Still mine, all of it');
		expectCleanConsole(app);
	} finally {
		await app.close();
	}
});

test('typing goes on while the agent changes the inspector panel', async () => {
	test.setTimeout(120_000);
	const app = await launchMalini();
	try {
		const source = await createSourceRepo(app.root, 'focus-inspector');
		const seeded = await seedWorkstream(app.page, source, 'e2e-focus-inspector', 'Inspector');
		mkdirSync(join(seeded.worktree, '.context'), { recursive: true });
		writeFileSync(
			join(seeded.worktree, '.context', 'calm.html'),
			'<!doctype html><title>Calm page</title><h1>Calm page</h1>',
		);
		await openWorkstream(app.page, seeded.workstreamId);
		const composer = app.page.locator('[data-testid="chat-composer-input"][aria-disabled="false"]');
		const chat: FocusChat = { app, page: app.page, composer, workstreamId: seeded.workstreamId };
		const { page } = chat;
		holdAgentRuns(app, true);
		await sendPrompt(page, 'Open it BROWSER_OPEN:./.context/calm.html');
		await runStarted(page);
		await startTyping(chat, 'Still ');
		holdAgentRuns(app, false);
		await expect(
			page.getByRole('region', { name: 'Inspector' }).getByRole('tab', { name: 'Calm page' }),
		).toBeVisible({ timeout: 20_000 });
		await keepsTyping(chat, 'mine', 'Still mine');
		expectCleanConsole(app);
	} finally {
		await app.close();
	}
});

test('the model picker opens and closes from the keyboard, and Enter then sends the draft', async () => {
	test.setTimeout(120_000);
	const app = await launchMalini();
	try {
		const chat = await openFocusChat('focus-picker', app);
		const { page, composer } = chat;
		await startTyping(chat, 'Pick, then send');
		const picker = page.getByRole('button', { name: /^Model: / });
		await tabTo(page, picker);
		await page.keyboard.press('Enter');
		const models = page.getByRole('listbox', { name: 'Models' });
		await expect(models).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(models).toBeHidden();
		await expect(composer).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(
			page.getByTestId('chat-message-bubble-user').filter({ hasText: 'Pick, then send' }),
		).toBeVisible({ timeout: 20_000 });
		await expect(composer).toBeFocused();
		expectCleanConsole(app);
	} finally {
		await app.close();
	}
});

test('typing goes on while a toast appears and clears', async () => {
	test.setTimeout(120_000);
	const app = await launchMalini({ allowedDiagnostics: [/Could not open missing\.md/u] });
	try {
		const chat = await openFocusChat('focus-toast', app);
		const { page, workstreamId } = chat;
		await startTyping(chat, 'Still ');
		await app.electronApp.evaluate(({ BrowserWindow }, id) => {
			for (const window of BrowserWindow.getAllWindows()) {
				window.webContents.send('malini:event', [
					{
						channel: 'extensions:file-open-requested',
						payload: { workstreamId: id, path: 'missing.md', line: 1 },
					},
				]);
			}
		}, workstreamId);
		const toast = page.getByText('Could not open missing.md');
		await expect(toast).toBeVisible({ timeout: 20_000 });
		await keepsTyping(chat, 'mine', 'Still mine');
		await expect(toast).toHaveCount(0, { timeout: 20_000 });
		await keepsTyping(chat, ', all of it', 'Still mine, all of it');
		withoutConsoleErrors(app, /Could not open missing\.md/u);
		expectCleanConsole(app);
	} finally {
		await app.close();
	}
});

test('a secret request and an agent question that arrive while you type wait for the draft', async () => {
	test.setTimeout(180_000);
	const app = await launchMalini();
	try {
		const chat = await openFocusChat('focus-asks', app);
		const { page, composer } = chat;
		writeFileSync(
			join(app.home, 'malini-tool.json'),
			JSON.stringify({
				tool: 'secrets_request',
				input: { names: ['STRIPE_KEY'], why: 'To charge a test card.' },
			}),
		);
		holdAgentRuns(app, true);
		await sendPrompt(page, 'MALINI_TOOL');
		await runStarted(page);
		await startTyping(chat, 'Still ');
		holdAgentRuns(app, false);
		const card = page.getByRole('region', { name: 'To charge a test card.' });
		await expect(card).toBeVisible({ timeout: 20_000 });
		await keepsTyping(chat, 'mine', 'Still mine');
		await card.getByRole('button', { name: 'Dismiss' }).click();
		await expect(card).toBeHidden({ timeout: 20_000 });

		holdAgentRuns(app, true);
		await sendPrompt(page, 'QUESTION');
		await expect
			.poll(
				async () =>
					(await listEvents(page, currentSessionId(page) ?? '')).filter(
						({ event }) => event.type === 'run.started',
					).length,
				{ timeout: 20_000 },
			)
			.toBe(2);
		await startTyping(chat, 'Typed ');
		holdAgentRuns(app, false);
		const held = page.getByRole('button', { name: /^Answer: 1 question needs you/u });
		await expect(held).toBeVisible({ timeout: 20_000 });
		await expect(page.getByTestId('agent-question-panel')).toHaveCount(0);
		await keepsTyping(chat, 'on', 'Typed on');
		await captureFlow(app, 'composer-focus-held-question');

		await held.click();
		await expect(page.getByTestId('agent-question-panel')).toBeVisible();
		await page.keyboard.press('2');
		await page.getByRole('button', { name: 'Send answer' }).click();
		await expect(page.getByTestId('agent-question-panel')).toHaveCount(0, { timeout: 20_000 });
		await expect(composer).toBeFocused();
		await expect(composer).toHaveText('Typed on');
		expectCleanConsole(app);
	} finally {
		await app.close();
	}
});

test('typing goes on while the window loses and regains focus', async () => {
	test.setTimeout(120_000);
	const app = await launchMalini();
	try {
		const chat = await openFocusChat('focus-window', app);
		const { page } = chat;
		await startTyping(chat, 'Still ');
		await app.electronApp.evaluate(({ BrowserWindow }) => {
			BrowserWindow.getAllWindows()[0]?.emit('blur');
		});
		await page.evaluate(`globalThis.dispatchEvent(new Event('blur'))`);
		await page.waitForTimeout(300);
		await app.electronApp.evaluate(({ BrowserWindow }) => {
			BrowserWindow.getAllWindows()[0]?.emit('focus');
		});
		await page.evaluate(`globalThis.dispatchEvent(new Event('focus'))`);
		await keepsTyping(chat, 'mine', 'Still mine');
		expectCleanConsole(app);
	} finally {
		await app.close();
	}
});

test('after a restart cut a turn, the composer holds the draft and typing goes on while the turn resumes', async () => {
	test.setTimeout(240_000);
	const first = await launchMalini();
	let workstreamId = '';
	try {
		const chat = await openFocusChat('focus-restart', first);
		workstreamId = chat.workstreamId;
		await sendPrompt(chat.page, 'HANG until Malini restarts');
		await runStarted(chat.page);
		await startTyping(chat, 'Across the restart');
		await expect(chat.composer).toHaveText('Across the restart');
		holdAgentRuns(first, true);
		await first.quit();
	} catch (error) {
		await first.close();
		throw error;
	}

	const app = await launchMalini({ profile: first.root });
	try {
		const { page } = app;
		await openWorkstream(page, workstreamId);
		const composer = page.locator('[data-testid="chat-composer-input"][aria-disabled="false"]');
		await expect(composer).toHaveText('Across the restart', { timeout: 30_000 });
		await expect(composer).toBeFocused();
		const chat: FocusChat = { app, page, composer, workstreamId };
		await keepsTyping(chat, ', still', 'Across the restart, still');
		holdAgentRuns(app, false);
		await expectAssistantReply(page);
		await keepsTyping(chat, ' mine', 'Across the restart, still mine');
		expectCleanConsole(app);
	} finally {
		await app.close();
	}
});
