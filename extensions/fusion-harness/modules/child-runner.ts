/**
 * child-runner.ts — how one child agent (or gate process) actually runs.
 *
 * runChild spawns a clean-room `pi --mode json -p` subprocess and streams its JSON
 * events into a live AgentRun; runProc runs a plain subprocess (the validation gate).
 * Both use process groups with close-aware SIGTERM→SIGKILL escalation so Escape,
 * timeout, or session shutdown reaches every tool/bash descendant.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { briefArg, runOk, type AgentRun } from "./runtime.ts";

const KILL_GRACE_MS = 5_000; // SIGTERM → SIGKILL escalation window

/**
 * Extensions a clean-room child still loads explicitly (`-e` survives --no-extensions).
 * FH_CHILD_EXTENSIONS: ":"-separated paths — e.g. codex-rotate, whose openai-codex-N
 * providers otherwise do not exist inside children.
 */
export function childExtensionArgs(): string[] {
	return (process.env.FH_CHILD_EXTENSIONS ?? "")
		.split(":")
		.map((p) => p.trim())
		.filter((p) => p && fs.existsSync(p))
		.flatMap((p) => ["-e", p]);
}

/** Locate the running pi binary so we can re-invoke it as a child. */
export function piInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1]; // the entry script pi itself was launched with
	const isBunVirtual = script?.startsWith("/$bunfs/root/"); // bun-compiled binaries mount a virtual fs
	// Best case: re-run the exact same entry script with the same runtime.
	if (script && !isBunVirtual && fs.existsSync(script)) {
		return { command: process.execPath, args: [script, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	// A compiled pi binary (execPath IS pi): invoke it directly.
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	// Last resort: whatever `pi` resolves to on PATH.
	return { command: "pi", args };
}

/**
 * Spawn one `pi --mode json -p` child agent and stream its JSON events into `run`.
 * Final answer = last assistant text part. The child writes its session into a
 * throwaway --session-dir under the run's /tmp artifacts dir.
 */
export function runChild(opts: {
	run: AgentRun; // mutated live
	prompt: string;
	systemPrompt?: string;
	appendSystemPrompts?: string[]; // appended AFTER the base prompt (override or pi default) via pi's repeatable flag
	tools: string | "none";
	thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	sessionDir: string;
	sessionId?: string; // stable per-role session — the agent keeps its context across commands
	fork?: string; // fork this session FILE (copy-on-write) — the child inherits the host's full context
	resume?: string; // resume this session id inside sessionDir (later auto-validate rounds re-enter the fork)
	cwd: string;
	timeoutMs: number;
	signal?: AbortSignal; // escape key — kill this child and settle it as "aborted"
}): Promise<AgentRun> {
	const run = opts.run;
	run.thinking = opts.thinking;
	// Clean-room spawn: children never load skills, extensions (recursion guard), or
	// context files — their entire contract comes from the harness's prompt files.
	const args: string[] = [
		"--mode",
		"json",
		"-p",
		"--session-dir",
		opts.sessionDir,
		"--no-skills",
		"--no-extensions",
		...childExtensionArgs(),
		"--no-context-files",
		"--thinking",
		opts.thinking,
		"--model",
		run.model,
	];
	// Session identity, in precedence order: fork the host > resume an earlier fork > pinned per-role id.
	if (opts.fork) args.push("--fork", opts.fork);
	else if (opts.resume) args.push("--session", opts.resume);
	else if (opts.sessionId) args.push("--session-id", opts.sessionId);
	if (opts.systemPrompt) args.push("--system-prompt", opts.systemPrompt);
	// Appends ride pi's own --append-system-prompt (repeatable): they land after the
	// base prompt whether that base is our override or pi's default — the one way to
	// append to a default this process never builds.
	for (const append of opts.appendSystemPrompts ?? []) {
		if (append.trim()) args.push("--append-system-prompt", append);
	}
	if (opts.tools === "none") args.push("--no-tools");
	else args.push("--tools", opts.tools);
	args.push(opts.prompt);

	return new Promise<AgentRun>((resolve) => {
		const started = Date.now();
		let buffer = "";
		let timedOut = false;
		let aborted = false;
		let closed = false;
		// Already stopped before this stage began (e.g. escape during the previous agent):
		// settle without spawning, so an abort never starts new model work.
		if (opts.signal?.aborted) {
			run.status = "aborted";
			run.startedAt = started;
			run.endedAt = started;
			run.ms = 0;
			run.exitCode = 130;
			resolve(run);
			return;
		}
		run.status = "working";
		run.startedAt = started;
		run.endedAt = undefined;
		run.ms = 0;
		run.text = "";
		run.streamText = "";
		run.streamThinking = "";
		run.exitCode = 0;
		run.stopReason = undefined;
		run.errorMessage = undefined;
		run.stderr = "";
		run.flowMark = run.flow.length;
		// TPS segment 1 opens at spawn: child startup + prompt assembly + the first
		// provider round-trip all count as response time (the tps extension's
		// turn_start fallback has the same shape). Tool execution is excluded by
		// re-opening the segment at every tool_execution_end below.
		run.tpsSegmentStart = performance.now();

		// One line of the child's JSON event stream → the relevant AgentRun mutation.
		const processLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return; // non-JSON noise on stdout — ignore
			}
			if (event.type === "session" && typeof event.id === "string") {
				run.sessionRef = event.id; // remember the child's session so later rounds can resume it
			} else if (event.type === "message_end" && event.message?.role === "assistant") {
				const msg = event.message;
				let finalizedText = "";
				for (const part of msg.content ?? []) {
					// A turn's reasoning arrives as `thinking` parts (pi-ai ThinkingContent) — a
					// different shape from `text`, which is why it was invisible before.
					if (part.type === "thinking" && part.thinking?.trim()) {
						run.flow.push({ type: "thinking", text: part.thinking });
					}
					if (part.type === "text" && part.text) finalizedText += part.text;
				}
				if (finalizedText.trim()) {
					run.text = finalizedText;
					run.flow.push({ type: "text", text: finalizedText });
				}
				run.streamText = "";
				run.streamThinking = "";
				if (msg.stopReason) run.stopReason = msg.stopReason;
				if (msg.errorMessage) run.errorMessage = msg.errorMessage;
				if (msg.usage) {
					// Prompt tokens = input + cacheRead + cacheWrite (pi's own definition, see
					// core/cache-stats.ts). cacheWrite is NOT optional accounting: on a cold
					// cache the WHOLE prompt is billed as a write and `input` is only the few
					// uncached tokens — dropping it renders a real 10k-token prompt as "in 3".
					run.tokensIn += (msg.usage.input || 0) + (msg.usage.cacheRead || 0) + (msg.usage.cacheWrite || 0);
					run.tokensOut += msg.usage.output || 0;
					// TPS: close the response segment ONLY when this message carried output
					// tokens — children emit an opening message_end with null usage, and
					// counting its near-instant segment would deflate every reading.
					if ((msg.usage.output || 0) > 0) {
						const now = performance.now();
						if (run.tpsSegmentStart !== undefined) run.tpsSeconds += Math.max(0, now - run.tpsSegmentStart) / 1000;
						run.tpsSegmentStart = now;
					}
					if (msg.usage.cost?.total) run.costUsd += msg.usage.cost.total;
					// Matches pi's calculateContextTokens: `totalTokens || input+output+read+write`
					// (|| not ??, so a provider reporting 0 falls through to the sum).
					const ctxTokens =
						msg.usage.totalTokens || (msg.usage.input || 0) + (msg.usage.cacheRead || 0) + (msg.usage.cacheWrite || 0) + (msg.usage.output || 0);
					// Children emit an opening message_end whose usage fields are all null; this is
					// an assignment, not a sum, so counting one would clobber a real reading with 0.
					if (ctxTokens > 0) run.ctxTokens = ctxTokens;
				}
			} else if (event.type === "tool_execution_start") {
				run.toolCalls++;
				const name: string = event.toolName ?? "?";
				run.toolNames.push(name);
				const arg = briefArg(event.args);
				run.toolEvents.push({ name, argument: arg });
				run.flow.push({ type: "tool", label: arg ? `${name} ${arg}` : name });
			} else if (event.type === "tool_execution_end") {
				// TPS: tool time is NOT response time — the next provider segment starts here.
				run.tpsSegmentStart = performance.now();
			} else if (event.type === "message_update" && event.message?.role === "assistant") {
				let t = "";
				let think = "";
				for (const part of event.message.content ?? []) {
					if (part.type === "text" && part.text) t += part.text;
					else if (part.type === "thinking" && part.thinking) think += part.thinking;
				}
				if (t) run.streamText = t;
				// Streaming the reasoning is what makes a long opening turn look ALIVE: an agent
				// at xhigh on a big session can think for minutes before its first token of text,
				// and rendering nothing made it read as hung.
				if (think) run.streamThinking = think;
			}
		};

		const settle = () => {
			run.endedAt = Date.now();
			run.ms = run.endedAt - started;
			// abort wins over runOk: a killed child may still have emitted usable text, but the
			// user asked it to stop — reporting "done" would silently accept a partial answer.
			run.status = aborted ? "aborted" : runOk(run) ? "done" : timedOut ? "timeout" : "failed";
			run.streamText = "";
			run.streamThinking = "";
		};

		const invocation = piInvocation(args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd: opts.cwd,
			shell: false,
			detached: process.platform !== "win32", // own process group so cancellation reaches tool/bash descendants
			stdio: ["ignore", "pipe", "pipe"],
			// Children still make their real model API calls — this only skips startup chores.
			// CODEX_ROTATE_PIN: a child must answer as the account its slot names, never rotate.
			env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", CODEX_ROTATE_PIN: "1" },
		});

		// Line-buffer stdout: events arrive one JSON object per line, possibly split across chunks.
		proc.stdout?.on("data", (data: Buffer) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || ""; // keep the trailing partial line for the next chunk
			for (const line of lines) processLine(line);
		});
		proc.stderr?.on("data", (data: Buffer) => {
			run.stderr += data.toString();
		});
		const signalTree = (signal: NodeJS.Signals) => {
			try {
				if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, signal);
				else proc.kill(signal);
			} catch {
				try { proc.kill(signal); } catch {}
			}
		};
		// SIGTERM, then SIGKILL after the grace period. ChildProcess.killed only means a
		// signal was sent, so escalation tracks the close/error event explicitly.
		const killChild = () => {
			signalTree("SIGTERM");
			setTimeout(() => {
				if (!closed) {
					signalTree("SIGKILL");
				}
			}, KILL_GRACE_MS);
		};
		const onAbort = () => {
			aborted = true;
			killChild();
		};
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		const cleanup = () => {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
		};

		proc.on("close", (code) => {
			closed = true;
			if (buffer.trim()) processLine(buffer); // flush a final unterminated line
			run.exitCode = aborted ? 130 : timedOut ? 124 : (code ?? 0);
			cleanup();
			settle();
			resolve(run);
		});
		proc.on("error", (err) => {
			closed = true;
			run.stderr += `\nspawn error: ${String(err)}`;
			run.exitCode = 1;
			cleanup();
			settle();
			resolve(run);
		});

		// Wall-clock timeout uses the exact same close-aware escalation as escape.
		const timer = setTimeout(() => {
			timedOut = true;
			killChild();
		}, opts.timeoutMs);
	});
}

