/**
 * fusion-harness — FUSE 2-5 frontier models instead of racing them. AND, not OR.
 *
 * Model stack: exactly one ARCHITECT, exactly one primary/Main BUILDER (the live
 * raw-chat host), and up to three secondary builders. Explicit YAML via --fh-config;
 * legacy two-slot flags remain compatible.
 *
 * Commands:
 *   /fh-opinion      N independent read-only opinions            (modules/cmd-readonly.ts)
 *   /fh-debate       N-way all-to-all debate, no judge           (modules/cmd-readonly.ts)
 *   /fh-fusion       N sources → sole-writer FUSION → ACKs       (modules/cmd-fusion.ts)
 *   /fh-collaborate  plans → architect DAG → readiness execution (modules/cmd-build.ts)
 *   /fh-auto-validate architect + Main gate-first build loop     (modules/cmd-build.ts)
 *   /fh-only         direct one slot or arm the next plain prompt
 *   /fh-model        slot → model → thinking picker (session-only)
 *   /fh-system-prompt · /fh-reset · /fh model-bar front door
 *
 * This file is the extension FACTORY: flags/config and stack resolution, host-model
 * selection, persistent slot sessions, live widgets + the model bar, panel plumbing,
 * and the small in-place commands. The heavy lifting lives in modules/:
 *   runtime.ts        shared types, constants, formatting, the HarnessDeps seam
 *   child-runner.ts   clean-room `pi --mode json -p` child processes
 *   prompt-library.ts every model contract (templates under prompts/)
 *   tui.ts            layout primitives, labels, live columns, the panel renderer
 *   cmd-*.ts          the orchestration commands, wired through HarnessDeps
 *
 * Safety invariant: parallel agents never mutate the same checkout. Opinion, debate,
 * fusion sources, and collaboration planning are tool-enforced read-only. The temporary
 * FUSION agent is the only /fh-fusion writer. Collaboration serializes every write-enabled
 * task through one shared-CWD writer token; no worktrees.
 *
 * UI: responsive AgentGrid (columns when >=34 cells each, otherwise vertical stack) and
 * an opt-in one-row-per-slot belowEditor model bar. Pi's default footer is REMOVED at
 * TUI session start — the harness runs footerless unless the model bar is toggled on.
 *
 * Every child is a clean-room `pi --mode json -p` subprocess. Artifacts live under
 * /tmp/fusion-harness-* and persistent slot/model sessions under
 * /tmp/fusion-harness-sessions/.
 */

import { createHash, randomUUID } from "node:crypto"; // persistent session ids + project hashes
import * as fs from "node:fs"; // artifacts, session manifests
import * as os from "node:os"; // tmpdir fallback when /tmp is missing
import * as path from "node:path"; // every artifact/session path
import { performance } from "node:perf_hooks"; // host-turn TPS boundaries
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { registerAutoValidateCommand, registerCollaborateCommand } from "./modules/cmd-build.ts";
import { registerFusionCommand } from "./modules/cmd-fusion.ts";
import { registerReadonlyCommands } from "./modules/cmd-readonly.ts";
import { childExtensionArgs, piInvocation, runChild } from "./modules/child-runner.ts";
import {
	cloneStack,
	loadModelStack,
	orderedSlots,
	resolveThinking as resolveStackThinking,
	synthesizeLegacyStack,
	type ModelSlot,
	type ModelStack,
	type Thinking,
} from "./modules/model-stack.ts";
import {
	ANSWER_MAX_BYTES,
	BOOT_TYPE,
	CUSTOM_TYPE,
	FULL_TOOLS,
	fmtSecs,
	modelTag,
	newRun,
	fgHex,
	ROLE_COLOR,
	runError,
	runOk,
	THINKING_SHORT,
	toStat,
	truncateBytes,
	type AgentRun,
	type FhDetails,
	type HarnessDeps,
	type Role,
	type SpawnIdentity,
} from "./modules/runtime.ts";
import { AgentGrid, cellStr, FullWidth, liveColumn, renderFhPanel, TwoCol } from "./modules/tui.ts";
import { acquireWriterLease, type WriterLease } from "./modules/writer-lease.ts";

// ═══ 1. Defaults ═════════════════════════════════════════════════════════════

const DEFAULT_ARCHITECT = "anthropic/claude-fable-5"; // plans, fuses, validates
const DEFAULT_BUILDER = "openai/gpt-5.6-sol"; // last-resort builder — an unset --builder normally follows the HOST session's model

const CHILD_TIMEOUT_S_DEFAULT = 28_800; // 8h — every spawned child; real work runs for hours (--child-timeout overrides)
const BUILD_TIMEOUT_MS_FLOOR = 28_800_000; // /fh-auto-validate builder floor — never below 8h even with a small --child-timeout
const WIDGET_TICK_MS = 1_000; // live-widget refresh cadence

