/**
 * agterm lifecycle hooks for pi.
 *
 * session_start      -> iTerm tab color start + agterm restore pin for this
 *                       pane: `pi --session <file>` (interactive tui only), so
 *                       a Re-run commands relaunch re-opens this conversation
 *                       instead of starting a fresh session
 * agent_start        -> agterm active + rename session to an AI summary of the
 *                       first user prompt (localllm GLM 5.3 Flash, in-process);
 *                       /skill:name expansions are unwrapped first, so the
 *                       title reflects the user's request, not the skill XML
 * tool_execution_end -> agterm active
 * agent_end          -> agterm completed
 * session_shutdown   -> iTerm tab color end + clear the restore pin, so an
 *                       exited pane goes back to automatic command capture
 *
 * The rename is done here (not via the Claude Code hook script): pi has no
 * ai-title records and passes no hook payload, so the old
 * agterm-session-title.sh always logged "no transcript" and never renamed.
 * The summary call goes through ctx.modelRegistry.complete() - a provider-neutral
 * nested model call - instead of spawning a headless pi.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOG = join(tmpdir(), "agterm-title.log");
function log(msg: string): void {
	try {
		appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);
	} catch {
		// never let logging break the hook
	}
}

const AGTERMCTL = "/opt/homebrew/bin/agtermctl";
const AGENT_STATUS = "/Users/Anton.Suslov/.config/agterm/agent-status/agterm-agent-status.sh";
const ITERM_TAB = "/Users/Anton.Suslov/.claude/hooks/iterm-tab-color.sh";

const SUMMARIZER = { provider: "localllm", modelId: "h200/nvidia/GLM-5.3-Flash-NVFP4" };
const MAX_WORDS = 5;
const MAX_CHARS = 40;

type Ctx = Parameters<Parameters<ExtensionAPI["on"]>[1]>[1];

function run(cmd: string, args: string[] = []): void {
	execFile(cmd, args, { timeout: 10_000 }, () => {});
}

/**
 * pi expands /skill:name into the full skill block, with the user's own text
 * (if any) appended after a blank line. Structure mirrors parseSkillBlock()
 * in pi's agent-session.js:
 *   <skill name="..." location="...">\n...\n</skill>\n\n<user text>
 * Extract the trailing user text so the title reflects the request, not the
 * skill XML. A skill invoked without arguments yields its name as the prompt.
 */
const SKILL_BLOCK_RE = /^<skill name="([^"]+)" location="[^"]+">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/;

function userPromptFromText(text: string): string {
	const match = text.match(SKILL_BLOCK_RE);
	if (!match) return text;
	return match[2]?.trim() || `skill: ${match[1]}`;
}

/** First user message text (string or content blocks), skill blocks resolved. */
function firstUserText(ctx: Ctx): string {
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role !== "user") continue;
		const content = msg.content;
		if (typeof content === "string") return userPromptFromText(content);
		if (Array.isArray(content)) {
			const block = content.find((b: any) => b?.type === "text");
			if (block?.text) return userPromptFromText(block.text as string);
		}
	}
	return "";
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b: any) => b?.type === "text" && typeof b.text === "string")
			.map((b: any) => b.text)
			.join(" ");
	}
	return "";
}

