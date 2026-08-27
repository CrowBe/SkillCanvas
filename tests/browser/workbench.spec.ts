import { expect, test } from "@playwright/test";

test("fallback completes load, lint, revise, compare, and export without WebMCP", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("Browser fallback")).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "See what your agent’s Skills actually do.",
    }),
  ).toBeVisible();
  await page.getByTestId("load-sample").click();
  await expect(page.getByTestId("skill-hero")).toBeVisible();
  await page.getByTestId("analyze").click();
  await expect(page.getByText(/Lint [A-D]/)).toBeVisible();
  await expect(page.getByText("Skill anatomy")).toBeVisible();
  await page.getByRole("button", { name: "Source" }).click();
  const editor = page.getByTestId("source-editor");
  await editor.fill(
    (await editor.inputValue()).replace(
      "Preserve the customer's meaning.",
      "Preserve the customer's exact meaning.",
    ),
  );
  await page.getByTestId("save-revision").click();
  await expect(page.getByText("Revision 2 loaded")).toBeVisible();
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await expect(page.getByText("Source diff metadata")).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByTestId("export-skill").click();
  expect((await download).suggestedFilename()).toBe("Skill Canvas demo.zip");
});

for (const theme of ["Light", "Dark", "Tuxedo", "Cardigan", "Terminal"]) {
  test(`visual smoke: ${theme}`, async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("load-sample").click();
    await page.getByLabel("Appearance").selectOption({ label: theme });
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      theme.toLowerCase(),
    );
    await expect(page.getByTestId("skill-hero")).toHaveScreenshot(
      `theme-${theme.toLowerCase()}.png`,
      { animations: "disabled" },
    );
  });
}