/** Run a plain subprocess (the validation gate) and capture combined output. */
export function runProc(
	command: string,
	args: string[],
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<{ code: number; output: string; aborted?: boolean }> {
	return new Promise((resolve) => {
		let output = "";
		let timedOut = false;
		let aborted = false;
		// A gate can burn the full 120s timeout; escape must cut it short like any child.
		if (signal?.aborted) {
			resolve({ code: 130, output: "[stopped by user before the gate ran]", aborted: true });
			return;
		}
		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn(command, args, { cwd, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
		} catch (err) {
			resolve({ code: 127, output: `failed to spawn ${command}: ${String(err)}` });
			return;
		}
		const killTree = () => {
			try {
				if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, "SIGKILL");
				else proc.kill("SIGKILL");
			} catch {
				try { proc.kill("SIGKILL"); } catch {}
			}
		};
		const onAbort = () => {
			aborted = true;
			killTree();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		proc.stdout?.on("data", (d: Buffer) => {
			output += d.toString();
		});
		proc.stderr?.on("data", (d: Buffer) => {
			output += d.toString();
		});
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		proc.on("close", (code) => {
			cleanup();
			if (aborted) {
				resolve({ code: 130, output: `${output}\n[stopped by user]`, aborted: true });
				return;
			}
			resolve({ code: timedOut ? 124 : (code ?? 0), output: timedOut ? `${output}\n[gate timed out]` : output });
		});
		proc.on("error", (err) => {
			cleanup();
			resolve({ code: 127, output: `${output}\nspawn error: ${String(err)}` });
		});
		const timer = setTimeout(() => {
			timedOut = true;
			killTree();
		}, timeoutMs);
	});
}