/** Single-quote a value for safe reuse in an agterm restore command line. */
function shQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Collapse whitespace, cap at MAX_WORDS words and MAX_CHARS characters. */
function tidy(raw: string): string {
	const flat = raw.replace(/["'`*_]+/g, "").replace(/\s+/g, " ").trim();
	const words = flat.split(" ").slice(0, MAX_WORDS).join(" ");
	const cut = words.length > MAX_CHARS ? words.slice(0, MAX_CHARS - 1).trimEnd() + "…" : words;
	return cut;
}

export default function (pi: ExtensionAPI) {
	let done = false;
	let started = false;

	const renameTo = (title: string) => {
		const sid = process.env.AGTERM_SESSION_ID;
		if (!sid || !title) return;
		done = true;
		run(AGTERMCTL, ["session", "rename", title, "--target", sid]);
	};

	const summarize = async (ctx: Ctx, prompt: string) => {
		const fallback = tidy(prompt);
		const model = ctx.modelRegistry.find(SUMMARIZER.provider, SUMMARIZER.modelId);
		if (!model) {
			log(`no model ${SUMMARIZER.provider}/${SUMMARIZER.modelId}; fallback`);
			renameTo(fallback);
			return;
		}
		try {
			const res = await ctx.modelRegistry.complete(
				model,
				{
					systemPrompt:
						`Summarize the user's request as a terminal tab title. ` +
						`Reply with at most ${MAX_WORDS} words, no quotes, no trailing punctuation, no explanation.`,
					messages: [{ role: "user", content: prompt.slice(0, 2000) }],
				},
				{ maxTokens: 256 },
			);
			const title = tidy(textOf(res.content));
			if (!title) log(`empty summary; raw=${JSON.stringify(textOf(res.content)).slice(0, 200)}`);
			renameTo(title || fallback);
			log(`summarized -> ${title || fallback}`);
		} catch (err) {
			log(`complete() failed: ${String(err)}; fallback`);
			renameTo(fallback);
		}
	};

	/** Shared agtermctl addressing for this pane's restore pin (null = skip). */
	const restorePinArgs = (ctx: Ctx): string[] | null => {
		const sid = process.env.AGTERM_SESSION_ID;
		if (!sid || ctx.mode !== "tui") return null; // not inside agterm, or headless/RPC run
		const pane = process.env.AGTERM_PANE;
		if (pane === "scratch") return null; // scratch terminals cannot have restore pins
		const args = ["--target", sid];
		if (process.env.AGTERM_PANE_ID) args.push("--pane-id", process.env.AGTERM_PANE_ID);
		// --pane doubles as the fallback slot when the pane id no longer resolves
		args.push("--pane", pane === "right" ? "split" : "primary");
		if (process.env.AGTERM_SOCKET) args.push("--socket", process.env.AGTERM_SOCKET);
		return args;
	};

	const runRestorePin = (label: string, args: string[]): void => {
		execFile(AGTERMCTL, args, { timeout: 10_000 }, (err, stdout, stderr) => {
			if (err) log(`restore pin ${label} failed: ${stderr || String(err)}`);
			else log(`restore pin ${label}: ${stdout.trim()}`);
		});
	};

	/**
	 * Pin this pane's agterm restore command to `pi --session <file>` so a
	 * Re-run commands relaunch resumes THIS conversation (the captured launch
	 * args would start a fresh session instead). The pin is written now and
	 * consumed on the next launch only - it never touches the running session.
	 */
	const setRestorePin = (ctx: Ctx): void => {
		const base = restorePinArgs(ctx);
		if (!base) return;
		const file = ctx.sessionManager.getSessionFile();
		if (!file) return; // --no-session has nothing to resume
		runRestorePin("set", ["session", "restore", `pi --session ${shQuote(file)}`, ...base]);
	};

	/**
	 * Drop the pin when this pi exits, so the pane goes back to automatic
	 * command capture and a Re-run commands relaunch does not re-open a dead
	 * conversation. session_start re-pins after any session replacement.
	 */
	const clearRestorePin = (ctx: Ctx): void => {
		const base = restorePinArgs(ctx);
		if (!base) return;
		runRestorePin("clear", ["session", "restore", "--clear", ...base]);
	};

	const maybeSummarize = async (ctx: Ctx): Promise<void> => {
		if (done || started) return;
		const prompt = firstUserText(ctx);
		if (!prompt) return;
		started = true;
		await summarize(ctx, prompt);
	};

	pi.on("session_start", (event, ctx) => {
		run(ITERM_TAB, ["start"]);
		setRestorePin(ctx);
	});
	pi.on("session_shutdown", (event, ctx) => {
		run(ITERM_TAB, ["end"]);
		clearRestorePin(ctx);
	});
	pi.on("agent_start", async (event, ctx) => {
		run(AGENT_STATUS, ["active", "--blink"]);
		void maybeSummarize(ctx); // interactive: the prompt is already in the branch
	});
	pi.on("tool_execution_end", async () => run(AGENT_STATUS, ["active", "--blink"]));
	pi.on("agent_end", async (event, ctx) => {
		run(AGENT_STATUS, ["completed", "--auto-reset"]);
		// headless: the prompt only lands after agent_start, and the process exits
		// right after this handler, so await the rename here
		await maybeSummarize(ctx);
	});
}
