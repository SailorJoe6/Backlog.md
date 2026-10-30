import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { Core } from "../core/backlog.ts";
import { loadTaskDetail } from "../core/task-detail.ts";
import { serializeTask } from "../markdown/serializer.ts";
import type { Task } from "../types/index.ts";
import { findDependencyDefects } from "../utils/task-builders.ts";
import { initializeTestProject } from "./test-utils.ts";

const cliPath = join(import.meta.dir, "../cli.ts");

describe("Dependency eligibility: tasks and completed only", () => {
	let directory: string;
	let core: Core;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "backlog-dependency-eligibility-"));
		await $`git init -b main`.cwd(directory).quiet();
		core = new Core(directory);
		await initializeTestProject(core, "test-project");
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	test.each([false, true])("archive plus eligible ID selects the eligible record (completed=%s)", async (completed) => {
		const { task: archived } = await core.createTaskFromInput({ title: "Old archived record" }, false);
		expect((await core.archiveTask(archived.id, false)).success).toBe(true);
		const archive = (await core.filesystem.listArchivedTasks())[0];
		expect(archive?.filePath).toBeDefined();
		if (!archive?.filePath) throw new Error("Missing archive fixture");
		const archiveBytes = await Bun.file(archive.filePath).text();
		const configBytes = await Bun.file(core.filesystem.configFilePath).text();
		await $`git add .`.cwd(directory).quiet();
		await $`git -c user.name=Test -c user.email=test@example.com commit -m archive`.cwd(directory).quiet();
		const history = (await $`git log --format=%H`.cwd(directory).quiet()).text();

		// Native allocation still reuses the archived ID. There is no reservation policy.
		const { task: live } = await core.createTaskFromInput({ title: "Eligible replacement", status: "Done" }, false);
		expect(live.id).toBe(archived.id);
		if (completed) expect(await core.completeTask(live.id, false)).toBe(true);
		const { task: dependent } = await core.createTaskFromInput({ title: "Dependent", dependencies: [live.id] }, false);
		await core.updateTaskFromInput(dependent.id, { dependencies: [live.id] }, false);
		const detail = await loadTaskDetail(core, dependent);
		expect(detail.dependencyGraph.nodes.find((node) => node.id === live.id)?.title).toBe(live.title);
		expect(detail.readiness.isReady).toBe(true);
		expect(await findDependencyDefects(core)).toEqual({ selfDependencies: [], cycles: [] });
		expect(await Bun.file(archive.filePath).text()).toBe(archiveBytes);
		expect(await Bun.file(core.filesystem.configFilePath).text()).toBe(configBytes);
		expect((await core.filesystem.listArchivedTasks()).map((task) => task.id)).toEqual([archived.id]);
		expect((await $`git log --format=%H`.cwd(directory).quiet()).text()).toBe(history);
	});

	test("archived edges cannot form a validation or doctor cycle, and archive-only references report missing", async () => {
		const { task: root } = await core.createTaskFromInput({ title: "Root" }, false);
		const { task: middle } = await core.createTaskFromInput({ title: "Middle" }, false);
		const legacy: Task = { ...root, id: "TASK-9", title: "Deleted history", dependencies: [root.id, "TASK-9"] };
		const archivePath = join(core.filesystem.backlogDir, "archive/tasks/task-9 - Deleted.md");
		await Bun.write(archivePath, serializeTask(legacy));
		// Simulate a legacy dangling reference. Mutation must not traverse archived outgoing edges.
		await core.filesystem.saveTask({ ...middle, dependencies: [legacy.id] });
		await core.updateTaskFromInput(root.id, { dependencies: [middle.id] }, false);
		const detail = await loadTaskDetail(core, (await core.filesystem.loadTask(root.id)) as Task);
		expect(detail.dependencyGraph.nodes.find((node) => node.id === legacy.id)?.state).toBe("missing");
		expect(await findDependencyDefects(core)).toEqual({ selfDependencies: [], cycles: [] });
		const doctor = await $`bun ${cliPath} doctor`.cwd(directory).nothrow().quiet();
		expect(doctor.exitCode).toBe(0);
		expect(`${doctor.stdout}${doctor.stderr}`).not.toContain("Dependency cycles (diagnostic only)");
		expect(await Bun.file(archivePath).text()).toBe(serializeTask(legacy));
	});

	test("draft edges and self-references are not dependency-defect roots", async () => {
		const { task: root } = await core.createTaskFromInput({ title: "Root" }, false);
		await core.filesystem.saveDraft({ ...root, id: "DRAFT-1", dependencies: ["DRAFT-1", root.id] });
		await core.filesystem.saveTask({ ...root, dependencies: ["DRAFT-1"] });
		expect(await findDependencyDefects(core)).toEqual({ selfDependencies: [], cycles: [] });
		const detail = await loadTaskDetail(core, (await core.filesystem.loadTask(root.id)) as Task);
		expect(detail.readiness.missingDependencies).toContain("DRAFT-1");
	});

	test("CLI create/replacement and native addition refuse archive-only IDs without changing existing task bytes", async () => {
		const { task: deleted } = await core.createTaskFromInput({ title: "Deleted" }, false);
		const { task: dependent } = await core.createTaskFromInput({ title: "Dependent" }, false);
		expect((await core.archiveTask(deleted.id, false)).success).toBe(true);
		const taskPath = (await core.filesystem.loadTask(dependent.id))?.filePath;
		if (!taskPath) throw new Error("Missing task fixture");
		const before = await Bun.file(taskPath).text();
		for (const args of [
			["task", "create", "Rejected", "--dep", deleted.id],
			["task", "edit", dependent.id, "--dep", deleted.id],
		]) {
			const result = await $`bun ${cliPath} ${args}`.cwd(directory).nothrow().quiet();
			expect(result.exitCode).not.toBe(0);
			expect(`${result.stdout}${result.stderr}`).toContain(`The following dependencies do not exist: ${deleted.id}`);
		}
		await expect(core.updateTaskFromInput(dependent.id, { addDependencies: [deleted.id] }, false)).rejects.toThrow(
			`The following dependencies do not exist: ${deleted.id}`,
		);
		expect(await Bun.file(taskPath).text()).toBe(before);
		expect((await core.filesystem.listTasks()).map((task) => task.id)).toEqual([dependent.id]);
	});
});
