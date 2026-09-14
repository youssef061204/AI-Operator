import { test, expect } from "@playwright/test";
test("real API/UI approval, rollback, denial and cancellation", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page
    .getByLabel("Access token")
    .fill("browser-fixture-token-".repeat(3));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .getByLabel("Objective", { exact: true })
    .fill("Write verified fixture result");
  await page.getByLabel("File path within workspace").fill("result.txt");
  await page.getByLabel("Required text").fill("ok");
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Action needs approval" }),
  ).toBeVisible();
  await expect(page.getByLabel("Action approval")).toContainText("write_file");
  await page.getByRole("button", { name: "Approve once", exact: true }).click();
  await expect(page.locator(".runtime-detail .chip")).toHaveText("completed");
  await expect(
    page.getByText("Verified fixture result", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Request restore", exact: true })
    .click();
  await page
    .locator(".runtime-task")
    .filter({ hasText: "Restore checkpoint" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Action needs approval" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Allow for this task" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Approve once", exact: true }).click();
  await expect(page.locator(".runtime-detail .chip")).toHaveText("completed");
  await page
    .getByLabel("Objective", { exact: true })
    .fill("Deny a fixture write");
  await page.getByLabel("File path within workspace").fill("denied.txt");
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await page.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(page.locator(".runtime-detail .chip")).toHaveText("failed");
  await expect(
    page.getByText("Operator denied action", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Objective", { exact: true })
    .fill("Cancel a running command");
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await page.getByRole("button", { name: "Approve once", exact: true }).click();
  await expect(page.locator(".runtime-detail .chip")).toHaveText("running");
  await page.getByRole("button", { name: "Cancel task", exact: true }).click();
  await expect(page.locator(".runtime-detail .chip")).toHaveText("canceled");
  expect(errors).toEqual([]);
});
