const { test, expect } = require('@playwright/test');

test('Isle of Wight beach picker renders and changes beaches', async ({ page }) => {
  await page.goto('http://127.0.0.1:8001/?beach=totland-bay');

  await expect(page.locator('#beachTitle')).toHaveText('Totland Bay');
  await expect(page.locator('#beachSelect')).toHaveValue('totland-bay');
  await expect(page.locator('.map-pin')).toHaveCount(21);
  await expect(page.locator('#dogRule')).toContainText('Dogs allowed all year');

  await page.locator('#btnDefaultBeach').click();
  await expect(page.locator('#btnDefaultBeach')).toHaveText('Default set');

  await page.locator('#beachSelect').selectOption('ryde-west');
  await expect(page).toHaveURL(/beach=ryde-west/);
  await expect(page.locator('#beachTitle')).toHaveText('Ryde Beach West');
  await expect(page.locator('#dogRule')).toContainText('west-of-pier stretch');

  await page.locator('#beachSelect').selectOption('thorness-bay');
  await expect(page).toHaveURL(/beach=thorness-bay/);
  await expect(page.locator('#beachTitle')).toHaveText('Thorness Bay');
  await expect(page.locator('#confidenceNote')).toContainText('good first guess');
  await expect(page.locator('#confidenceNote a')).toHaveText('Help tune this beach');

  await page.locator('#confidenceNote a').click();
  await expect(page).toHaveURL(/feedback\.html\?beach=thorness-bay/);
  await expect(page.locator('#feedbackBeachName')).toHaveText('Help tune Thorness Bay');
  await expect(page.locator('.rating-guide')).toContainText('3 stars');
  await expect(page.locator('#feedbackTemplate')).toContainText('Beach: Thorness Bay');
});
