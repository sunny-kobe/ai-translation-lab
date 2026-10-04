import { chromium, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const base = process.env.WEB_URL || 'http://127.0.0.1:5178';
await mkdir('output/playwright', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  acceptDownloads: true,
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
const steps = [];
let health;
let modelResults;
const outputDir = process.env.SMOKE_OUTPUT_DIR || 'output/playwright';
await mkdir(outputDir, { recursive: true });
try {
  health = await (await page.request.get(`${base}/api/health`)).json();
  expect(['fake', 'zhipu']).toContain(health.provider);
  await page.goto(base);
  await expect(
    page.getByText(
      health.provider === 'zhipu'
        ? `智谱 · ${health.model}`
        : 'Fake Translator',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'AI Translation Lab' }),
  ).toBeVisible();
  const key = `smoke.${Date.now()}`;
  await page
    .getByLabel('英文 key / value')
    .fill(JSON.stringify({ [key]: 'Hello {name}, Nova' }));
  const created = page.waitForResponse(
    (r) => r.url().endsWith('/api/jobs') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '创建任务', exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(202);
  const job = await response.json();
  steps.push('created a persisted task');
  const region = page.getByRole('region', { name: '翻译任务详情' });
  await expect(
    region.locator('.job-summary').getByText('翻译完成', { exact: true }),
  ).toBeVisible({ timeout: health.provider === 'zhipu' ? 240000 : 15000 });
  steps.push('polled to completion');
  modelResults = await (
    await page.request.get(`${base}/api/jobs/${job.id}/items`)
  ).json();
  if (health.provider === 'zhipu') {
    expect(
      modelResults.every(
        (r) => r.status === 'succeeded' && !r.target_text.startsWith('[模拟/'),
      ),
    ).toBe(true);
    expect(modelResults.find((r) => r.language === 'zh').target_text).toMatch(
      /[\u4e00-\u9fff]/,
    );
    steps.push('received real model translations');
  }
  await expect(
    region.getByRole('button', { name: '导出 zh.json', exact: true }),
  ).toBeDisabled();
  steps.push('unreviewed export disabled');
  const zh = region
    .locator('tbody tr')
    .filter({ has: page.getByRole('cell', { name: 'zh', exact: true }) });
  await zh.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('翻译内容').fill('你好 {name}，Nova！');
  await page
    .getByRole('checkbox', { name: '我已检查内容，标记为已审核' })
    .check();
  await page.getByRole('button', { name: '保存结果' }).click();
  await expect(
    zh.getByText('你好 {name}，Nova！', { exact: true }),
  ).toBeVisible();
  steps.push('edited and reviewed');
  await expect(
    region.getByRole('button', { name: '导出 zh.json', exact: true }),
  ).toBeEnabled();
  const downloading = page.waitForEvent('download');
  await region
    .getByRole('button', { name: '导出 zh.json', exact: true })
    .click();
  const download = await downloading;
  await download.saveAs(`${outputDir}/zh.json`);
  expect(JSON.parse(await readFile(`${outputDir}/zh.json`, 'utf8'))).toEqual({
    [key]: '你好 {name}，Nova！',
  });
  steps.push('verified exported JSON and placeholders');
  await page.reload();
  await expect(
    page.getByText('你好 {name}，Nova！', { exact: true }),
  ).toBeVisible();
  steps.push('persisted results survived page reload');
  await page.screenshot({
    path: `${outputDir}/desktop.png`,
    fullPage: true,
    animations: 'disabled',
  });
  // Deterministic fault injection belongs to the Fake provider only.
  if (health.provider === 'fake') {
    await page.getByRole('button', { name: '术语与可靠性实验' }).click();
    await page.getByText('正常完成', { exact: true }).click();
    await page.getByText('法语持续失败 → 部分成功', { exact: true }).click();
    await page
      .getByLabel('英文 key / value')
      .fill(JSON.stringify({ [`${key}.partial`]: 'Hello {name}, Nova' }));
    const second = page.waitForResponse(
      (r) => r.url().endsWith('/api/jobs') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '创建任务', exact: true }).click();
    const secondJob = await (await second).json();
    await expect(
      region.locator('.job-summary').getByText('部分成功', { exact: true }),
    ).toBeVisible({ timeout: health.provider === 'zhipu' ? 240000 : 15000 });
    await expect(
      region.getByText('PROVIDER_UNAVAILABLE', { exact: true }),
    ).toBeVisible();
    steps.push('observed partial success and failed-language details');
    const beforeRetry = await (
      await page.request.get(`${base}/api/jobs/${secondJob.id}/items`)
    ).json();
    const oldFr = beforeRetry.find((item) => item.language === 'fr');
    const oldZh = beforeRetry.find((item) => item.language === 'zh');
    const retried = page.waitForResponse(
      (r) => r.url().endsWith('/retry') && r.request().method() === 'POST',
    );
    const completedRetry = page.waitForResponse(async (r) => {
      if (
        !r.url().endsWith(`/api/jobs/${secondJob.id}/items`) ||
        r.status() !== 200
      )
        return false;
      const items = await r.json();
      return items.some(
        (item) =>
          item.language === 'fr' &&
          item.status === 'failed' &&
          item.attempts === 3 &&
          item.revision > oldFr.revision,
      );
    });
    void completedRetry.catch(() => {});
    await region.getByRole('button', { name: '重试失败项' }).click();
    expect((await (await retried).json()).status).toBe('running');
    const afterRetry = await (await completedRetry).json();
    expect(afterRetry.find((item) => item.language === 'zh')).toEqual(oldZh);
    await expect(
      region.locator('.job-summary').getByText('部分成功', { exact: true }),
    ).toBeVisible({ timeout: health.provider === 'zhipu' ? 240000 : 15000 });
    steps.push('retried failed language without losing successful rows');
  }
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: `${outputDir}/mobile.png`,
    fullPage: true,
    animations: 'disabled',
  });
  expect(errors).toEqual([]);
  await writeFile(
    `${outputDir}/smoke.json`,
    JSON.stringify(
      {
        passed: true,
        provider: health.provider,
        model: health.model,
        jobId: job.id,
        modelResults,
        steps,
        consoleErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ passed: true, steps, consoleErrors: errors }, null, 2),
  );
} catch (error) {
  console.error('Smoke failed after:', steps, error);
  await page.screenshot({
    path: `${outputDir}/failure.png`,
    fullPage: true,
  });
  throw error;
} finally {
  await browser.close();
}
