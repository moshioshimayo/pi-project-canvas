// Focused real-browser check. Reuse an installed Playwright; no product dependency.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvasServer } from '../lib/server.mjs';
import { ensureProject } from '../lib/store.mjs';
const { chromium } = await import(process.env.PI_CANVAS_PLAYWRIGHT_MODULE || 'playwright');
const home = mkdtempSync(join(tmpdir(), 'pi-canvas-comments-'));
const repo = join(home, 'diagram-review'); mkdirSync(repo);
const project = ensureProject(repo, home);
const server = createCanvasServer({ home, host: '127.0.0.1', port: 0 });
let browser;
try {
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const url = `${origin}/p/${project.id}/`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  page.setDefaultTimeout(10000);
  await page.goto(url);
  await page.getByRole('button', { name: 'Add comment', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Share diagram', exact: true }).isDisabled(), true);
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 720; canvas.height = 280;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 720, 280);
    ctx.font = '24px sans-serif'; ctx.strokeStyle = '#475569'; ctx.fillStyle = '#17232b';
    for (const [x, label] of [[30, 'Diagram'], [410, 'Shared review']]) {
      ctx.strokeRect(x, 70, 260, 120); ctx.fillText(label, x + 20, 140);
    }
    ctx.beginPath(); ctx.moveTo(290, 130); ctx.lineTo(410, 130); ctx.stroke();
    return canvas.toDataURL('image/png');
  });
  const posted = await fetch(`${origin}/api/${project.id}/posts`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Diagram review', image }),
  });
  assert.equal(posted.status, 201);
  await page.reload();
  const addComment = page.getByRole('button', { name: 'Add comment', exact: true });
  await addComment.click();
  assert.equal(await addComment.getAttribute('aria-pressed'), 'true');
  const main = await page.locator('main').boundingBox();
  await page.mouse.click(main.x + main.width * 0.5, main.y + main.height * 0.75);
  const comment = 'Keep this arrow — review the diagram here.';
  await page.locator('textarea.excalidraw-wysiwyg').pressSequentially(comment);
  const persisted = page.waitForResponse(response => response.url().endsWith('/scene') && response.request().method() === 'PUT' && response.request().postDataJSON().elements.some(element => element.text === comment));
  await page.keyboard.press('Escape');
  assert.equal((await persisted).status(), 200);
  await page.keyboard.press('Escape');
  await page.mouse.click(main.x + 10, main.y + main.height - 10);
  await page.waitForFunction(() => [...document.querySelectorAll('button')].find(button => button.textContent.startsWith('Share selection'))?.disabled);
  assert.equal(await page.getByRole('button', { name: /^Share selection/ }).isDisabled(), true);
  await page.getByRole('button', { name: 'Share diagram', exact: true }).click();
  const linkField = page.getByRole('textbox', { name: 'Selection link', exact: true });
  await linkField.waitFor();
  const link = await linkField.inputValue();
  if (process.env.PI_CANVAS_SHOTS) await page.screenshot({ path: join(process.env.PI_CANVAS_SHOTS, 'diagram-comments.png') });
  const id = new URL(link).searchParams.get('selection');
  const savedURL = `${origin}/api/${project.id}/selections/${id}`;
  const saved = await (await fetch(savedURL)).json();
  assert.ok(saved.texts.includes(comment));
  assert.equal(saved.note, '');
  assert.ok(saved.assetIds.length > 0, 'full diagram retains the original screenshot');
  const scene = await (await fetch(`${origin}/api/${project.id}/scene`)).json();
  const text = scene.elements.find(element => element.text === comment);
  assert.ok(saved.elementIds.includes(text.id));
  await page.getByRole('button', { name: 'Copy link', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), link);
  await page.goto(link);
  await page.getByRole('button', { name: 'View saved capture', exact: true }).click();
  await page.getByRole('dialog').getByRole('img').waitFor();
  if (process.env.PI_CANVAS_SHOTS) await page.screenshot({ path: join(process.env.PI_CANVAS_SHOTS, 'shared-comments.png') });
  console.log('PASS in-diagram typing, full-diagram sharing, clipboard and reopened frozen capture');
  await page.getByRole('button', { name: 'Back to live board', exact: true }).click();
  const reopenedMain = await page.locator('main').boundingBox();
  await page.mouse.click(reopenedMain.x + 10, reopenedMain.y + reopenedMain.height - 10);
  await page.keyboard.press('ControlOrMeta+a');
  const selectionSaved = page.waitForResponse(response => response.url().endsWith('/selections') && response.request().method() === 'POST');
  await page.getByRole('button', { name: /^Share selection/ }).click();
  assert.equal((await selectionSaved).status(), 201);
  // Deleting live content after reopening cannot rewrite the immutable shared capture.
  await page.mouse.click(reopenedMain.x + 10, reopenedMain.y + reopenedMain.height - 10);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.getByRole('button', { name: 'Share diagram', exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(async endpoint => (await (await fetch(endpoint)).json()).elements.every(element => element.isDeleted), `${origin}/api/${project.id}/scene`);
  const unchanged = await (await fetch(savedURL)).json();
  assert.equal(unchanged.image, saved.image);
  assert.equal(unchanged.texts, saved.texts);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(link);
  await page.getByRole('button', { name: 'Add comment', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByRole('button', { name: 'View saved capture', exact: true }).click();
  await page.getByRole('dialog').getByRole('img').waitFor();
  if (process.env.PI_CANVAS_SHOTS) await page.screenshot({ path: join(process.env.PI_CANVAS_SHOTS, 'phone-comments.png') });
  console.log(`PASS ${url}: in-diagram comment saved; full diagram shared with no selection/top-bar note; copied/reopened capture contains text + original; selection sharing works; live deletion leaves capture immutable; phone has no overflow. Env: disposable loopback data, headless Chromium.`);
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  rmSync(home, { recursive: true, force: true });
}
