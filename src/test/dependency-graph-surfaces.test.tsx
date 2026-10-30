import { describe, expect, it } from "bun:test";
import type { Task } from "../types/index.ts";
import { toTaskDetail } from "../core/task-detail.ts";
import { generateDetailContent, mergeDependencyCorpusTasks } from "../ui/task-viewer-with-search.ts";

const STATUSES = ["To Do", "In Progress", "Done"] as const;

function makeTask(id: string, title: string, dependencies: string[] = [], status = "To Do"): Task {
	return { id, title, status, assignee: [], createdDate: "2026-01-01", labels: [], dependencies };
}

const CORPUS = [
	makeTask("BACK-1", "Foundation", [], "Done"),
	makeTask("BACK-2", "Selected", ["BACK-1", "BACK-404"]),
	makeTask("BACK-3", "Follow up", ["BACK-2"]),
	makeTask("BACK-4", "Later", ["BACK-3"]),
];

// A detail read hands the viewer a task that already carries its graph; every other caller hands it
// a plain record. The viewer only renders what it was given.
function detailBody(task: Task, asDetail: boolean): string {
	const given = asDetail
		? toTaskDetail(task, { tasks: CORPUS, completedTasks: [], statuses: STATUSES })
		: task;
	return generateDetailContent(given).bodyContent.join("\n");
}

describe("TUI dependency graph section", () => {
	const selected = CORPUS[1] as Task;

	it("shows both directions with direct and transitive counts", () => {
		const body = detailBody(selected, true);

		expect(body).toContain("Dependency Graph");
		expect(body).toContain("Depends on (2 direct, 2 total):");
		expect(body).toContain("Dependents (1 direct, 2 total):");
		expect(body).toContain("└─ BACK-3 - Follow up [To Do]");
		expect(body).toContain("   └─ BACK-4 - Later [To Do]");
	});

	it("replaces the raw dependency ID list and sits directly above the description", () => {
		const body = detailBody(selected, true);

		// Same relative position as the canonical CLI plain output.
		expect(body).not.toContain("Dependencies:");
		expect(body.indexOf("Dependency Graph")).toBeLessThan(body.indexOf("Description"));
		expect(body.indexOf("Details")).toBeLessThan(body.indexOf("Dependency Graph"));
	});

	it("colors finished and unresolved nodes without changing the shared wording", () => {
		const body = detailBody(selected, true);

		expect(body).toContain("{gray-fg}BACK-1 - Foundation [completed]{/}");
		expect(body).toContain("{yellow-fg}BACK-404 - unknown task ID{/}");
	});

	it("renders a title containing blessed tag syntax as literal characters", () => {
		const styled = makeTask("BACK-7", "Style {red-fg}accent{/} braces");
		const root = makeTask("BACK-8", "Root", ["BACK-7"]);
		const detail = toTaskDetail(root, { tasks: [root, styled], completedTasks: [], statuses: STATUSES });
		const body = generateDetailContent(detail).bodyContent.join("\n");

		expect(body).toContain("BACK-7 - Style {open}red-fg{close}accent{open}/{close} braces [To Do]");
		expect(body).not.toContain("{red-fg}accent");
	});

	it("leaves the board quick-look popup and other graph-less callers unchanged", () => {
		// The popup passes no graph, so it renders exactly what it rendered before.
		expect(detailBody(selected, false)).not.toContain("Dependency Graph");
		expect(detailBody(selected, false)).not.toContain("Depends on");
	});

	it("omits the section for a task with no dependencies and no dependents", () => {
		const isolated = makeTask("BACK-9", "Alone");
		const detail = toTaskDetail(isolated, { tasks: [isolated], completedTasks: [], statuses: STATUSES });

		expect(generateDetailContent(detail).bodyContent.join("\n")).not.toContain("Dependency Graph");
	});
});