// ═══ 2. Extension ════════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI) {
	// ── 2.1 Flags ──────────────────────────────────────────────
	pi.registerFlag("fh-config", {
		type: "string",
		description: "Explicit path to .pi/fusion-harness/model-stack-<codename>.yaml (2-5 slots, exactly one architect and one primary builder).",
	});
	pi.registerFlag("architect", {
		type: "string",
		description: `ARCHITECT model (provider/id) — legacy two-slot mode. Default ${DEFAULT_ARCHITECT}.`,
	});
	pi.registerFlag("builder", {
		type: "string",
		description: `BUILDER model (provider/id) — builds. Default ${DEFAULT_BUILDER}.`,
	});
	pi.registerFlag("max-validations", {
		type: "string",
		description: "Max gate validations (build attempts) for /fh-auto-validate before development halts. Default 5. Also overridable inline: /fh-auto-validate --max-validations 3 <prompt>.",
	});
	pi.registerFlag("escalate-to-validator-count", {
		type: "string",
		description:
			"On the Nth gate failure, escalate: the VALIDATOR inspects the builder's work and writes a directed triage brief that accompanies the raw gate output. Default 3. Inline-overridable per command.",
	});
	pi.registerFlag("architect-system-prompt", {
		type: "string",
		description:
			"Override the system prompt for ARCHITECT-family worker/fh-fusion agents (inline text, or a path to a file). VALIDATOR/TRIAGE keep their SYSTEM_PROMPT_*.md contracts — edit those files to tune them.",
	});
	pi.registerFlag("builder-system-prompt", {
		type: "string",
		description: "Override the system prompt for all BUILDER agents (inline text, or a path to a file).",
	});
	pi.registerFlag("architect-thinking", {
		type: "string",
		description: "Thinking level for EVERY architect-family execution (worker/fh-fusion/validator/triage): off|minimal|low|medium|high|xhigh|max. Default medium.",
	});
	pi.registerFlag("builder-thinking", {
		type: "string",
		description: "Thinking level for EVERY builder execution: off|minimal|low|medium|high|xhigh|max. Default medium.",
	});
	pi.registerFlag("rounds", {
		type: "string",
		description:
			"Round count for /fh-debate (clamp 1-10; default 3, minimum 2). Inline-overridable: /fh-debate --rounds 2 <prompt>.",
	});
	pi.registerFlag("child-timeout", {
		type: "string",
		description:
			"Timeout in SECONDS for every spawned child agent (/fh-opinion + /fh-fusion workers, the FUSION merge, /fh-auto-validate builder rounds and validator). Default 28800 (8h), clamp 10-86400 (24h); the /fh-auto-validate builder never drops below the 8h floor. Real work runs for hours — don't starve it.",
	});

	// ── 2.2 Flag readers + configured stack ────────────────────

	/** A string flag's trimmed value, or "" when unset. */
	const flagStr = (name: string): string => {
		const v = pi.getFlag(name);
		return typeof v === "string" ? v.trim() : "";
	};
	// Pi resolves extension flags after the factory registers them. process.argv lets the
	// config schema fail during extension load as requested, while getFlag remains canonical
	// for normal lazy reads.
	const rawCliFlag = (name: string): string => {
		const long = `--${name}`;
		for (let i = 0; i < process.argv.length; i++) {
			if (process.argv[i] === long) return process.argv[i + 1]?.trim() ?? "";
			if (process.argv[i].startsWith(`${long}=`)) return process.argv[i].slice(long.length + 1).trim();
		}
		return "";
	};
	// Custom extension flags are populated after the factory registers them, so config loading
	// must be lazy (session_start / first command), not eager during factory evaluation.
	let configLoaded = false;
	let configuredStack: ModelStack | undefined;
	let stackReadyError: string | undefined;
	const ensureConfigLoaded = () => {
		if (configLoaded) return;
		configLoaded = true;
		const configPath = flagStr("fh-config") || rawCliFlag("fh-config");
		if (!configPath) return;
		const conflicts = ["architect", "builder", "architect-thinking", "builder-thinking", "architect-system-prompt", "builder-system-prompt"].filter((name) => flagStr(name) || rawCliFlag(name));
		if (conflicts.length) {
			stackReadyError = `fusion-harness: --fh-config cannot be combined with legacy role flags: ${conflicts.map((name) => `--${name}`).join(", ")}`;
			throw new Error(stackReadyError);
		}
		try {
			configuredStack = cloneStack(loadModelStack(configPath));
		} catch (error) {
			stackReadyError = error instanceof Error ? error.message : String(error);
			throw error;
		}
	};
	if (rawCliFlag("fh-config")) {
		try {
			ensureConfigLoaded();
		} catch (error) {
			process.exitCode = 1;
			throw error;
		}
	}
	const architectModel = () => {
		ensureConfigLoaded();
		return configuredStack?.architect.model ?? (flagStr("architect") || DEFAULT_ARCHITECT);
	};

	/**
	 * The HOST's live model (`provider/id`), refreshed from whatever context we're handed.
	 * The BUILDER *is* the host's agent, so an unset --builder should follow the session you
	 * actually launched — not a hardcoded vendor default. That makes the harness runnable with
	 * ONE flag: set --architect (the fusion model) and the builder rides pi's own default.
	 */
	let hostModel: string | undefined;
	const noteHost = (ctx: any): void => {
		ensureConfigLoaded();
		if (stackReadyError) throw new Error(stackReadyError);
		try {
			if (ctx?.model?.provider && ctx?.model?.id) hostModel = `${ctx.model.provider}/${ctx.model.id}`;
		} catch {
			/* no model on this context — keep the last known one */
		}
	};
	// Precedence: explicit --builder > the host session's live model > the shipped default.
	const builderModel = () => {
		ensureConfigLoaded();
		return configuredStack?.primaryBuilder.model ?? (flagStr("builder") || hostModel || DEFAULT_BUILDER);
	};

	/** --<role>-system-prompt: inline text, or a file path (file contents win if it exists). */
	const roleSystemPrompt = (role: "architect" | "builder"): string | undefined => {
		ensureConfigLoaded();
		if (configuredStack) return role === "architect" ? configuredStack.architect.systemPrompt : configuredStack.primaryBuilder.systemPrompt;
		const v = flagStr(`${role}-system-prompt`);
		if (!v) return undefined;
		try {
			if (fs.existsSync(v) && fs.statSync(v).isFile()) return fs.readFileSync(v, "utf-8");
		} catch {
			/* treat as inline text */
		}
		return v;
	};

	/**
	 * pi's own buildSystemPrompt(), for /fh-system-prompt: when a role has no override, the
	 * prompt its children actually run with is pi's DEFAULT — which the package builds at
	 * spawn time and does not re-export from its main entry. Import it straight from the
	 * running pi installation's dist (a file URL bypasses the "exports" map); a bun-compiled
	 * binary has no real dist on disk, so this resolves undefined and the caller falls back.
	 */
	let buildSystemPromptLoad: Promise<((o: Record<string, unknown>) => string) | undefined> | undefined;
	const loadBuildSystemPrompt = (): Promise<((o: Record<string, unknown>) => string) | undefined> => {
		buildSystemPromptLoad ??= (async () => {
			try {
				const script = process.argv[1];
				if (!script || script.startsWith("/$bunfs/")) return undefined;
				const real = await fs.promises.realpath(script);
				const mod = await import(new URL(`file://${path.join(path.dirname(real), "core", "system-prompt.js")}`).href);
				return typeof mod.buildSystemPrompt === "function" ? mod.buildSystemPrompt : undefined;
			} catch {
				return undefined;
			}
		})();
		return buildSystemPromptLoad;
	};

	/** --child-timeout: seconds before ANY spawned child agent is killed. Default 28800 (8h), clamp 10-86400 (24h). */
	const childTimeoutMs = (): number => {
		const v = Number.parseInt(flagStr("child-timeout"), 10);
		const s = Number.isFinite(v) && v > 0 ? Math.max(10, Math.min(v, 86_400)) : CHILD_TIMEOUT_S_DEFAULT;
		return s * 1000;
	};
	/** The /fh-auto-validate builder does real work — never below the 8h floor, even with a small --child-timeout. */
	const buildTimeoutMs = (): number => Math.max(childTimeoutMs(), BUILD_TIMEOUT_MS_FLOOR);

	/** --<role>-thinking: one thinking level for EVERY execution of that model. Default medium. */
	const THINKING_LEVELS: Thinking[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	/**
	 * Accept BOTH the canonical level and the short form the footer prints (`high` and `hi`,
	 * `medium` and `med`, `off` and `none`, …). The footer only ever shows the short form, so
	 * refusing it would mean rejecting the exact word the UI just displayed.
	 */
	const THINKING_ALIAS: Record<string, Thinking> = {};
	for (const level of THINKING_LEVELS) {
		THINKING_ALIAS[level] = level;
		const short = THINKING_SHORT[level];
		if (short) THINKING_ALIAS[short] = level;
	}
	const resolveThinking = (raw: string): Thinking | undefined => THINKING_ALIAS[raw.trim().toLowerCase()];

	/** Legacy role-thinking overrides; configured stacks use per-slot values and /fh-model. */
	const thinkingOverride: Partial<Record<"architect" | "builder", Thinking>> = {};
	const roleThinking = (role: "architect" | "builder"): Thinking => {
		ensureConfigLoaded();
		if (configuredStack) return role === "architect" ? configuredStack.architect.thinking : configuredStack.primaryBuilder.thinking;
		const override = thinkingOverride[role];
		if (override) return override;
		// The boot flags take the same aliases, so `--architect-thinking hi` works too.
		return resolveThinking(flagStr(`${role}-thinking`)) ?? "medium";
	};

	const modelStack = (): ModelStack => {
		ensureConfigLoaded();
		return configuredStack ??
		synthesizeLegacyStack({
			architectModel: architectModel(),
			builderModel: builderModel(),
			architectThinking: roleThinking("architect"),
			builderThinking: roleThinking("builder"),
			architectSystemPrompt: roleSystemPrompt("architect"),
			builderSystemPrompt: roleSystemPrompt("builder"),
		});
	};

	let childVisibleModelsPromise: Promise<Set<string>> | undefined;
	const childVisibleModels = async (): Promise<Set<string>> => {
		childVisibleModelsPromise ??= (async () => {
			const invocation = piInvocation(["--no-extensions", ...childExtensionArgs(), "--list-models"]);
			const result = await pi.exec(invocation.command, invocation.args, { timeout: 30_000 });
			if (result.code !== 0) throw new Error(`child model catalogue failed: ${result.stderr || result.stdout}`);
			const models = new Set<string>();
			for (const line of result.stdout.split("\n").slice(1)) {
				const [provider, model] = line.trim().split(/\s+/);
				if (provider && model) models.add(`${provider}/${model}`);
			}
			return models;
		})();
		return childVisibleModelsPromise;
	};

	// A configured stack is a declaration that every slot is runnable. Resolve/auth-check
	// both the parent registry and the clean-room child catalogue, then make Main the host.
	pi.on("session_start", async (_ev: any, ctx: any) => {
		ensureConfigLoaded();
		if (!configuredStack) return;
		const errors: string[] = [];
		const resolved = new Map<string, any>();
		let childCatalogue = new Set<string>();
		try {
			childCatalogue = await childVisibleModels();
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
		for (const slot of orderedSlots(configuredStack)) {
			const slash = slot.model.indexOf("/");
			const model = slash > 0 ? ctx.modelRegistry.find(slot.model.slice(0, slash), slot.model.slice(slash + 1)) : undefined;
			if (!model) errors.push(`${slot.name}: model is not registered: ${slot.model}`);
			else if (!ctx.modelRegistry.hasConfiguredAuth(model)) errors.push(`${slot.name}: no configured authentication for ${slot.model}`);
			else if (!childCatalogue.has(slot.model)) errors.push(`${slot.name}: ${slot.model} is not visible to clean-room children launched with --no-extensions`);
			else resolved.set(slot.id, model);
		}
		if (!errors.length) {
			const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
			if (current !== configuredStack.primaryBuilder.model) {
				const selected = await pi.setModel(resolved.get(configuredStack.primaryBuilder.id));
				if (!selected) errors.push(`Main builder could not become host model: ${configuredStack.primaryBuilder.model}`);
			}
		}
		if (!errors.length) pi.setThinkingLevel(configuredStack.primaryBuilder.thinking);
		if (errors.length) {
			process.exitCode = 1;
			stackReadyError = `fusion-harness: configured model stack is not runnable:\n${errors.map((error) => `- ${error}`).join("\n")}`;
			try {
				ctx.ui.notify(stackReadyError, "error");
			} catch {}
			ctx.shutdown?.();
			throw new Error(stackReadyError);
		}
		noteHost(ctx);
	});

	// ── 2.3 Shared live state (widget + footer read this) ──────
	// Left cell = ARCHITECT-family (ARCHITECT/FUSION/VALIDATOR), right cell = BUILDER.
	let liveRuns: AgentRun[] = []; // whatever the current command is running (empty when idle)
	const sideOf = (r: AgentRun): "left" | "right" => (r.role === "BUILDER" ? "right" : "left");
	// Last finished run per side — keeps the footer's context bar alive between commands.
	const sideLast: { left?: AgentRun; right?: AgentRun } = {};
	const slotLast = new Map<string, AgentRun>();

	// Per-slot session PERF — speed, cost, and volume together, one bucket per row:
	// Σ output tokens / Σ provider-response seconds / Σ cost across every absorbed child
	// run, plus the HOST's own raw-chat turns (credited to the primary/Main slot below).
	// Session tps per slot = tokens/seconds (throughput-weighted, like the tps
	// extension's atps — never a mean of per-run readings).
	const slotPerf = new Map<string, { outputTokens: number; seconds: number; costUsd: number }>();
	// A run object is cumulative across its command's rounds, so it must fold into
	// slotPerf exactly ONCE — at widget stop — even if a stop path ever ran twice.
	const absorbedRuns = new WeakSet<AgentRun>();
	const bumpSlotPerf = (slotId: string, outputTokens: number, seconds: number, costUsd: number) => {
		const perf = slotPerf.get(slotId) ?? { outputTokens: 0, seconds: 0, costUsd: 0 };
		perf.outputTokens += outputTokens;
		perf.seconds += seconds;
		perf.costUsd += costUsd;
		slotPerf.set(slotId, perf);
	};

	const absorbTotals = (runs: AgentRun[]) => {
		for (const r of runs) {
			if (r.slot && !absorbedRuns.has(r)) {
				absorbedRuns.add(r);
				bumpSlotPerf(r.slot.id, r.tokensOut, r.tpsSeconds, r.costUsd);
			}
			// FUSION is a FRESH throwaway session by design and runs LAST in /fh-fusion — letting
			// it become sideLast would pin the left cell to a session that no longer exists and
			// overwrite the persistent ARCHITECT brain's real context with the merge's ~2%.
			// ARCHITECT/VALIDATOR/TRIAGE all share the one persistent architect session, so
			// only they may speak for the left cell.
			if (r.role === "FUSION") continue;
			if (r.ctxTokens || r.status !== "pending") {
				sideLast[sideOf(r)] = r;
				if (r.slot) slotLast.set(r.slot.id, r);
			}
		}
	};

	// The HOST's raw-chat turns are the Main slot working too — measure them with the
	// tps extension's boundary (monotonic before_provider_request → assistant
	// message_end; turn_start is the fallback) and credit tokens/seconds/cost to the
	// primary slot's perf bucket. Pi's message_start is NOT a safe first-token clock:
	// providers can buffer output before opening it, producing absurd 10k+ TPS readings.
	let hostRequestStart: number | undefined;
	let hostTurnStart: number | undefined;
	pi.on("turn_start", async () => {
		hostTurnStart = performance.now();
		hostRequestStart = undefined;
	});
	pi.on("before_provider_request", async () => {
		hostRequestStart = performance.now();
	});
	pi.on("message_end", async (event: any) => {
		if (event.message?.role !== "assistant") return;
		const endedAt = performance.now();
		const startedAt = hostRequestStart ?? hostTurnStart;
		hostRequestStart = undefined;
		hostTurnStart = undefined;
		const output = event.message.usage?.output || 0;
		if (startedAt === undefined || output <= 0) return;
		try {
			bumpSlotPerf(modelStack().primaryBuilder.id, output, Math.max(0, endedAt - startedAt) / 1000, event.message.usage?.cost?.total || 0);
		} catch {
			/* stack not resolvable yet — skip this turn's sample */
		}
	});

	// ── 2.4 Per-app-run slot sessions ──────────────────────────
	// A slot keeps ONE session across every command within a single pi launch — and
	// quitting the app discards every slot brain. Restarting must never resume
	// yesterday's transcripts (user direction 2026-08-18: v1 persisted ids on disk
	// across restarts, and freshly-launched agents greeted prompts with "already read
	// earlier this session"). Ids are minted in-memory per process; session files land
	// under a per-process run dir that is removed at shutdown. Cross-model keying is
	// unchanged: a /fh-model swap mid-run still mints a separate brain per slot+model.
	// (FUSION stays fresh per command — the merge judges answers without contamination.)

	// Per-run artifacts land under /tmp/fusion-harness-* (the spec'd, inspectable location —
	// note os.tmpdir() on macOS is /var/folders/…, so we pin /tmp explicitly).
	const ARTIFACT_ROOT = fs.existsSync("/tmp") ? "/tmp" : os.tmpdir();

	const projectSlug = (cwd: string): string => {
		let canonical = path.resolve(cwd);
		try { canonical = fs.realpathSync.native(canonical); } catch {}
		const readable = canonical.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(-40) || "root";
		const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
		return `${readable}-${hash}`;
	};
	const sessionsRootFor = (cwd: string): string => path.join(ARTIFACT_ROOT, "fusion-harness-sessions", projectSlug(cwd));
	// One run dir per PROCESS: concurrent harness launches on the same project can never
	// share (or clobber) each other's session files, and a restart starts from nothing.
	const runSessionDirs = new Set<string>();
	const runSessionsRoot = (cwd: string): string => path.join(sessionsRootFor(cwd), `run-${process.pid}`);
	// Keyed per slot AND model: a transcript built under one model must never be replayed
	// as another model's own history. Observed live: a sonnet-5-built architect session
	// (full of "You are the ARCHITECT agent (anthropic/claude-sonnet-5)" turns) replayed
	// into claude-fable-5 tripped Anthropic's usage-policy classifier — every request
	// BLOCKED at the API, even "/fh-opinion hello" — while the identical prompt on a fresh
	// fable session passed. Swapping models mid-run mints a separate brain for that model.
	const slotSessions: Record<string, { id: string; dir: string }> = {};
	const slotKey = (slot: ModelSlot): string => `${slot.id}:${modelTag(slot.model)}:${createHash("sha256").update(slot.model).digest("hex").slice(0, 12)}`;
	const slotSession = (slot: ModelSlot, cwd: string): { id: string; dir: string } => {
		const key = slotKey(slot);
		const cached = slotSessions[key];
		if (cached) return cached;
		// Fresh id EVERY process — never read from disk, so a restart cannot resume.
		const dir = path.join(runSessionsRoot(cwd), slot.id);
		fs.mkdirSync(dir, { recursive: true });
		runSessionDirs.add(runSessionsRoot(cwd));
		slotSessions[key] = { id: randomUUID(), dir };
		return slotSessions[key];
	};
	// Best-effort cleanup: quitting the app deletes this run's session files outright.
	pi.on("session_shutdown", async () => {
		for (const dir of runSessionDirs) {
			await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
		}
		runSessionDirs.clear();
	});
	const roleSlot = (side: "architect" | "builder"): ModelSlot => (side === "architect" ? modelStack().architect : modelStack().primaryBuilder);
	const roleSession = (side: "architect" | "builder", cwd: string): { id: string; dir: string } => slotSession(roleSlot(side), cwd);
	/** Session id for summaries — cache-only, never mints a session. */
	const cachedSlotId = (slot: ModelSlot): string | undefined => slotSessions[slotKey(slot)]?.id;
	const cachedRoleId = (side: "architect" | "builder"): string | undefined => cachedSlotId(roleSlot(side));

	/** Wipe THIS run's slot sessions (disk + in-memory, all models) — shared by /fh-reset and /new. */
	const resetRoleSessions = async (cwd: string): Promise<string> => {
		const root = runSessionsRoot(cwd);
		await fs.promises.rm(root, { recursive: true, force: true }).catch(() => {});
		// Opportunistic sweep: run dirs left behind by dead processes (crashes never get
		// their shutdown cleanup). Only dead pids — a concurrent live harness keeps its brains.
		try {
			for (const entry of await fs.promises.readdir(sessionsRootFor(cwd))) {
				const pid = Number(entry.replace(/^run-/, ""));
				if (!entry.startsWith("run-") || !Number.isInteger(pid) || pid === process.pid) continue;
				try {
					process.kill(pid, 0);
				} catch {
					await fs.promises.rm(path.join(sessionsRootFor(cwd), entry), { recursive: true, force: true }).catch(() => {});
				}
			}
		} catch {
			/* nothing to sweep */
		}
		for (const key of Object.keys(slotSessions)) delete slotSessions[key];
		sideLast.left = undefined;
		sideLast.right = undefined;
		slotLast.clear();
		slotPerf.clear(); // fresh memories, fresh speed/cost stats
		return root;
	};

	// ── /new resets the role brains too ─────────────────────────
	// Pi's built-in /new gives the HOST a fresh session, but the ARCHITECT (and the
	// headless-fallback BUILDER) children resume their persistent per-project sessions —
	// without this hook they'd drag the old context straight into the "new" conversation.
	// So a /new also does the /fh-reset work. `reason` distinguishes the user's /new from
	// startup/reload/resume/fork, where persisting across restarts is the whole design.
	pi.on("session_start", async (ev: any, ctx: any) => {
		if (ev?.reason !== "new") return;
		// Silent by design (user preference): a fresh session resetting the role brains is
		// the expected behavior, not news. /fh-reset keeps its notify — it's an explicit ask.
		await resetRoleSessions(ctx.cwd);
	});

	/**
	 * The BUILDER is the HOST's agent: launch recipes set the host --model to the builder
	 * model, so raw (non-slash) input IS the builder, natively. Builder children therefore
	 * FORK the host session — inheriting every raw chat turn and every panel — instead of
	 * keeping a separate brain.
	 *
	 * The builder must ALWAYS land in a brain that persists across commands. Pi only
	 * flushes the host session file on the host's first ASSISTANT message (session-manager
	 * `_persist`) — appended panels don't trigger it — so a session driven purely by slash
	 * commands has a session PATH but no file to fork. In that window the only way to give
	 * the builder a memory is the manifest-pinned persistent session; handing it a fresh
	 * throwaway instead makes it amnesiac on every command (a visible ~1k cold-start prompt
	 * each time, while the ARCHITECT accumulates in its own persistent session).
	 */
	const builderSpawn = (ctx: any, artifactsDir: string): SpawnIdentity => {
		let hostFile: string | undefined;
		try {
			hostFile = ctx.sessionManager.getSessionFile?.();
		} catch {
			/* treat as sessionless */
		}
		// Host session on disk → fork it: that IS the shared brain (raw chat + every panel).
		if (hostFile) {
			let flushed = false;
			try {
				flushed = fs.existsSync(hostFile) && fs.statSync(hostFile).size > 0;
			} catch {
				/* not flushed yet */
			}
			if (flushed) return { fork: hostFile, sessionDir: path.join(artifactsDir, "builder") };
		}
		// No host file yet (slash-commands-only session) or no host session at all
		// (--no-session / headless): fall back to the persistent builder session so the
		// builder still remembers across commands. Once the host does flush, builder
		// children move to forking it — a promotion to the intended shared brain, whose
		// transcript already carries the panels from these earlier commands; only the
		// child's own verbose turns (throwaway by design) are left behind.
		const s = roleSession("builder", ctx.cwd);
		return { sessionDir: s.dir, sessionId: s.id };
	};

	const newSlotRun = (slot: ModelSlot): AgentRun => newRun(slot.architect ? "ARCHITECT" : "BUILDER", slot.model, slot);
	const slotInitialSpawn = (slot: ModelSlot, ctx: any, artifactsDir: string): SpawnIdentity => {
		if (slot.primary) return builderSpawn(ctx, artifactsDir);
		const session = slotSession(slot, ctx.cwd);
		return { sessionDir: session.dir, sessionId: session.id };
	};
	const slotNextSpawn = (slot: ModelSlot, run: AgentRun, initial: SpawnIdentity, ctx: any): SpawnIdentity => {
		if (run.sessionRef) return { sessionDir: initial.sessionDir, resume: run.sessionRef };
		if (slot.primary) return initial;
		const session = slotSession(slot, ctx.cwd);
		return { sessionDir: session.dir, sessionId: session.id };
	};

	// ── 2.5 The MODEL BAR (/fh): one aligned cell per model — `◆ ROLE | model (med) | [██--------] 12%` ──
	//
	// The harness CLEARS pi's default footer at TUI session start (user direction
	// 2026-08-17: "get rid of the default footer") — these recipes launch pi with only
	// this extension, so there is no other footer owner to fight. The model bar itself
	// stays a separate `belowEditor` widget, OFF by default and toggled with /fh —
	// auxiliary telemetry, not something worth spending permanent screen rows on.
	const FOOTER_WIDGET = `${CUSTOM_TYPE}-modelbar`;
	let footerVisible = false;
	let footerCtx: any; // the session ctx — the widget needs its ui + modelRegistry + live model
	let footerTicker: ReturnType<typeof setInterval> | undefined;

	const renderFooterWidget = () => {
		const ctx = footerCtx;
		if (!ctx || !footerVisible) return;
		const contextWindow = (model: string): number => {
			try {
				const slash = model.indexOf("/");
				const found = ctx.modelRegistry.find(model.slice(0, slash), model.slice(slash + 1));
				if (found?.contextWindow) return found.contextWindow;
			} catch {
				/* fall through */
			}
			return 1_000_000;
		};
		const bar = (used: number, window: number): string => {
			const pct = Math.max(0, Math.min(1, window > 0 ? used / window : 0));
			const filled = Math.round(pct * 10);
			return `[${"█".repeat(filled)}${"-".repeat(10 - filled)}] ${Math.round(pct * 100)}%`;
		};
		try {
			ctx.ui.setWidget(
				FOOTER_WIDGET,
				(_tui: any, theme: any) => ({
					invalidate() {},
					render(width: number): string[] {
						return orderedSlots(modelStack()).map((slot) => {
							const live = liveRuns.filter((run) => run.slot?.id === slot.id && run.model === slot.model);
							const remembered = slotLast.get(slot.id)?.model === slot.model ? slotLast.get(slot.id) : undefined;
							const active = live.find((run) => run.status === "working") ?? live[live.length - 1] ?? remembered;
							const role: Role = slot.architect ? "ARCHITECT" : "BUILDER";
							let model = active?.model ?? slot.model;
							let used = active?.ctxTokens || remembered?.ctxTokens || 0;
							let window = contextWindow(model);
							if (slot.primary && !live.length) {
								model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : slot.model;
								const usage = ctx.getContextUsage?.();
								used = Math.max(usage?.tokens ?? 0, used);
								window = usage?.contextWindow ?? contextWindow(model);
							}
							// Speed + cost per row: the slot's session bucket plus the in-flight run
							// (not yet absorbed), so tps/cost move live while an agent streams.
							const perf = slotPerf.get(slot.id);
							const inFlight = live.find((run) => run.status === "working") ?? live[live.length - 1];
							const extra = inFlight && !absorbedRuns.has(inFlight) ? inFlight : undefined;
							const perfTokens = (perf?.outputTokens ?? 0) + (extra?.tokensOut ?? 0);
							const perfSeconds = (perf?.seconds ?? 0) + (extra?.tpsSeconds ?? 0);
							const perfCost = (perf?.costUsd ?? 0) + (extra?.costUsd ?? 0);
							const perfStr = `${perfTokens > 0 && perfSeconds > 0 ? `${Math.round(perfTokens / perfSeconds)} tps` : "— tps"} | $${perfCost.toFixed(4)}`;
							return truncateToWidth(cellStr(theme, role, model, active?.thinking ?? slot.thinking, bar(used, window), slot, perfStr), width);
						});
					},
				}),
				{ placement: "belowEditor" },
			);
		} catch {
			/* the model bar is progressive enhancement — never break the session over it */
		}
	};

	/** Show/hide the model bar, owning its refresh ticker (context bars move while agents run). */
	const setFooterVisible = (visible: boolean) => {
		footerVisible = visible;
		if (footerTicker) {
			clearInterval(footerTicker);
			footerTicker = undefined;
		}
		if (visible) {
			renderFooterWidget();
			footerTicker = setInterval(renderFooterWidget, WIDGET_TICK_MS);
			footerTicker.unref?.(); // never hold the process open for a status readout
			return;
		}
		try {
			footerCtx?.ui.setWidget(FOOTER_WIDGET, undefined);
		} catch {
			/* already gone */
		}
	};

	pi.on("session_start", async (_ev: any, ctx: any) => {
		noteHost(ctx);
		if (ctx.mode !== "tui") return;
		footerCtx = ctx;
		// The harness runs FOOTERLESS: pi's default footer is cleared outright (an
		// empty component fully removes the row; setFooter(undefined) would restore
		// it). The /fh model bar is the harness's status surface when you want one.
		try {
			ctx.ui.setFooter(() => ({ render: () => [], invalidate() {} }));
		} catch {
			/* no footer API on this pi — leave the default */
		}
		// A /new or a session switch hands us a fresh ctx — re-attach if the bar was showing.
		if (footerVisible) setFooterVisible(true);
	});

	// ── 2.6 The transcript renderer — responsive N-agent results ──
	pi.registerMessageRenderer<FhDetails>(CUSTOM_TYPE, (message, _opts, theme) => renderFhPanel(message, theme));

	// ── 2.7 Shared command machinery ───────────────────────────

	const panel = (details: FhDetails, content: string) => {
		pi.sendMessage<FhDetails>({
			customType: CUSTOM_TYPE,
			content: truncateBytes(content, ANSWER_MAX_BYTES),
			display: true,
			details,
		});
	};

	/**
	 * The panel for an escape-stopped run. Renders as an `error` panel (no renderer change)
	 * but says plainly that the user stopped it — an aborted child is !runOk, so without
	 * this a stop would surface as "the agents failed", blaming the models for the user.
	 */
	const stoppedPanel = (command: string, runs: AgentRun[], artifactsDir: string, startedAt: number, what: string) => {
		panel(
			{
				kind: "stopped",
				command,
				ok: false,
				sources: runs.map(toStat),
				artifactsDir,
				totalMs: Date.now() - startedAt,
				totalCostUsd: runs.reduce((s, r) => s + r.costUsd, 0),
			},
			`⊘ STOPPED — escape pressed. ${what}\nEverything produced up to this point is in ${artifactsDir}.`,
		);
	};

	/**
	 * Live two-column widget while children run: left agent | right agent, each
	 * streaming its own flow (tool lines + response text), plus an optional
	 * full-width span row (the FUSION merge stage). Re-set every tick.
	 */
	const startWidget = (
		ctx: any,
		command: string,
		cols: [AgentRun, AgentRun],
		span: AgentRun | undefined,
		startedAt: number,
	) => {
		liveRuns = span ? [...cols, span] : [...cols];
		const render = () => {
			try {
				ctx.ui.setWidget(
					CUSTOM_TYPE,
					(_tui: any, theme: any) => {
						const c = new Container();
						const all = span ? [...cols, span] : [...cols];
						const cost = all.reduce((s, r) => s + r.costUsd, 0);
						c.addChild(
							new Text(
								theme.fg("customMessageLabel", theme.bold(`FUSION HARNESS · /${command}`)) +
									theme.fg("dim", ` · ${fmtSecs(Date.now() - startedAt)} · ~$${cost.toFixed(4)}`),
								1,
								0,
							),
						);
						c.addChild(new TwoCol((colW) => ({ left: liveColumn(theme, cols[0], colW), right: liveColumn(theme, cols[1], colW) }), theme.fg("dim", " │ ")));
						if (span && span.status !== "pending") {
							c.addChild(new Text("", 0, 0));
							// Real width, not a guess — the FUSION row spans the whole terminal.
							c.addChild(new FullWidth((w) => liveColumn(theme, span, w)));
						}
						return c;
					},
					{ placement: "aboveEditor" },
				);
			} catch {
				/* widget is best-effort; no-op outside the TUI */
			}
		};
		render();
		const ticker = setInterval(render, WIDGET_TICK_MS);
		return () => {
			clearInterval(ticker);
			const all = span ? [...cols, span] : [...cols];
			absorbTotals(all);
			liveRuns = [];
			try {
				ctx.ui.setWidget(CUSTOM_TYPE, undefined);
			} catch {
				/* ignore */
			}
		};
	};

	/** Live responsive N-agent widget, with an optional full-width orchestration stage. */
	const startGridWidget = (ctx: any, command: string, runs: AgentRun[], span: AgentRun | undefined, startedAt: number) => {
		liveRuns = span ? [...runs, span] : [...runs];
		const render = () => {
			try {
				ctx.ui.setWidget(
					CUSTOM_TYPE,
					(_tui: any, theme: any) => {
						const c = new Container();
						const all = span ? [...runs, span] : runs;
						const cost = all.reduce((sum, run) => sum + run.costUsd, 0);
						c.addChild(new Text(theme.fg("customMessageLabel", theme.bold(`FUSION HARNESS · /${command}`)) + theme.fg("dim", ` · ${fmtSecs(Date.now() - startedAt)} · ~$${cost.toFixed(4)}`), 1, 0));
						if (runs.length) c.addChild(new AgentGrid(runs.length, (index, colW) => liveColumn(theme, runs[index], colW), theme.fg("dim", " │ ")));
						if (span && span.status !== "pending") {
							c.addChild(new Text("", 0, 0));
							c.addChild(new FullWidth((width) => liveColumn(theme, span, width)));
						}
						return c;
					},
					{ placement: "aboveEditor" },
				);
			} catch {}
		};
		render();
		const ticker = setInterval(render, WIDGET_TICK_MS);
		return () => {
			clearInterval(ticker);
			absorbTotals(span ? [...runs, span] : runs);
			liveRuns = [];
			try {
				ctx.ui.setWidget(CUSTOM_TYPE, undefined);
			} catch {}
		};
	};

	/**
	 * Live SINGLE-column widget: one agent, full terminal width. Same header and ticker
	 * contract as startWidget — /fh-only has no second agent to align against, so
	 * splitting the terminal would just waste half of it.
	 */
	const startSoloWidget = (ctx: any, command: string, run: AgentRun, startedAt: number) => {
		liveRuns = [run];
		const render = () => {
			try {
				ctx.ui.setWidget(
					CUSTOM_TYPE,
					(_tui: any, theme: any) => {
						const c = new Container();
						c.addChild(
							new Text(
								theme.fg("customMessageLabel", theme.bold(`FUSION HARNESS · /${command}`)) +
									theme.fg("dim", ` · ${fmtSecs(Date.now() - startedAt)} · ~$${run.costUsd.toFixed(4)}`),
								1,
								0,
							),
						);
						c.addChild(new FullWidth((w) => liveColumn(theme, run, w)));
						return c;
					},
					{ placement: "aboveEditor" },
				);
			} catch {
				/* widget is best-effort; no-op outside the TUI */
			}
		};
		render();
		const ticker = setInterval(render, WIDGET_TICK_MS);
		return () => {
			clearInterval(ticker);
			absorbTotals([run]);
			liveRuns = [];
			try {
				ctx.ui.setWidget(CUSTOM_TYPE, undefined);
			} catch {
				/* ignore */
			}
		};
	};

	/**
	 * ESCAPE = stop. Pi's own escape only aborts ITS agent loop; a slash command's children
	 * are our subprocesses, so nothing cancels them unless we listen ourselves. While
	 * children run we tap raw terminal input and abort the run's controller on Escape.
	 *
	 * A bare "\x1b" IS the Escape key; "\x1b[A"/"\x1bO…" are arrow/function-key SEQUENCES
	 * that merely start with the same byte — matching a prefix would swallow those keys.
	 * Only Escape is consumed; every other key (incl. ctrl-c, which pi handles) passes through.
	 * Returns an unsubscribe — always call it, or the tap outlives the command.
	 */
	const onEscape = (ctx: any, stop: () => void): (() => void) => {
		try {
			return (
				ctx.ui.onTerminalInput?.((data: string) => {
					if (data === "\x1b" || data === "escape" || data === "esc" || matchesKey(data, "escape")) {
						stop();
						return { consume: true };
					}
					return undefined;
				}) ?? (() => {})
			);
		} catch {
			return () => {}; // headless / no TUI — nothing to tap
		}
	};

	const activeCommandControllers = new Set<AbortController>();
	/** One abort controller per command run + the Escape tap that trips it. */
	const startStoppable = (ctx: any, command: string): { signal: AbortSignal; stopped: () => boolean; release: () => void } => {
		const ctl = new AbortController();
		activeCommandControllers.add(ctl);
		const unsubscribe = onEscape(ctx, () => {
			if (ctl.signal.aborted) return;
			ctl.abort();
			try {
				ctx.ui.setStatus(CUSTOM_TYPE, `${command}: stopping…`);
				ctx.ui.notify(`fusion-harness: stopping /${command} — escape pressed`, "warning");
			} catch {
				/* best effort */
			}
		});
		const release = () => {
			unsubscribe();
			activeCommandControllers.delete(ctl);
		};
		return { signal: ctl.signal, stopped: () => ctl.signal.aborted, release };
	};

	pi.on("session_shutdown", async () => {
		for (const controller of activeCommandControllers) controller.abort();
		activeCommandControllers.clear();
	});

	const mkArtifacts = async (): Promise<string> => fs.promises.mkdtemp(path.join(ARTIFACT_ROOT, "fusion-harness-"));
	const save = (dir: string, name: string, body: string) => fs.promises.writeFile(path.join(dir, name), body, "utf-8");
	const ensureSummary = async (dir: string, payload: Record<string, unknown>) => {
		const summaryPath = path.join(dir, "summary.json");
		try {
			await fs.promises.access(summaryPath);
			return;
		} catch {}
		try {
			await fs.promises.writeFile(summaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
		} catch (error) {
			process.stderr.write(`fusion-harness: FAILED to write required summary ${summaryPath}: ${String(error)}\n`);
		}
	};
	const totals = (runs: AgentRun[], startedAt: number) => ({
		totalMs: Date.now() - startedAt,
		totalCostUsd: runs.reduce((s, r) => s + r.costUsd, 0),
	});

	// ── 2.8 Boot banner — big centered "FUSION HARNESS" when the harness starts ──
	// An ENTRY, not a custom message. Pi turns every custom *message* into a `user` turn in
	// the LLM context (convertToLlm), so sending the banner through panel() put a literal
	// "FUSION HARNESS" user message ahead of your first real prompt — models read it as a
	// prefix ("FUSION HARNESS ping") and it rode along into every fork. Custom entries
	// persist in the session and render in scrollback but never reach the model, which is
	// exactly what pure chrome wants: the banner costs zero tokens and says nothing.
	//
	// Entry renderers landed in pi 0.80.4. On an older pi the registration below would throw
	// while the extension is loading and take EVERY command down with it — so the banner,
	// being pure chrome, is capability-checked: an old pi gets no banner, never no harness.
	const canRenderEntries = typeof pi.registerEntryRenderer === "function" && typeof pi.appendEntry === "function";
	if (canRenderEntries) {
		pi.registerEntryRenderer(BOOT_TYPE, (_entry, _opts, theme) =>
			new FullWidth((w) => {
				const center = (l: string) => " ".repeat(Math.max(0, Math.floor((w - visibleWidth(l)) / 2))) + l;
				const big = "FUSION HARNESS".replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).replace(/ /g, "　");
				const title = visibleWidth(big) <= w ? big : "FUSION HARNESS";
				// The fusion mark: ONE circle per configured slot, in the slot's ACTUAL hex
				// color — the stack you loaded, visible at boot. Falls back to the two role
				// circles if the configured stack can't be resolved yet.
				let mark: string;
				try {
					mark = orderedSlots(modelStack()).map((slot) => fgHex(slot.color, "●")).join(theme.fg("customMessageLabel", "  +  "));
				} catch {
					mark = theme.fg(ROLE_COLOR.ARCHITECT, "●") + theme.fg("customMessageLabel", "  +  ") + theme.fg(ROLE_COLOR.BUILDER, "●");
				}
				// One blank line between every element — equal vertical rhythm.
				return [
					"",
					theme.fg("customMessageLabel", theme.bold(center(title))),
					"",
					theme.fg("customMessageLabel", center("Combine Your Compute")),
					"",
					center(mark),
					"",
				];
			}),
		);

		// TUI + fresh startup only: no banner noise in headless JSON streams, and no repeat
		// banner on /new, /resume, forks, or extension reloads.
		pi.on("session_start", async (ev: any, ctx: any) => {
			if (ctx.mode !== "tui" || ev?.reason !== "startup") return;
			pi.appendEntry(BOOT_TYPE);
		});
	}

	// ── 2.9 /fh-reset — wipe the persistent slot sessions for this project ──
	// (/new triggers the same reset via the session_start hook above, on top of pi's own fresh session.)
	pi.registerCommand("fh-reset", {
		description: "Full reset: fresh host session AND fresh slot memories — every agent starts from nothing",
		handler: async (_args, ctx) => {
			noteHost(ctx); // an unset --builder follows the host session's live model
			await resetRoleSessions(ctx.cwd);
			// Main IS the host: without a fresh host session, the Main row keeps its raw-chat
			// context (user report 2026-08-18: "/fh-reset didn't reset the builder"). The old
			// ctx is STALE after replacement — all post-swap work runs in withSession on the
			// ctx pi hands over (per pi's own staleness guard).
			try {
				await ctx.newSession?.({
					withSession: async (newCtx: any) => {
						footerCtx = newCtx;
						// The session swap drops extension widgets; if the model bar was
						// showing, put it straight back on the fresh session.
						if (footerVisible) setFooterVisible(true);
						try {
							newCtx.ui?.notify?.("fusion-harness: full reset — fresh host session, fresh slot memories", "info");
						} catch {}
					},
				});
			} catch {
				// headless / no session manager — the slot reset alone still applied
				try {
					ctx.ui.notify("fusion-harness: slot memories reset (no host session to replace)", "info");
				} catch {}
			}
		},
	});

	// ── 2.10 /fh — the harness's front door: the command index + the model bar toggle ──
	// One thing to remember (`/fh`) instead of ten. Bare invocation prints every command and
	// flips the multi-row model bar; `on`/`off` pin the bar. The bar stays OFF by default —
	// the session runs footerless (pi's default footer is cleared at startup) until you ask.
	// Descriptions stay 3-8 words so index lines NEVER wrap in a normal terminal.
	const COMMAND_INDEX: Array<[string, string]> = [
		["/fh-opinion <prompt>", "every agent answers read-only"],
		['/fh-fusion "<prompt>" "<fusion>"', "parallel research, one writer, all ACK"],
		["/fh-debate [--rounds N] <prompt>", "all-to-all debate, no judge"],
		["/fh-collaborate <prompt>", "agents plan, architect delegates, parallel build"],
		["/fh-only [slot] [prompt]", "route one prompt to one agent"],
		["/fh-model", "pick slot, model, thinking"],
		["/fh-auto-validate [--max-validations N] <prompt>", "gate written first, build until green"],
		["/fh-system-prompt", "every slot's effective system prompt"],
		["/fh-reset", "full reset, host and slots"],
		["/fh [on|off]", "this list, toggle model bar"],
	];
	const COMMAND_PAD = Math.max(...COMMAND_INDEX.map(([cmd]) => cmd.length));

	pi.registerCommand("fh", {
		description: "FUSION HARNESS — list every /fh-* command and toggle the multi-row model bar. /fh [on|off]",
		handler: async (args, ctx) => {
			noteHost(ctx); // an unset --builder follows the host session's live model
			footerCtx ??= ctx; // first use before any tui session_start (e.g. after a reload)
			const arg = args.trim().toLowerCase();
			if (arg && !["on", "off", "show", "hide", "toggle"].includes(arg)) {
				ctx.ui.notify(`fusion-harness: /fh takes on|off (or nothing to toggle the model bar). Got "${arg}".`, "error");
				return;
			}
			const next = arg === "on" || arg === "show" ? true : arg === "off" || arg === "hide" ? false : !footerVisible;
			setFooterVisible(next);
			// Just the name and the tabbed index — the model bar appearing/disappearing is
			// its own feedback, and short descriptions keep every line unwrapped.
			ctx.ui.notify(
				["FUSION HARNESS", ...COMMAND_INDEX.map(([cmd, what]) => `  ${cmd.padEnd(COMMAND_PAD)}  ${what}`)].join("\n"),
				"info",
			);
		},
	});

	// ── 2.11 /fh-model — choose slot → model → thinking, session-only ──
	pi.registerCommand("fh-model", {
		description: "Choose a configured slot, model, and thinking level. Session-only; never rewrites YAML.",
		handler: async (_args, ctx) => {
			noteHost(ctx);
			const stack = modelStack();
			const choices = orderedSlots(stack).map((slot) => `${slot.architect ? "◆ ARCHITECT" : "▲ BUILDER"} | ${slot.name} | ${slot.model} (${THINKING_SHORT[slot.thinking]})`);
			const picked = await ctx.ui.select("Fusion Harness — choose slot", choices);
			if (!picked) return;
			const slotIndex = choices.indexOf(picked);
			const selectedSlot = orderedSlots(stack)[slotIndex];
			if (!selectedSlot) return;

			const availableModels = ctx.modelRegistry.getAvailable();
			const configuredModels = [...new Set([selectedSlot.model, ...orderedSlots(stack).map((slot) => slot.model)])];
			const browse = "Browse another provider…";
			const modelChoice = await ctx.ui.select(`Model for ${selectedSlot.name}`, [...configuredModels, browse]);
			if (!modelChoice) return;
			let selectedModel = modelChoice;
			if (modelChoice === browse) {
				const providers = [...new Set(availableModels.map((model: any) => model.provider as string))].sort();
				const provider = await ctx.ui.select("Choose model provider", providers);
				if (!provider) return;
				const providerModels = availableModels.filter((model: any) => model.provider === provider).map((model: any) => `${model.provider}/${model.id}`).sort();
				const providerModel = await ctx.ui.select(`Model from ${provider}`, providerModels);
				if (!providerModel) return;
				selectedModel = providerModel;
			}
			const selectedThinkingRaw = await ctx.ui.select(`Thinking for ${selectedSlot.name}`, THINKING_LEVELS);
			if (!selectedThinkingRaw) return;
			const selectedThinking = resolveStackThinking(selectedThinkingRaw);
			if (!selectedThinking) return;

			const next = cloneStack(stack);
			const target = next.slots.find((slot) => slot.id === selectedSlot.id)!;
			target.model = selectedModel;
			target.thinking = selectedThinking;
			if (target.primary) {
				const slash = selectedModel.indexOf("/");
				const model = ctx.modelRegistry.find(selectedModel.slice(0, slash), selectedModel.slice(slash + 1));
				if (!model || !ctx.modelRegistry.hasConfiguredAuth(model) || !(await pi.setModel(model))) {
					ctx.ui.notify(`fusion-harness: could not switch Main host model to ${selectedModel}`, "error");
					return;
				}
				hostModel = selectedModel;
				pi.setThinkingLevel(selectedThinking);
				target.thinking = pi.getThinkingLevel() as Thinking;
			}
			next.architect = next.slots.find((slot) => slot.architect)!;
			next.primaryBuilder = next.slots.find((slot) => slot.primary)!;
			next.builders = next.slots.filter((slot) => !slot.architect);
			configuredStack = next;
			renderFooterWidget();
			ctx.ui.notify(`fusion-harness: ${target.name} → ${target.model} (${target.thinking}); session-only, YAML unchanged`, "info");
		},
	});

	// ── 2.12 /fh-system-prompt — every configured slot, responsive grid ──
	pi.registerCommand("fh-system-prompt", {
		description: "Show the system prompt every configured slot runs with.",
		handler: async (_args, ctx) => {
			noteHost(ctx);
			const childDefaultPrompt = async (): Promise<string> => {
				const build = await loadBuildSystemPrompt();
				const hostOpts = ctx.getSystemPromptOptions?.();
				if (build && hostOpts) {
					return build({ ...hostOpts, customPrompt: undefined, appendSystemPrompt: undefined, contextFiles: [], skills: [], selectedTools: FULL_TOOLS.split(","), cwd: ctx.cwd });
				}
				return ctx.getSystemPrompt?.() ?? "(pi default — could not be resolved from this pi installation)";
			};
			const stack = modelStack();
			const needsDefault = orderedSlots(stack).some((slot) => !slot.systemPrompt);
			const dflt = needsDefault ? await childDefaultPrompt() : "";
			const answers: NonNullable<FhDetails["answers"]> = orderedSlots(stack).map((slot) => ({
				role: slot.architect ? "ARCHITECT" : "BUILDER",
				model: slot.model,
				// The EFFECTIVE prompt: base (override or pi default) plus every configured
				// append, in order — exactly what the child receives.
				text: [(slot.systemPrompt ?? dflt).trim(), ...slot.appendSystemPrompts.map((append) => append.trim())].filter(Boolean).join("\n\n"),
				slotId: slot.id,
				slotName: slot.name,
				color: slot.color,
				primary: slot.primary,
			}));
			panel({ kind: "system-prompt", command: "fh-system-prompt", ok: true, answers }, answers.map((answer) => `## ${answer.slotName} · ${answer.model}\n${answer.text}`).join("\n\n"));
		},
	});

	// ── 2.13 /fh-only — direct one-slot execution + armed one-send routing ──
	const ONE_SHOT_WIDGET = `${CUSTOM_TYPE}-one-shot`;
	let oneShotTargetSlotId: string | undefined;
	let oneShotCtx: any;
	const renderOneShot = () => {
		try {
			if (!oneShotTargetSlotId || !oneShotCtx) {
				oneShotCtx?.ui.setWidget(ONE_SHOT_WIDGET, undefined);
				return;
			}
			const slot = modelStack().slots.find((candidate) => candidate.id === oneShotTargetSlotId);
			if (!slot) return;
			oneShotCtx.ui.setWidget(ONE_SHOT_WIDGET, [`▶ ONE-SHOT → ${slot.architect ? "◆ ARCHITECT" : "▲ BUILDER"} | ${slot.name} | ${slot.model} (${THINKING_SHORT[slot.thinking]})`, "  next plain prompt routes only to this agent · /fh-only and pick the same slot to disarm"], { placement: "aboveEditor" });
		} catch {}
	};
	const disarmOneShot = () => {
		oneShotTargetSlotId = undefined;
		renderOneShot();
	};

	const executeOnly = async (slot: ModelSlot, prompt: string, ctx: any, source: "command" | "one-shot") => {
		const startedAt = Date.now();
		const artifactsDir = await mkArtifacts();
		await save(artifactsDir, "prompt.md", prompt);
		await save(artifactsDir, "stack.json", JSON.stringify(modelStack(), null, 2));
		panel({ kind: "prompt", command: "fh-only", ok: true }, `${source === "command" ? "/fh-only " : ""}${prompt}`);
		const run = newSlotRun(slot);
		const stopper = startStoppable(ctx, "fh-only");
		const stopWidget = startSoloWidget(ctx, "fh-only", run, startedAt);
		let writerLease: WriterLease | undefined;
		ctx.ui.setStatus(CUSTOM_TYPE, `fh-only: ${slot.name} working…`);
		try {
			try {
				writerLease = acquireWriterLease(ctx.cwd, `/fh-only ${slot.id} ${path.basename(artifactsDir)}`);
			} catch (error) {
				panel({ kind: "error", command: "fh-only", ok: false, agent: toStat(run), artifactsDir }, error instanceof Error ? error.message : String(error));
				return;
			}
			await runChild({ run, prompt, systemPrompt: slot.systemPrompt, appendSystemPrompts: slot.appendSystemPrompts, tools: FULL_TOOLS, thinking: slot.thinking, ...slotInitialSpawn(slot, ctx, path.join(artifactsDir, slot.id)), cwd: ctx.cwd, timeoutMs: childTimeoutMs(), signal: stopper.signal });
			if (stopper.stopped()) {
				stoppedPanel("fh-only", [run], artifactsDir, startedAt, `${slot.name} was stopped mid-answer.`);
				return;
			}
			await save(artifactsDir, `${slot.id}.md`, runOk(run) ? run.text : `FAILED: ${runError(run)}`);
			const t = totals([run], startedAt);
			if (runOk(run)) panel({ kind: "solo", command: "fh-only", ok: true, agent: toStat(run), artifactsDir, ...t }, run.text);
			else panel({ kind: "error", command: "fh-only", ok: false, agent: toStat(run), artifactsDir, ...t }, `${slot.name} produced no usable answer: ${runError(run)}`);
			await save(artifactsDir, "summary.json", JSON.stringify({ command: "fh-only", source, ok: runOk(run), targetSlot: slot.id, writerLeasePath: writerLease?.path, agents: [toStat(run)], sessions: { [slot.id]: run.sessionRef ?? cachedSlotId(slot) }, ...t }, null, 2));
		} finally {
			await ensureSummary(artifactsDir, { command: "fh-only", source, ok: false, stopped: stopper.stopped(), targetSlot: slot.id, writerLeasePath: writerLease?.path, agents: [toStat(run)], sessions: { [slot.id]: run.sessionRef ?? cachedSlotId(slot) }, ...totals([run], startedAt) });
			writerLease?.release();
			stopper.release();
			stopWidget();
			ctx.ui.setStatus(CUSTOM_TYPE, undefined);
		}
	};

	pi.registerCommand("fh-only", {
		description: "Choose one configured agent. With a prompt, run immediately; without one, arm the next plain prompt as a one-send route.",
		handler: async (raw, ctx) => {
			noteHost(ctx);
			oneShotCtx = ctx;
			const stack = modelStack();
			const input = (raw ?? "").trim();
			const firstSpace = input.search(/\s/);
			const targetToken = firstSpace === -1 ? input : input.slice(0, firstSpace);
			const rest = firstSpace === -1 ? "" : input.slice(firstSpace).trim();
			let selected = targetToken ? stack.slots.find((slot) => slot.id.toLowerCase() === targetToken.toLowerCase() || slot.name.toLowerCase() === targetToken.toLowerCase()) : undefined;
			if (targetToken && !selected) {
				ctx.ui.notify(`fusion-harness: unknown slot ${targetToken}. Valid: ${orderedSlots(stack).map((slot) => slot.id).join(", ")}`, "error");
				return;
			}
			if (!selected) {
				const choices = orderedSlots(stack).map((slot) => `${slot.architect ? "◆ ARCHITECT" : "▲ BUILDER"} | ${slot.name} | ${slot.model}`);
				const picked = await ctx.ui.select("Fusion Harness — one-send target", choices);
				if (!picked) return;
				selected = orderedSlots(stack)[choices.indexOf(picked)];
			}
			if (rest) {
				disarmOneShot();
				await executeOnly(selected, rest, ctx, "command");
				return;
			}
			if (oneShotTargetSlotId === selected.id) {
				disarmOneShot();
				ctx.ui.notify(`fusion-harness: one-shot ${selected.name} disarmed`, "info");
				return;
			}
			oneShotTargetSlotId = selected.id;
			renderOneShot();
			ctx.ui.notify(`fusion-harness: next plain prompt routes only to ${selected.name}`, "info");
		},
	});

	pi.on("input", async (event: any, ctx: any) => {
		if (!oneShotTargetSlotId || event.source !== "interactive" || event.text.startsWith("/")) return { action: "continue" as const };
		if (event.images?.length) {
			ctx.ui.notify("fusion-harness: /fh-only one-shot image routing is not supported yet; target remains armed", "warning");
			return { action: "continue" as const };
		}
		const slot = modelStack().slots.find((candidate) => candidate.id === oneShotTargetSlotId);
		if (!slot) {
			disarmOneShot();
			return { action: "continue" as const };
		}
		disarmOneShot();
		await executeOnly(slot, event.text, ctx, "one-shot");
		return { action: "handled" as const };
	});

	// ── 2.14 The orchestration commands — modules/cmd-*.ts through the HarnessDeps seam ──
	const deps: HarnessDeps = {
		panel,
		stoppedPanel,
		absorbRuns: absorbTotals,
		startStoppable,
		startWidget,
		startGridWidget,
		noteHost,
		modelStack,
		architectModel,
		builderModel,
		newSlotRun,
		slotInitialSpawn,
		slotNextSpawn,
		builderSpawn,
		roleSession,
		roleThinking,
		roleSystemPrompt,
		cachedRoleId,
		cachedSlotId,
		childTimeoutMs,
		buildTimeoutMs,
		flagStr,
		mkArtifacts,
		save,
		ensureSummary,
		totals,
	};
	registerReadonlyCommands(pi, deps); // /fh-opinion + /fh-debate
	registerFusionCommand(pi, deps); // /fh-fusion
	registerCollaborateCommand(pi, deps); // /fh-collaborate
	registerAutoValidateCommand(pi, deps); // /fh-auto-validate
}
