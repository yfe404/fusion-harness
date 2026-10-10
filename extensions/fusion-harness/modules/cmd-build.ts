/**
 * cmd-build.ts — the commands that hold the writer lease and build things.
 *
 * /fh-collaborate: every agent plans → the architect merges ONE delegation DAG →
 *   dependency-driven execution (parallel where the DAG allows, one write-enabled
 *   child at a time) → final architect integration.
 * /fh-auto-validate: gate-first loop — the VALIDATOR writes a uv acceptance gate
 *   BEFORE any build, the BUILDER builds against it, failures feed back verbatim,
 *   with validator triage/repair escalation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runChild, runProc } from "./child-runner.ts";
import { validateCollaborationPlan, type CollaborationTask, type ValidatedCollaborationPlan } from "./collaboration-graph.ts";
import { orderedSlots, slotId } from "./model-stack.ts";
import {
	builderPrompt,
	collabCoordinatePrompt,
	collabDelegatePrompt,
	collabExecutePrompt,
	collabProposePrompt,
	contractSystemPrompt,
	correctionPrompt,
	ensureGateMetadata,
	extractGateScript,
	parseStrictJsonObject,
	triagePrompt,
	triageSystem,
	validatorPrompt,
	validatorSystem,
} from "./prompt-library.ts";
import {
	clampCount,
	CUSTOM_TYPE,
	DETAIL_SNIPPET_MAX,
	FULL_TOOLS,
	GATE_TIMEOUT_MS,
	newRun,
	READONLY_TOOLS,
	runError,
	runOk,
	toStat,
	truncateChars,
	VALIDATOR_TOOLS,
	type AgentStat,
	type FhDetails,
	type HarnessDeps,
	type Role,
} from "./runtime.ts";
import { acquireWriterLease, type WriterLease } from "./writer-lease.ts";

// ═══ /fh-collaborate ═════════════════════════════════════════════════════════

export function registerCollaborateCommand(pi: ExtensionAPI, h: HarnessDeps): void {
	// No fixed deliberation choreography: each slot proposes how the work should be done,
	// the ARCHITECT turns those proposals into one delegation DAG, and the executor runs
	// on dependency READINESS — a task starts the moment its dependencies are done.
	// Independent tasks overlap (reads freely; writes one at a time through the global
	// writer token); dependent tasks form sequential paths. A slot may own several tasks —
	// its persistent session runs them one at a time. Every intermediate result renders:
	// proposals as an opinion-style grid, the plan as a task breakdown, and each finished
	// task as its own report panel. The live N-column grid streams for the whole command;
	// the task board is a separate belowEditor sub-widget.
	const TASKBOARD_WIDGET = `${CUSTOM_TYPE}-taskboard`;
	const MAX_TRANSIENT_TASK_RETRIES = 2;
	const isTransientChildFailure = (run: AgentRun): boolean =>
		run.status === "failed" &&
		/websocket closed (?:1000|1001|1006)|connection (?:reset|closed)|socket hang up|ECONNRESET|upstream.*(?:502|503|504)|(?:502|503|504).*upstream/i.test(runError(run));
	pi.registerCommand("fh-collaborate", {
		description:
			"Every agent plans read-only, the architect merges one delegation DAG, then tasks execute as dependencies clear — parallel where possible, exactly one shared-CWD writer at a time.",
		handler: async (raw, ctx) => {
			h.noteHost(ctx);
			const prompt = (raw ?? "").trim();
			if (!prompt) {
				ctx.ui.notify("Usage: /fh-collaborate <prompt>", "warning");
				return;
			}
			const stack = h.modelStack();
			const slots = orderedSlots(stack);
			const runs = slots.map(h.newSlotRun);
			const runBySlot = new Map(runs.map((run) => [run.slot!.id, run]));
			const startedAt = Date.now();
			const artifactsDir = await h.mkArtifacts();
			const collabDir = path.join(artifactsDir, "collaborate");
			await fs.promises.mkdir(collabDir, { recursive: true });
			await h.save(artifactsDir, "prompt.md", prompt);
			await h.save(artifactsDir, "stack.json", JSON.stringify(stack, null, 2));
			const initialSpawns = new Map(slots.map((slot) => [slot.id, h.slotInitialSpawn(slot, ctx, path.join(collabDir, "sessions", slot.id))]));
			h.panel({ kind: "prompt", command: "fh-collaborate", ok: true }, `/fh-collaborate ${prompt}`);
			h.panel({ kind: "banner", command: "fh-collaborate", ok: true, prompt, roles: slots.map((slot) => ({ role: (slot.architect ? "ARCHITECT" : "BUILDER") as Role, model: slot.model, slotId: slot.id, slotName: slot.name, color: slot.color, primary: slot.primary, architect: slot.architect })), artifactsDir }, "");
			const stopper = h.startStoppable(ctx, "fh-collaborate");
			// The streaming grid stays alive for the WHOLE command — planning, delegation,
			// and execution all show each model's live flow, exactly like the other commands.
			const stopWidget = h.startGridWidget(ctx, "fh-collaborate", runs, undefined, startedAt);
			let writerLease: WriterLease | undefined;
			let maxConcurrentWriteEnabledChildren = 0;
			let activeWriters = 0;
			const taskExecutions: Array<{ taskId: string; slot: string; mode: "read" | "write"; startedAt: number; endedAt: number; attempts: number; ok: boolean }> = [];
			let plan: ValidatedCollaborationPlan | undefined;
			try {
				// ── Phase 1: every slot PLANS the work independently, read-only ──
				ctx.ui.setStatus(CUSTOM_TYPE, `collaborate: ${slots.length} agents planning read-only…`);
				const proposalsDir = path.join(collabDir, "proposals");
				await fs.promises.mkdir(proposalsDir, { recursive: true });
				await Promise.all(runs.map(async (run) => {
					const slot = run.slot!;
					await runChild({ run, prompt: collabProposePrompt(slot, stack, prompt), systemPrompt: slot.systemPrompt, appendSystemPrompts: slot.appendSystemPrompts, tools: READONLY_TOOLS, thinking: slot.thinking, ...initialSpawns.get(slot.id)!, cwd: ctx.cwd, timeoutMs: h.childTimeoutMs(), signal: stopper.signal });
					await h.save(proposalsDir, `${slot.id}.md`, runOk(run) ? run.text : `FAILED: ${runError(run)}`);
				}));
				if (stopper.stopped()) {
					h.stoppedPanel("fh-collaborate", runs, artifactsDir, startedAt, "Stopped during planning; completed proposals remain on disk.");
					return;
				}
				// The proposals render like /fh-opinion — the intermediate step is part of the output.
				h.panel({ kind: "multi", command: "fh-collaborate", title: "⇄ PROPOSALS — how each agent would do the work", ok: runs.every(runOk), prompt, sources: runs.map(toStat), answers: runs.map((run) => ({ role: run.role, model: run.model, text: runOk(run) ? run.text : `FAILED: ${runError(run)}`, slotId: run.slot!.id, slotName: run.slot!.name, color: run.slot!.color, primary: run.slot!.primary })), artifactsDir, ...h.totals(runs, startedAt) }, runs.map((run) => `## ${run.slot!.name}\n${runOk(run) ? run.text : `FAILED: ${runError(run)}`}`).join("\n\n"));
				if (runs.filter(runOk).length < 2) {
					h.panel({ kind: "error", command: "fh-collaborate", ok: false, sources: runs.map(toStat), artifactsDir, ...h.totals(runs, startedAt) }, "Collaboration needs at least two successful plans.");
					return;
				}

				// ── Phase 2: the ARCHITECT merges the proposals into ONE delegation DAG ──
				const architectRun = runBySlot.get(stack.architect.id)!;
				const planPath = path.join(collabDir, "plan.json");
				let planError = "";
				for (let attempt = 1; attempt <= 3; attempt++) {
					ctx.ui.setStatus(CUSTOM_TYPE, `collaborate: architect merging plans into a delegation graph${attempt > 1 ? ` (repair ${attempt - 1})` : ""}…`);
					const delegatePrompt = collabDelegatePrompt(stack, prompt, collabDir, planPath) + (planError ? `\n\nPREVIOUS PLAN VALIDATION FAILED:\n${planError}\nRewrite the complete corrected plan.` : "");
					await runChild({ run: architectRun, prompt: delegatePrompt, systemPrompt: contractSystemPrompt(stack.architect.systemPrompt, "SYSTEM_PROMPT_COLLAB_COORDINATOR.md"), appendSystemPrompts: stack.architect.appendSystemPrompts, tools: READONLY_TOOLS, thinking: stack.architect.thinking, ...h.slotNextSpawn(stack.architect, architectRun, initialSpawns.get(stack.architect.id)!, ctx), cwd: ctx.cwd, timeoutMs: h.childTimeoutMs(), signal: stopper.signal });
					if (stopper.stopped()) {
						h.stoppedPanel("fh-collaborate", runs, artifactsDir, startedAt, "Stopped while the architect was producing the delegation graph.");
						return;
					}
					try {
						const parsedPlan = parseStrictJsonObject(architectRun.text, "delegation plan");
						// Models echo the roster's [MAIN]-style uppercase labels — normalize
						// assignees through slotId() so casing never costs a repair round.
						if (Array.isArray((parsedPlan as Record<string, unknown>).tasks)) {
							for (const rawTask of (parsedPlan as { tasks: unknown[] }).tasks) {
								if (rawTask && typeof rawTask === "object" && typeof (rawTask as Record<string, unknown>).assignee === "string") {
									(rawTask as Record<string, string>).assignee = slotId((rawTask as Record<string, string>).assignee);
								}
							}
						}
						plan = validateCollaborationPlan(parsedPlan, slots.map((slot) => slot.id));
						await fs.promises.writeFile(planPath, `${JSON.stringify(parsedPlan, null, 2)}\n`, "utf8");
						const assigned = new Set(plan.tasks.map((task) => task.assignee));
						const missing = slots.filter((slot) => !assigned.has(slot.id));
						if (missing.length) throw new Error(`plan must assign meaningful work to every slot; missing ${missing.map((slot) => slot.id).join(", ")}`);
						break;
					} catch (error) {
						planError = error instanceof Error ? error.message : String(error);
						plan = undefined;
					}
				}
				if (!plan) {
					h.panel({ kind: "error", command: "fh-collaborate", ok: false, agent: toStat(architectRun), artifactsDir }, `Architect could not produce a valid delegation graph after 3 attempts:\n${planError}`);
					return;
				}
				// The task breakdown is itself a deliverable — render it before executing.
				const planBody = [
					`### Delegation plan — ${plan.tasks.length} task${plan.tasks.length === 1 ? "" : "s"} · ${plan.waves.length} dependency level${plan.waves.length === 1 ? "" : "s"}`,
					"",
					"| task | owner | mode | depends on |",
					"|---|---|---|---|",
					...plan.tasks.map((task) => `| ${task.id} | ${task.assignee} | ${task.mode} | ${task.depends_on.join(", ") || "—"} |`),
					"",
					`Parallelism by level: ${plan.waves.map((wave, index) => `${index + 1}) ${wave.map((task) => task.id).join(" ∥ ")}`).join("  →  ")}`,
					"",
					...plan.tasks.map((task) => `- **${task.id}** (${task.assignee}, ${task.mode}) — ${task.description}`),
				].join("\n");
				h.panel({ kind: "solo", command: "fh-collaborate", ok: true, agent: toStat(architectRun), artifactsDir }, planBody);

				try {
					writerLease = acquireWriterLease(ctx.cwd, `/fh-collaborate ${path.basename(artifactsDir)}`);
				} catch (error) {
					h.panel({ kind: "error", command: "fh-collaborate", ok: false, sources: runs.map(toStat), artifactsDir }, error instanceof Error ? error.message : String(error));
					return;
				}

				// ── Phase 3: dependency-driven execution ──
				// A task launches the moment its deps are done AND its slot is free; reads
				// overlap anything, writes wait for the single global writer token (the
				// activeWriters increment is synchronous inside executeTask, so at most one
				// write-enabled child ever runs). Plan order is the FIFO tiebreak.
				const reportsDir = path.join(collabDir, "reports");
				await fs.promises.mkdir(reportsDir, { recursive: true });
				type TaskState = "blocked" | "queued" | "reading" | "writing" | "done" | "failed";
				const taskState = new Map<string, TaskState>(plan.tasks.map((task) => [task.id, "blocked"]));
				const taskReports = new Map<string, string>();
				const busySlots = new Set<string>();
				const inFlight = new Map<string, Promise<void>>();
				let executionFailure: string | undefined;
				const TASK_GLYPH: Record<TaskState, string> = { blocked: "○", queued: "◌", reading: "◐", writing: "●", done: "✓", failed: "✗" };
				const renderBoard = () => {
					try {
						ctx.ui.setWidget(TASKBOARD_WIDGET, [
							`⇄ TASKS · ${[...taskState.values()].filter((state) => state === "done").length}/${plan!.tasks.length} done · reads overlap · ONE writer at a time`,
							...plan!.tasks.map((task) => `  ${TASK_GLYPH[taskState.get(task.id)!]} ${task.id} · ${task.assignee} · ${task.mode} · ${taskState.get(task.id)} · ${task.description.replace(/\s+/g, " ").slice(0, 60)}${task.description.length > 60 ? "…" : ""}`),
						], { placement: "belowEditor" });
					} catch {}
				};
				const depsDone = (task: CollaborationTask): boolean => task.depends_on.every((dep) => taskState.get(dep) === "done");
				const taskHandoff = (task: CollaborationTask): string => {
					const parts = [`Collaboration artifacts: ${collabDir}`, `Delegation plan: ${planPath}`, `All finished task reports: ${reportsDir}`];
					for (const dep of task.depends_on) parts.push(`\n## COMPLETED DEPENDENCY ${dep}\n${taskReports.get(dep) ?? "(report on disk)"}`);
					return parts.join("\n");
				};
				const executeTask = async (task: CollaborationTask): Promise<void> => {
					const slot = slots.find((candidate) => candidate.id === task.assignee)!;
					const run = runBySlot.get(slot.id)!;
					const taskStartedAt = Date.now();
					const write = task.mode === "write";
					// Synchronous before the first await — the scheduler's writer check relies on it.
					if (write) {
						activeWriters++;
						maxConcurrentWriteEnabledChildren = Math.max(maxConcurrentWriteEnabledChildren, activeWriters);
					}
					let attempts = 0;
					try {
						while (true) {
							await runChild({ run, prompt: collabExecutePrompt(slot, prompt, task, taskHandoff(task)), systemPrompt: slot.systemPrompt, appendSystemPrompts: slot.appendSystemPrompts, tools: write ? FULL_TOOLS : READONLY_TOOLS, thinking: slot.thinking, ...h.slotNextSpawn(slot, run, initialSpawns.get(slot.id)!, ctx), cwd: ctx.cwd, timeoutMs: h.childTimeoutMs(), signal: stopper.signal });
							if (!isTransientChildFailure(run) || stopper.stopped() || attempts >= MAX_TRANSIENT_TASK_RETRIES || (!run.sessionRef && write)) break;
							attempts++;
							taskState.set(task.id, "queued");
							renderBoard();
							ctx.ui.setStatus(CUSTOM_TYPE, `collaborate: retrying ${task.id} (${attempts}/${MAX_TRANSIENT_TASK_RETRIES}) after ${runError(run)}…`);
							await new Promise(resolve => setTimeout(resolve, 1_000 * attempts));
							taskState.set(task.id, write ? "writing" : "reading");
						}
					} finally {
						if (write) activeWriters--;
					}
					const ok = runOk(run) && !stopper.stopped();
					taskExecutions.push({ taskId: task.id, slot: slot.id, mode: task.mode, startedAt: taskStartedAt, endedAt: Date.now(), attempts: attempts + 1, ok });
					const report = runOk(run) ? run.text : `FAILED: ${runError(run)}`;
					taskReports.set(task.id, report);
					await h.save(reportsDir, `${task.id}-${slot.id}.md`, report);
					taskState.set(task.id, ok ? "done" : "failed");
					if (!stopper.stopped()) {
						// Every finished task renders its report — the intermediate work IS the output.
						h.panel({ kind: "solo", command: "fh-collaborate", ok, agent: toStat(run), artifactsDir }, `### Task ${task.id} (${task.mode}) — ${slot.name}\n${task.description}\n\n${report}`);
						if (!ok) executionFailure ??= `task ${task.id} (${slot.id}) failed: ${runError(run)}`;
					}
				};
				ctx.ui.setStatus(CUSTOM_TYPE, "collaborate: executing the delegation graph…");
				renderBoard();
				while (!stopper.stopped()) {
					if (!executionFailure) {
						for (const task of plan.tasks) {
							const current = taskState.get(task.id)!;
							if (current !== "blocked" && current !== "queued") continue;
							if (!depsDone(task)) continue;
							if (busySlots.has(task.assignee) || (task.mode === "write" && activeWriters > 0)) {
								taskState.set(task.id, "queued");
								continue;
							}
							busySlots.add(task.assignee);
							taskState.set(task.id, task.mode === "read" ? "reading" : "writing");
							const running = executeTask(task).finally(() => {
								busySlots.delete(task.assignee);
								inFlight.delete(task.id);
							});
							inFlight.set(task.id, running);
						}
					}
					renderBoard();
					if (!inFlight.size) break;
					await Promise.race(inFlight.values());
				}
				await Promise.allSettled([...inFlight.values()]);
				renderBoard();
				if (stopper.stopped()) {
					h.stoppedPanel("fh-collaborate", runs, artifactsDir, startedAt, "Stopped during delegated execution; finished task reports remain on disk.");
					return;
				}
				if (executionFailure) {
					h.panel({ kind: "error", command: "fh-collaborate", ok: false, sources: runs.map(toStat), artifactsDir, ...h.totals(runs, startedAt) }, `Delegated execution halted: ${executionFailure}. Downstream tasks were not started.`);
					return;
				}

				// ── Phase 4: one final architect integration turn, still under the single-writer invariant ──
				ctx.ui.setStatus(CUSTOM_TYPE, "collaborate: final architect integration…");
				const finalStartedAt = Date.now();
				activeWriters++;
				maxConcurrentWriteEnabledChildren = Math.max(maxConcurrentWriteEnabledChildren, activeWriters);
				try {
					await runChild({ run: architectRun, prompt: collabCoordinatePrompt(prompt, reportsDir, planPath), systemPrompt: contractSystemPrompt(stack.architect.systemPrompt, "SYSTEM_PROMPT_COLLAB_COORDINATOR.md"), appendSystemPrompts: stack.architect.appendSystemPrompts, tools: FULL_TOOLS, thinking: stack.architect.thinking, ...h.slotNextSpawn(stack.architect, architectRun, initialSpawns.get(stack.architect.id)!, ctx), cwd: ctx.cwd, timeoutMs: h.childTimeoutMs(), signal: stopper.signal });
				} finally {
					activeWriters--;
				}
				taskExecutions.push({ taskId: "final", slot: stack.architect.id, mode: "write", startedAt: finalStartedAt, endedAt: Date.now(), attempts: 1, ok: runOk(architectRun) && !stopper.stopped() });
				if (stopper.stopped()) {
					h.stoppedPanel("fh-collaborate", runs, artifactsDir, startedAt, "Stopped during final architect integration.");
					return;
				}
				await h.save(collabDir, "final.md", runOk(architectRun) ? architectRun.text : `FAILED: ${runError(architectRun)}`);
				const worktreeCommandsObserved = runs.flatMap((run) => run.toolEvents).filter((event) => event.name === "bash" && /\bgit\s+worktree\b/.test(event.argument));
				const ok = runOk(architectRun) && maxConcurrentWriteEnabledChildren === 1 && worktreeCommandsObserved.length === 0;
				h.panel({ kind: "collab", command: "fh-collaborate", ok, round: plan.tasks.length, prompt, agent: toStat(architectRun), sources: runs.map(toStat), artifactsDir, ...h.totals(runs, startedAt) }, runOk(architectRun) ? architectRun.text : `Final coordination failed: ${runError(architectRun)}`);
				await h.save(artifactsDir, "summary.json", JSON.stringify({ command: "fh-collaborate", ok, plan, taskExecutions, maxConcurrentWriteEnabledChildren, worktreeCommandsObserved, writerLeasePath: writerLease?.path, agents: runs.map(toStat), sessions: Object.fromEntries(slots.map((slot) => [slot.id, runs.find((run) => run.slot?.id === slot.id)?.sessionRef ?? h.cachedSlotId(slot)])), ...h.totals(runs, startedAt) }, null, 2));
			} finally {
				const observedWorktrees = runs.flatMap((run) => run.toolEvents).filter((event) => event.name === "bash" && /\bgit\s+worktree\b/.test(event.argument));
				await h.ensureSummary(artifactsDir, { command: "fh-collaborate", ok: false, stopped: stopper.stopped(), plan, taskExecutions, maxConcurrentWriteEnabledChildren, worktreeCommandsObserved: observedWorktrees, writerLeasePath: writerLease?.path, agents: runs.map(toStat), sessions: Object.fromEntries(slots.map((slot) => [slot.id, runs.find((run) => run.slot?.id === slot.id)?.sessionRef ?? h.cachedSlotId(slot)])), ...h.totals(runs, startedAt) });
				writerLease?.release();
				stopper.release();
				stopWidget();
				try { ctx.ui.setWidget(TASKBOARD_WIDGET, undefined); } catch {}
				ctx.ui.setStatus(CUSTOM_TYPE, undefined);
			}
		},
	});
}

// ═══ /fh-auto-validate ═══════════════════════════════════════════════════════
// Gate-first validation loop (red → green):
//   1. VALIDATOR designs the acceptance gate (uv script) BEFORE any work happens.
//   2. Baseline gate run — expected FAIL (integrity check on the gate itself).
//   3. BUILDER builds against the visible, immutable gate.
//   4. Gate runs. FAIL → its output feeds back into the builder's persistent
//      session as correction instructions. PASS → done.
//   5. After --max-validations failed validations, development HALTS loudly.

const MAX_VALIDATIONS_DEFAULT = 5;
const ESCALATE_DEFAULT = 3;
const clampValidations = (n: number): number => clampCount(n, MAX_VALIDATIONS_DEFAULT);

/** A gate result that means "the gate itself could not run" — never the builder's fault. */
const gateHarnessError = (g: { code: number; output: string }): string | undefined => {
	if (g.code === 124 || g.output.includes("[gate timed out]")) return "the gate timed out (gates must finish in <60s)";
	if (g.code === 127 || /failed to spawn|spawn error/.test(g.output)) return "the gate could not be executed — is `uv` installed and on PATH?";
	return undefined;
};