describe("filtered TUI dependency corpus merge", () => {
	it("lets a live display copy win over the snapshot for a uniquely claimed identity", () => {
		const snapshotTask = makeTask("BACK-1", "Foundation", [], "To Do");
		const outOfView = makeTask("BACK-2", "Elsewhere", ["BACK-1"]);
		const liveEdit = makeTask("BACK-1", "Foundation", [], "Done");

		const merged = mergeDependencyCorpusTasks([snapshotTask, outOfView], [liveEdit]);

		expect(merged).toHaveLength(2);
		expect(merged.find((task) => task.id === "BACK-1")?.status).toBe("Done");
		expect(merged.find((task) => task.id === "BACK-2")).toBe(outOfView);
	});

	it("keeps every claimant of a contested identity so the graph fails closed like the CLI", () => {
		const claimantA = makeTask("BACK-1", "First claimant", [], "Done");
		const claimantB = makeTask("BACK-1", "Second claimant");
		const root = makeTask("BACK-2", "Selected", ["BACK-1"]);

		const merged = mergeDependencyCorpusTasks([claimantA, claimantB, root], [root, claimantA]);
		expect(merged.filter((task) => task.id === "BACK-1")).toHaveLength(2);

		// The exact corpus the filtered viewer resolves, run through the shared graph: the contested
		// identity must be reported ambiguous, never silently collapsed to one claimant.
		const graph = toTaskDetail(root, {
			tasks: merged,
			completedTasks: [],
			statuses: STATUSES,
		}).dependencyGraph;
		expect(graph.nodes.find((node) => node.id === "BACK-1")?.state).toBe("ambiguous");
	});
});

describe("draft display dependency corpus", () => {
	it("never resolves or traverses displayed drafts, but resolves actual tasks and completed records in both directions", () => {
		const root = makeTask("DRAFT-2", "Selected draft", ["DRAFT-1", "TASK-1", "TASK-3"], "Draft");
		const otherDraft = makeTask("DRAFT-1", "Ineligible draft", ["TASK-4"], "Draft");
		const active = makeTask("TASK-1", "Actual predecessor", [], "Done");
		const dependent = makeTask("TASK-2", "Actual dependent", [root.id]);
		const completed = makeTask("TASK-3", "Completed predecessor", [], "Done");
		const unrelated = makeTask("TASK-4", "Behind draft");
		const draftDependent = makeTask("DRAFT-3", "Ineligible dependent", [root.id], "Draft");
		const eligible = [active, dependent, unrelated];
		const drafts = [root, otherDraft, draftDependent];
		const tasks = mergeDependencyCorpusTasks(eligible, drafts, true);
		expect(tasks).toBe(eligible);
		const detail = toTaskDetail(root, { tasks, completedTasks: [completed], statuses: STATUSES });
		expect(detail.readiness.missingDependencies).toEqual(["DRAFT-1"]);
		expect(detail.readiness.blockingDependencies).toEqual([]);
		expect(detail.dependencyGraph.nodes.find((node) => node.id === "DRAFT-1")?.state).toBe("missing");
		expect(detail.dependencyGraph.nodes.find((node) => node.id === "TASK-1")?.state).toBe("resolved");
		expect(detail.dependencyGraph.nodes.find((node) => node.id === "TASK-3")?.completed).toBe(true);
		expect(detail.dependencyGraph.nodes.find((node) => node.id === "TASK-2")?.dependentDepth).toBe(1);
		expect(detail.dependencyGraph.nodes.some((node) => ["TASK-4", "DRAFT-3"].includes(node.id))).toBe(false);
		const body = generateDetailContent(detail).bodyContent.join("\n");
		expect(body).toContain("DRAFT-1 - unknown task ID");
		expect(body).toContain("TASK-1 - Actual predecessor [completed]");
		expect(body).toContain("TASK-2 - Actual dependent [To Do]");
		expect(body).not.toContain("Ineligible dependent");
	});

	it("keeps actual-task ambiguity and cycles unchanged without admitting display drafts", () => {
		const first = makeTask("TASK-1", "First", ["TASK-2"]);
		const second = makeTask("TASK-2", "Second", ["TASK-1"]);
		const draft = makeTask("DRAFT-1", "Display only", ["TASK-1"], "Draft");
		const tasks = mergeDependencyCorpusTasks([first, second], [draft], true);
		const detail = toTaskDetail(first, { tasks, completedTasks: [], statuses: STATUSES });
		expect(detail.dependencyGraph.edges).toEqual([
			{ from: "TASK-1", to: "TASK-2" },
			{ from: "TASK-2", to: "TASK-1" },
		]);
		const ambiguous = toTaskDetail(draft, {
			tasks: mergeDependencyCorpusTasks([first, { ...first, title: "Duplicate" }], [draft], true),
			completedTasks: [],
			statuses: STATUSES,
		});
		expect(ambiguous.dependencyGraph.nodes.find((node) => node.id === first.id)?.state).toBe("ambiguous");
	});
});
