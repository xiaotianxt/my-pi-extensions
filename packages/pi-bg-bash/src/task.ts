// Task state shared by the registry, tools, logs and renderers.
import type { Marker } from "./logview.ts";

/** `killed` carries a `reason`; the rest end by themselves. */
export type TaskState = "running" | "exited" | "exit-unknown" | "killed";

/** The registry records kills separately because killing the wrapper leaves no exit marker. */
export type KillReason = "killed by agent" | "killed by user" | "timed out" | "log limit passed";

/** What became of the processes an ended task left in its group. */
export type Leftovers = "none" | "stopped" | "stuck";

export type Task = {
	id: string;
	command: string;
	cwd: string;
	logPath: string;
	pid: number;
	/** This task no longer owns its group number, even if a later launch reuses it. */
	groupRetired?: boolean;
	/** Random per task; only the wrapper knows it, so only its marker line counts. */
	nonce: string;
	/** Where the marker was found, once it has been. */
	marker?: Marker;
	/** Where the poller wrote the log-limit marker, so the view can cut it out. */
	limitMarker?: { start: number; end: number };
	/** Where the next marker search starts in the log. */
	scanFrom: number;
	startedAt: number;
	endedAt?: number;
	state: TaskState;
	exitCode?: number;
	/** Set when `state` is `killed`. */
	reason?: KillReason;
	/** When the poller kills the task: `startedAt` plus the background call's `timeout`. */
	deadline?: number;
	/** The group kill in progress, so a second request joins it. */
	killing?: Promise<"killed" | "gone" | "stuck">;
	/** The kill of what an ended task left running, so a second request joins it. */
	clearing?: Promise<Leftovers>;
	/** Where `bash_output` will next read; the completion tail never moves it. */
	readPosition: number;
	notified: boolean;
	/** Consecutive polls that failed to read the log for a reason other than it being missing. */
	readFailures: number;
	/** The `bash` call that started a task or was promoted to it, whose row shows its timer. */
	toolCallId?: string;
};