export function registerAutoValidateCommand(pi: ExtensionAPI, h: HarnessDeps): void {
	pi.registerCommand("fh-auto-validate", {
		description:
			"Auto-validation loop: VALIDATOR designs a uv acceptance gate FIRST, BUILDER builds, the gate runs, failures feed back to the builder — until pass or --max-validations (default 5)",
		handler: async (raw, ctx) => {
			h.noteHost(ctx); // an unset --builder follows the host session's live model
			let input = (raw ?? "").trim();
			// Inline overrides of the startup flags: /fh-auto-validate --max-validations 3 --escalate-to-validator-count 2 <prompt>
			let maxV = clampValidations(Number.parseInt(h.flagStr("max-validations"), 10));
			let escalateAt = clampCount(Number.parseInt(h.flagStr("escalate-to-validator-count"), 10), ESCALATE_DEFAULT);
			input = input
				.replace(/--max-validations[=\s]+(\d+)\s*/g, (_m, n) => {
					maxV = clampValidations(Number.parseInt(n, 10));
					return "";
				})
				.replace(/--escalate-to-validator-count[=\s]+(\d+)\s*/g, (_m, n) => {
					escalateAt = clampCount(Number.parseInt(n, 10), ESCALATE_DEFAULT);
					return "";
				})
				.trim();
			if (!input) {
				ctx.ui.notify("Usage: /fh-auto-validate [--max-validations N] [--escalate-to-validator-count N] <prompt>", "warning");
				return;
			}
			const prompt = input;
			const aModel = h.architectModel();
			const bModel = h.builderModel();
			const startedAt = Date.now();
			const artifactsDir = await h.mkArtifacts();
			await h.save(artifactsDir, "prompt.md", prompt);

			h.panel({ kind: "prompt", command: "fh-auto-validate", ok: true }, `/fh-auto-validate ${(raw ?? "").trim()}`);
			h.panel(
				{
					kind: "banner",
					command: "fh-auto-validate",
					ok: true,
					prompt,
					maxRounds: maxV,
					escalateAt,
					roles: [
						{ role: "VALIDATOR", model: aModel },
						{ role: "BUILDER", model: bModel },
					],
					artifactsDir,
				},
				"",
			);

			const validator = newRun("VALIDATOR", aModel, h.modelStack().architect);
			const builder = newRun("BUILDER", bModel, h.modelStack().primaryBuilder);
			// Columns match the footer: VALIDATOR (architect-family) left, BUILDER right.
			// One builder AgentRun is reused across correction rounds — same persistent
			// session, cumulative tokens/cost, one accumulating flow column.
			const stopper = h.startStoppable(ctx, "auto-validate");
			const stopWidget = h.startWidget(ctx, "auto-validate", [validator, builder], undefined, startedAt);
			let writerLease: WriterLease | undefined;
			const fail = (agentStat: AgentStat, body: string, extra: Partial<FhDetails> = {}) => {
				const t = h.totals([validator, builder], startedAt);
				h.panel({ kind: "error", command: "fh-auto-validate", ok: false, agent: agentStat, artifactsDir, maxRounds: maxV, ...t, ...extra }, body);
			};

			try {
				try {
					writerLease = acquireWriterLease(ctx.cwd, `/fh-auto-validate ${path.basename(artifactsDir)}`);
				} catch (error) {
					fail(toStat(builder), error instanceof Error ? error.message : String(error));
					return;
				}
				// ── 1. VALIDATOR designs the gate (before any build) ──
				// The gate's transport is the FILESYSTEM: the harness dictates an absolute path and
				// the validator writes gate.py there with its own write tool. Nothing is parsed out
				// of the reply, so a gate whose own source contains ``` survives intact.
				const scriptPath = path.join(artifactsDir, "gate.py");
				ctx.ui.setStatus(CUSTOM_TYPE, "auto-validate: validator designing the gate…");
				await runChild({
					run: validator,
					prompt: validatorPrompt(prompt, ctx.cwd, scriptPath),
					systemPrompt: validatorSystem(scriptPath),
					tools: VALIDATOR_TOOLS,
					thinking: h.roleThinking("architect"),
					sessionDir: h.roleSession("architect", ctx.cwd).dir,
					sessionId: h.roleSession("architect", ctx.cwd).id,
					cwd: ctx.cwd,
					timeoutMs: h.childTimeoutMs(),
					signal: stopper.signal,
				});
				await h.save(artifactsDir, "validator.md", runOk(validator) ? validator.text : `FAILED: ${runError(validator)}`);
				// Prefer the file the validator wrote. Fence extraction is the legacy fallback,
				// used only when it pasted the gate inline instead (lossy — see extractGateScript).
				let script: string | undefined;
				let gateVia = "written to disk by the validator";
				if (runOk(validator)) {
					try {
						script = ensureGateMetadata(await fs.promises.readFile(scriptPath, "utf-8"));
					} catch {
						/* validator didn't write the file — fall back to the fence */
					}
					if (!script) {
						script = extractGateScript(validator.text);
						if (script) gateVia = "recovered from a code fence (legacy — truncates at an embedded ```)";
					}
				}
				if (stopper.stopped()) {
					h.stoppedPanel("auto-validate", [validator, builder], artifactsDir, startedAt, "The validator was killed while designing the gate; nothing was built.");
					return;
				}
				if (!script) {
					const stat = toStat(validator);
					if (!stat.error) stat.error = `did not write a uv gate script to ${scriptPath}`;
					fail(
						stat,
						`✗ VALIDATOR (${aModel}) failed to design the acceptance gate — nothing was built.\nExpected the gate at ${scriptPath}; no file was written and no fenced script was found in its reply.\n\n${validator.text || ""}`,
					);
					return;
				}
				// Only rewrite when the content differs (fence fallback, or injected metadata), so a
				// gate the validator wrote itself executes byte-for-byte as authored.
				let onDisk: string | undefined;
				try {
					onDisk = await fs.promises.readFile(scriptPath, "utf-8");
				} catch {
					/* not written yet */
				}
				if (onDisk !== script) await h.save(artifactsDir, "gate.py", script);
				validator.flow.push({ type: "tool", label: `gate.py — ${gateVia} (${script.length} bytes)` });

				// ── 2. Baseline gate run — must FAIL before the build (red) ──
				ctx.ui.setStatus(CUSTOM_TYPE, "auto-validate: baseline gate run (expected FAIL)…");
				const baseline = await runProc("uv", ["run", scriptPath], ctx.cwd, GATE_TIMEOUT_MS, stopper.signal);
				await h.save(artifactsDir, "gate-baseline.txt", `exit ${baseline.code}\n\n${baseline.output}`);
				validator.flow.push({ type: "tool", label: `uv run gate.py (baseline) → exit ${baseline.code}` });
				if (stopper.stopped()) {
					h.stoppedPanel("auto-validate", [validator, builder], artifactsDir, startedAt, "Stopped at the baseline gate run; nothing was built.");
					return;
				}
				const baselineHarnessErr = gateHarnessError(baseline);
				if (baselineHarnessErr) {
					const stat = toStat(validator);
					stat.error = `gate execution error: ${baselineHarnessErr}`;
					fail(stat, `✗ GATE ERROR — ${baselineHarnessErr}\n\nNothing was built. Gate output:\n\`\`\`\n${truncateChars(baseline.output.trim(), DETAIL_SNIPPET_MAX)}\n\`\`\``);
					return;
				}
				const baselineNote =
					baseline.code === 0
						? `### ⚠ BASELINE WARNING\nThe gate already PASSES before any work was done — either the request is already satisfied or the gate is too weak. Proceeding to build anyway; treat a first-round pass with suspicion.`
						: `### Baseline run — RED ✓ (exit ${baseline.code}, expected)\nThe gate correctly fails against the current state — the loop is live.\n\`\`\`\n${truncateChars(baseline.output.trim() || "(no output)", DETAIL_SNIPPET_MAX)}\n\`\`\``;
				h.panel(
					{
						kind: "gate",
						command: "fh-auto-validate",
						ok: true,
						agent: toStat(validator),
						maxRounds: maxV,
						script: truncateChars(script, DETAIL_SNIPPET_MAX),
						gateExitCode: baseline.code,
						scriptPath,
						artifactsDir,
					},
					[`### Acceptance gate (designed by VALIDATOR before the build; immutable)`, "```python", script.trim(), "```", baselineNote].join("\n"),
				);

				// ── 3. Build → validate loop ──
				// Round 1 forks the host session (the builder IS the host's agent lineage);
				// later rounds resume that same fork so the loop keeps its working memory.
				let lastGate: { code: number; output: string } | undefined;
				const gateHistory: Array<{ round: number; code: number; output: string }> = [];
				let pendingTriage: string | undefined;
				let pendingGateUpdate: string | undefined; // repaired gate → next correction prompt (round-1 copy is stale)
				let gateRepairUsed = false; // ONE repair per run — the grader never gets to keep moving goalposts
				const firstSpawn = h.builderSpawn(ctx, artifactsDir);
				for (let round = 1; round <= maxV; round++) {
					const triageBrief = pendingTriage;
					pendingTriage = undefined;
					const gateUpdate = pendingGateUpdate;
					pendingGateUpdate = undefined;
					const spawn =
						round === 1
							? firstSpawn
							: builder.sessionRef
								? { sessionDir: firstSpawn.sessionDir, resume: builder.sessionRef }
								: firstSpawn;
					ctx.ui.setStatus(CUSTOM_TYPE, `auto-validate: builder — round ${round}/${maxV}…`);
					await runChild({
						run: builder,
						prompt: round === 1 ? builderPrompt(prompt, script) : correctionPrompt(round, maxV, lastGate!.code, lastGate!.output, triageBrief, gateUpdate),
						systemPrompt: h.roleSystemPrompt("builder"),
						appendSystemPrompts: h.modelStack().primaryBuilder.appendSystemPrompts,
						tools: FULL_TOOLS,
						thinking: h.roleThinking("builder"),
						...spawn,
						cwd: ctx.cwd,
						timeoutMs: h.buildTimeoutMs(),
						signal: stopper.signal,
					});
					await h.save(artifactsDir, `builder-round-${round}.md`, runOk(builder) ? builder.text : `FAILED: ${runError(builder)}`);
					// Check the stop BEFORE blaming the builder: an escape-killed child is !runOk,
					// and reporting "BUILDER failed" for a user-initiated stop is a lie.
					if (stopper.stopped()) {
						h.stoppedPanel("auto-validate", [validator, builder], artifactsDir, startedAt, `Stopped during build round ${round}/${maxV}; the gate was not re-run.`);
						return;
					}
					if (!runOk(builder)) {
						fail(
							toStat(builder),
							`✗ BUILDER (${bModel}) failed during round ${round}/${maxV} — the loop cannot continue.\n\n${builder.text || ""}`,
							{ round, sources: [toStat(validator)] },
						);
						return;
					}

					ctx.ui.setStatus(CUSTOM_TYPE, `auto-validate: gate — validation ${round}/${maxV}…`);
					lastGate = await runProc("uv", ["run", scriptPath], ctx.cwd, GATE_TIMEOUT_MS, stopper.signal);
					await h.save(artifactsDir, `gate-round-${round}.txt`, `exit ${lastGate.code}\n\n${lastGate.output}`);
					validator.flow.push({ type: "tool", label: `uv run gate.py (round ${round}) → exit ${lastGate.code}` });
					if (stopper.stopped()) {
						h.stoppedPanel("auto-validate", [validator, builder], artifactsDir, startedAt, `Stopped at the gate run for round ${round}/${maxV}.`);
						return;
					}
					const harnessErr = gateHarnessError(lastGate);
					if (harnessErr) {
						const stat = toStat(validator);
						stat.error = `gate execution error: ${harnessErr}`;
						fail(stat, `✗ GATE ERROR during validation ${round}/${maxV} — ${harnessErr}\n\nGate output:\n\`\`\`\n${truncateChars(lastGate.output.trim(), DETAIL_SNIPPET_MAX)}\n\`\`\``, { round });
						return;
					}

					const ok = lastGate.code === 0;
					const t = h.totals([validator, builder], startedAt);
					const gateBody = [
						`### Gate run — ${ok ? "PASS (exit 0)" : `FAIL (exit ${lastGate.code})`}`,
						"```",
						truncateChars(lastGate.output.trim() || "(no output)", DETAIL_SNIPPET_MAX * 2),
						"```",
						ok && baseline.code === 0 ? `⚠ Note: the gate also passed at baseline — verify the result yourself.` : "",
					].join("\n");
					const builderBody = `### Builder report — round ${round}\n${builder.text}`;
					h.panel(
						{
							kind: "validation",
							command: "fh-auto-validate",
							ok,
							round,
							maxRounds: maxV,
							agent: toStat(validator),
							sources: [toStat(validator), toStat(builder)],
							answers: [
								{ role: "VALIDATOR", model: aModel, text: gateBody },
								{ role: "BUILDER", model: bModel, text: builderBody },
							],
							gateOutput: truncateChars(lastGate.output, DETAIL_SNIPPET_MAX),
							gateExitCode: lastGate.code,
							scriptPath,
							artifactsDir,
							...t,
						},
						`${builderBody}\n\n${gateBody}`,
					);
					if (ok) {
						await h.save(
							artifactsDir,
							"summary.json",
							JSON.stringify(
								{ command: "fh-auto-validate", ok: true, rounds: round, maxValidations: maxV, escalateAt, gateExitCode: 0, agents: [toStat(validator), toStat(builder)], sessions: { architect: validator.sessionRef ?? h.cachedRoleId("architect"), builder: builder.sessionRef ?? h.cachedRoleId("builder") }, ...t },
								null,
								2,
							),
						);
						return;
					}

					// ── Escalation: on the Nth failure, the VALIDATOR diagnoses why the builder is stuck ──
					gateHistory.push({ round, code: lastGate.code, output: lastGate.output });
					if (round >= escalateAt && round < maxV) {
						ctx.ui.setStatus(CUSTOM_TYPE, `auto-validate: ⚡ validator triage (failure ${round}/${maxV})…`);
						// Snapshot the gate as it sits on disk BEFORE triage — the repair detector
						// compares content, not the brief's wording.
						let gateBefore = script;
						try {
							gateBefore = await fs.promises.readFile(scriptPath, "utf-8");
						} catch {
							/* keep the in-memory copy */
						}
						await runChild({
							run: validator,
							prompt: triagePrompt(prompt, round, maxV, builder.text, gateHistory, artifactsDir),
							systemPrompt: triageSystem(scriptPath),
							// Repair power is enforced by TOOLS, not trust: while the run's single
							// repair is unused, triage holds the validator's write (one dictated
							// path); once spent, it drops back to strictly read-only eyes.
							tools: gateRepairUsed ? READONLY_TOOLS : VALIDATOR_TOOLS,
							thinking: h.roleThinking("architect"),
							sessionDir: h.roleSession("architect", ctx.cwd).dir,
							sessionId: h.roleSession("architect", ctx.cwd).id,
							cwd: ctx.cwd,
							timeoutMs: h.childTimeoutMs(),
							signal: stopper.signal,
						});
						await h.save(artifactsDir, `triage-round-${round}.md`, runOk(validator) ? validator.text : `FAILED: ${runError(validator)}`);
						if (runOk(validator)) {
							pendingTriage = validator.text;
							h.panel(
								{
									kind: "triage",
									command: "fh-auto-validate",
									ok: true,
									round,
									maxRounds: maxV,
									escalateAt,
									agent: toStat(validator),
									artifactsDir,
								},
								validator.text,
							);

							// ── Gate repair: triage rewrote a defective gate (once per run) ──
							if (!gateRepairUsed) {
								let gateAfter: string | undefined;
								try {
									gateAfter = await fs.promises.readFile(scriptPath, "utf-8");
								} catch {
									/* unreadable — treat as unchanged */
								}
								if (gateAfter?.trim() && gateAfter !== gateBefore) {
									gateRepairUsed = true;
									await h.save(artifactsDir, `gate.py.r${round}`, gateBefore); // the defective gate, preserved for audit
									script = ensureGateMetadata(gateAfter) ?? gateAfter;
									if (script !== gateAfter) await h.save(artifactsDir, "gate.py", script);
									pendingGateUpdate = script;
									validator.flow.push({ type: "tool", label: `gate.py REPAIRED (defect) — old gate saved as gate.py.r${round}` });

									// The repaired gate re-runs IMMEDIATELY, on the house: a gate defect
									// was never the builder's failure, so it costs no correction round.
									ctx.ui.setStatus(CUSTOM_TYPE, "auto-validate: gate repaired — free re-run…");
									const rerun = await runProc("uv", ["run", scriptPath], ctx.cwd, GATE_TIMEOUT_MS, stopper.signal);
									await h.save(artifactsDir, `gate-repair-round-${round}.txt`, `exit ${rerun.code}\n\n${rerun.output}`);
									validator.flow.push({ type: "tool", label: `uv run gate.py (post-repair) → exit ${rerun.code}` });
									if (stopper.stopped()) {
										h.stoppedPanel("auto-validate", [validator, builder], artifactsDir, startedAt, `Stopped at the post-repair gate run (round ${round}/${maxV}).`);
										return;
									}
									const rerunHarnessErr = gateHarnessError(rerun);
									if (rerunHarnessErr) {
										const stat = toStat(validator);
										stat.error = `gate execution error: ${rerunHarnessErr}`;
										fail(stat, `✗ GATE ERROR on the post-repair run — ${rerunHarnessErr}\n\nGate output:\n\`\`\`\n${truncateChars(rerun.output.trim(), DETAIL_SNIPPET_MAX)}\n\`\`\``, { round });
										return;
									}
									h.panel(
										{
											kind: "gate",
											command: "fh-auto-validate",
											ok: rerun.code === 0,
											round,
											maxRounds: maxV,
											agent: toStat(validator),
											script: truncateChars(script, DETAIL_SNIPPET_MAX),
											gateExitCode: rerun.code,
											scriptPath,
											artifactsDir,
										},
										[
											`### ⚒ Gate REPAIRED by VALIDATOR — defect fixed after round ${round} (old gate: gate.py.r${round} · one repair per run)`,
											"```python",
											script.trim(),
											"```",
											rerun.code === 0
												? `### Post-repair run — GREEN ✓ (exit 0, no builder round consumed)\n\`\`\`\n${truncateChars(rerun.output.trim() || "(no output)", DETAIL_SNIPPET_MAX)}\n\`\`\``
												: `### Post-repair run — still RED (exit ${rerun.code}) — these are now the REAL failures\n\`\`\`\n${truncateChars(rerun.output.trim() || "(no output)", DETAIL_SNIPPET_MAX)}\n\`\`\``,
										].join("\n"),
									);
									if (rerun.code === 0) {
										// The build was right all along — the gate was the bug. End green.
										const tt = h.totals([validator, builder], startedAt);
										const gateBody2 = `### Gate run — PASS (exit 0, post-repair)\n\`\`\`\n${truncateChars(rerun.output.trim() || "(no output)", DETAIL_SNIPPET_MAX * 2)}\n\`\`\``;
										const builderBody2 = `### Builder report — round ${round}\n${builder.text}`;
										h.panel(
											{
												kind: "validation",
												command: "fh-auto-validate",
												ok: true,
												round,
												maxRounds: maxV,
												agent: toStat(validator),
												sources: [toStat(validator), toStat(builder)],
												answers: [
													{ role: "VALIDATOR", model: aModel, text: gateBody2 },
													{ role: "BUILDER", model: bModel, text: builderBody2 },
												],
												gateOutput: truncateChars(rerun.output, DETAIL_SNIPPET_MAX),
												gateExitCode: 0,
												scriptPath,
												artifactsDir,
												...tt,
											},
											`${builderBody2}\n\n${gateBody2}`,
										);
										await h.save(
											artifactsDir,
											"summary.json",
											JSON.stringify(
												{ command: "fh-auto-validate", ok: true, rounds: round, gateRepaired: true, maxValidations: maxV, escalateAt, gateExitCode: 0, agents: [toStat(validator), toStat(builder)], sessions: { architect: validator.sessionRef ?? h.cachedRoleId("architect"), builder: builder.sessionRef ?? h.cachedRoleId("builder") }, ...tt },
												null,
												2,
											),
										);
										return;
									}
									// Still red on a now-sound gate: those failures are real — hand them
									// to the next correction round.
									lastGate = rerun;
									gateHistory.push({ round, code: rerun.code, output: rerun.output });
								}
							}
						} else {
							// Triage is an enhancement — a failed triage never blocks the loop.
							validator.flow.push({ type: "tool", label: `triage failed (${runError(validator)}) — continuing with raw gate output` });
						}
					}
				}

				// ── 4. Max validations exhausted — halt loudly ──
				const stat = toStat(builder);
				stat.error = `gate still failing after ${maxV}/${maxV} validations`;
				fail(
					stat,
					[
						`## ✗ HALTED — development stopped after ${maxV}/${maxV} validations`,
						`The acceptance gate is still failing. No further corrections will be attempted.`,
						``,
						`### Last gate output (exit ${lastGate?.code ?? "?"})`,
						"```",
						truncateChars(lastGate?.output.trim() || "(no output)", DETAIL_SNIPPET_MAX),
						"```",
						``,
						`Raise the cap with \`--max-validations N\` (startup flag or inline) or inspect the artifacts: ${artifactsDir}`,
					].join("\n"),
					{ round: maxV },
				);
				await h.save(
					artifactsDir,
					"summary.json",
					JSON.stringify(
						{ command: "fh-auto-validate", ok: false, halted: true, rounds: maxV, maxValidations: maxV, escalateAt, gateExitCode: lastGate?.code, agents: [toStat(validator), toStat(builder)], sessions: { architect: validator.sessionRef ?? h.cachedRoleId("architect"), builder: builder.sessionRef ?? h.cachedRoleId("builder") }, ...h.totals([validator, builder], startedAt) },
						null,
						2,
					),
				);
			} finally {
				await h.ensureSummary(artifactsDir, { command: "fh-auto-validate", ok: false, stopped: stopper.stopped(), agents: [toStat(validator), toStat(builder)], sessions: { architect: validator.sessionRef ?? h.cachedRoleId("architect"), builder: builder.sessionRef ?? h.cachedRoleId("builder") }, ...h.totals([validator, builder], startedAt) });
				writerLease?.release();
				stopper.release(); // never leave the escape tap installed past the command
				stopWidget();
				ctx.ui.setStatus(CUSTOM_TYPE, undefined);
			}
		},
	});
}
