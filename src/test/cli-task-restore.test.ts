import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { $ } from "bun";
import { Core } from "../index.ts";
import { getTestCliPath } from "./test-cli.ts";
import {
	createUniqueTestDir,
	initializeFilesystemTestProject,
	initializeTestProject,
	safeCleanup,
} from "./test-utils.ts";

let TEST_DIR: string;
const CLI_PATH = getTestCliPath();

async function createCompletedChild(core: Core, id = "task-1.1") {
	await core.createTask(
		{
			id: "task-1",
			title: "Parent task",
			status: "Done",
			assignee: [],
			createdDate: "2026-01-01",
			labels: ["parent"],
			dependencies: [],
			rawContent: "Parent body",
		},
		false,
	);
	await core.createTask(
		{
			id,
			title: "Completed child",
			status: "Done",
			assignee: ["maintainer"],
			reporter: "operator",
			createdDate: "2026-01-02",
			updatedDate: "2026-01-03 04:05",
			labels: ["history", "restore"],
			dependencies: ["TASK-1"],
			references: ["https://example.test/source"],
			documentation: ["docs/history.md"],
			modifiedFiles: ["src/history.ts"],
			parentTaskId: "TASK-1",
			priority: "high",
			type: "task",
			rawContent: "Rich body before restore.",
			description: "Preserve this description.",
			acceptanceCriteriaItems: [{ index: 1, text: "History retained", checked: true }],
			implementationPlan: "Keep the exact record.",
			implementationNotes: "Completed before restore.",
			finalSummary: "Original completion summary.",
		},
		false,
	);
	expect(await core.completeTask(id, false, { includeCrossBranch: false })).toBe(true);
	const completed = (await core.filesystem.listCompletedTasks()).find((task) => task.id === id.toUpperCase());
	expect(completed?.filePath).toBeDefined();
	if (!completed?.filePath) throw new Error("Expected completed child path");
	return completed;
}

describe("task restore", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-cli-task-restore");
		await mkdir(TEST_DIR, { recursive: true });
	});

	afterEach(async () => {
		await safeCleanup(TEST_DIR);
	});

	it("documents the storage-only restore contract in command help", async () => {
		const help = await $`bun ${CLI_PATH} task restore --help`.cwd(TEST_DIR).nothrow().quiet();
		const output = help.stdout.toString() + help.stderr.toString();
		expect(help.exitCode).toBe(0);
		expect(output).toContain("restore a completed task to active storage without reopening it");
		expect(output).toContain("without changing its ID, content, parent, or status");
		expect(output).toContain("does not reopen the task");
		expect(output).toContain("task edit");
		expect(output).toContain("task complete");
	});

	it("preserves the exact completed record and supports restore, edit, then complete", async () => {
		const core = new Core(TEST_DIR);
		await initializeFilesystemTestProject(core, "Restore Test Project");
		const completed = await createCompletedChild(core);
		const completedPath = completed.filePath as string;
		const originalBytes = await readFile(completedPath);
		const activePath = join(core.filesystem.tasksDir, basename(completedPath));

		const restored = await $`bun ${CLI_PATH} task restore task-1.1`.cwd(TEST_DIR).nothrow().quiet();
		const restoreOutput = restored.stdout.toString() + restored.stderr.toString();
		expect(restored.exitCode).toBe(0);
		expect(restoreOutput).toContain("Restored task TASK-1.1 to active storage without changing its status.");
		expect(restoreOutput).toContain(activePath);
		expect(await Bun.file(completedPath).exists()).toBe(false);
		expect(await Bun.file(activePath).exists()).toBe(true);
		expect(await readFile(activePath)).toEqual(originalBytes);

		const active = await core.filesystem.loadTask("task-1.1");
		expect(active?.id).toBe("TASK-1.1");
		expect(active?.parentTaskId).toBe("TASK-1");
		expect(active?.status).toBe("Done");
		expect(active?.description).toBe("Preserve this description.");
		expect(active?.implementationPlan).toBe("Keep the exact record.");
		expect(active?.implementationNotes).toBe("Completed before restore.");
		expect(active?.finalSummary).toBe("Original completion summary.");

		const edited =
			await $`bun ${CLI_PATH} task edit task-1.1 --type feature --append-notes ${"Migration edit applied."} --plain`
				.cwd(TEST_DIR)
				.nothrow()
				.quiet();
		expect(edited.exitCode).toBe(0);
		const afterEdit = await core.filesystem.loadTask("task-1.1");
		expect(afterEdit?.type).toBe("feature");
		expect(afterEdit?.implementationNotes).toContain("Migration edit applied.");
		expect(afterEdit?.id).toBe("TASK-1.1");
		expect(afterEdit?.parentTaskId).toBe("TASK-1");
		expect(afterEdit?.status).toBe("Done");

		const completedAgain = await $`bun ${CLI_PATH} task complete task-1.1`.cwd(TEST_DIR).nothrow().quiet();
		expect(completedAgain.exitCode).toBe(0);
		expect(await Bun.file(activePath).exists()).toBe(false);
		const finalRecord = (await core.filesystem.listCompletedTasks()).find((task) => task.id === "TASK-1.1");
		expect(finalRecord?.type).toBe("feature");
		expect(finalRecord?.implementationNotes).toContain("Migration edit applied.");
		expect(finalRecord?.parentTaskId).toBe("TASK-1");
		expect(finalRecord?.status).toBe("Done");
	});

	it("does not replace an occupied active destination", async () => {
		const core = new Core(TEST_DIR);
		await initializeFilesystemTestProject(core, "Restore Collision Project");
		const completed = await createCompletedChild(core);
		const completedPath = completed.filePath as string;
		const completedBytes = await readFile(completedPath);
		const activePath = join(core.filesystem.tasksDir, basename(completedPath));
		const sentinel = "unparseable active destination sentinel\n";
		await Bun.write(activePath, sentinel);

		const restored = await $`bun ${CLI_PATH} task restore task-1.1`.cwd(TEST_DIR).nothrow().quiet();
		const output = restored.stdout.toString() + restored.stderr.toString();
		expect(restored.exitCode).not.toBe(0);
		expect(output).toContain(`Destination already exists: ${activePath}`);
		expect(await readFile(completedPath)).toEqual(completedBytes);
		expect(await Bun.file(activePath).text()).toBe(sentinel);
	});

	it("rolls the file move back when auto-commit fails", async () => {
		await $`git init -b main`.cwd(TEST_DIR).quiet();
		await $`git config user.name ${"Backlog Test"}`.cwd(TEST_DIR).quiet();
		await $`git config user.email ${"backlog-test@example.test"}`.cwd(TEST_DIR).quiet();
		const core = new Core(TEST_DIR);
		await initializeTestProject(core, "Restore Rollback Project", true);
		const completed = await createCompletedChild(core);
		const completedPath = completed.filePath as string;
		const activePath = join(core.filesystem.tasksDir, basename(completedPath));
		await $`git add .`.cwd(TEST_DIR).quiet();
		await $`git commit -m ${"Record completed task"}`.cwd(TEST_DIR).quiet();
		await Bun.write(completedPath, `${await Bun.file(completedPath).text()}\nPrior staged operator change.\n`);
		await $`git add ${completedPath}`.cwd(TEST_DIR).quiet();
		const completedBytes = await readFile(completedPath);
		const stagedBefore = (await $`git diff --cached --binary`.cwd(TEST_DIR).quiet()).stdout.toString();

		const originalCommitFiles = core.git.commitFiles.bind(core.git);
		core.git.commitFiles = (async () => {
			throw new Error("injected commit failure");
		}) as typeof core.git.commitFiles;
		try {
			await expect(core.restoreTask("task-1.1", true, { includeCrossBranch: false })).rejects.toThrow(
				"injected commit failure",
			);
		} finally {
			core.git.commitFiles = originalCommitFiles;
		}

		expect(await Bun.file(activePath).exists()).toBe(false);
		expect(await readFile(completedPath)).toEqual(completedBytes);
		expect((await $`git diff --cached --binary`.cwd(TEST_DIR).quiet()).stdout.toString()).toBe(stagedBefore);
		const status = (await $`git status --porcelain`.cwd(TEST_DIR).quiet()).stdout.toString();
		expect(status).toContain("M  ");
		expect(status).toContain("backlog/completed/");
	});

	it("leaves the real index untouched when staging preparation fails", async () => {
		await $`git init -b main`.cwd(TEST_DIR).quiet();
		await $`git config user.name ${"Backlog Test"}`.cwd(TEST_DIR).quiet();
		await $`git config user.email ${"backlog-test@example.test"}`.cwd(TEST_DIR).quiet();
		const core = new Core(TEST_DIR);
		await initializeTestProject(core, "Restore Staging Failure Project", true);
		const completed = await createCompletedChild(core);
		expect(await core.completeTask("task-1", false, { includeCrossBranch: false })).toBe(true);
		const completedPath = completed.filePath as string;
		const completedBytes = await readFile(completedPath);
		const activePath = join(core.filesystem.tasksDir, basename(completedPath));
		await $`git add .`.cwd(TEST_DIR).quiet();
		await $`git commit -m ${"Record completed task"}`.cwd(TEST_DIR).quiet();
		await Bun.write(join(TEST_DIR, ".gitattributes"), "backlog/tasks/** filter=restore-fail\n");
		await $`git config filter.restore-fail.clean false`.cwd(TEST_DIR).quiet();
		await $`git config filter.restore-fail.required true`.cwd(TEST_DIR).quiet();
		await $`git add .gitattributes`.cwd(TEST_DIR).quiet();
		await $`git commit -m ${"Require failing active-task filter"}`.cwd(TEST_DIR).quiet();
		const indexBefore = (await $`git ls-files -s`.cwd(TEST_DIR).quiet()).stdout.toString();

		await expect(core.restoreTask("task-1.1", true)).rejects.toThrow();

		expect(await Bun.file(activePath).exists()).toBe(false);
		expect(await readFile(completedPath)).toEqual(completedBytes);
		expect((await $`git ls-files -s`.cwd(TEST_DIR).quiet()).stdout.toString()).toBe(indexBefore);
		expect((await $`git status --porcelain`.cwd(TEST_DIR).quiet()).stdout.toString()).toBe("");
	});
});
