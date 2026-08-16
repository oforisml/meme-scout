import pino from "pino";
import { config } from "./config.js";

/**
 * Secret scrubbing on the way into the log.
 *
 * The Helius key is embedded in the RPC and websocket URLs, so any error that
 * quotes the URL it failed on carries the key into the logs — and from there
 * into pm2 files, terminal scrollback, and anything pasted into a chat or an
 * issue. Today's 429s happened not to include the URL, but that was the error
 * type's choice, not ours.
 *
 * pino's `redact` cannot help here: it removes whole FIELDS by path, and the
 * secret lives inside a URL string nested somewhere in an error's message or
 * stack. So the scrub is a value walk instead.
 */
function secrets(): string[] {
  // BACKUP_RCLONE_REMOTE is deliberately absent: it is a remote NAME
  // (`gdrive:backups`), not a credential, and listing it would mangle every
  // backup log line for no security gain.
  return [config.HELIUS_API_KEY, config.JUPITER_API_KEY, config.TELEGRAM_BOT_TOKEN, process.env.WEB_PASSWORD ?? ""]
    // Short values would match everywhere and turn the logs into asterisks.
    .filter((s) => typeof s === "string" && s.length >= 8);
}

const SECRETS = secrets();

export function scrubText(s: string): string {
  let out = s;
  for (const secret of SECRETS) out = out.split(secret).join("«redacted»");
  return out;
}

const MAX_DEPTH = 8;

/**
 * Depth-limited so a cycle or an enormous object cannot stall logging — and
 * fail-CLOSED at the limit: strings are scrubbed at any depth, and it is the
 * container that gets dropped, never a string passed through unexamined.
 */
export function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrubText(value);
  if (typeof value !== "object" || value === null) return value;
  if (depth > MAX_DEPTH) return "[deep]";

  if (value instanceof Error) {
    // Flattened deliberately: pino's error serializer produces this shape
    // anyway, and rebuilding an Error to re-serialize it risks carrying an
    // unscrubbed property through.
    //
    // `cause` is the important part. undici reports a failed fetch as a bare
    // "fetch failed" and puts the URL — the thing holding the key — in
    // `cause`, which is non-enumerable and so invisible to Object.entries.
    // Scrubbing it rather than dropping it keeps the log diagnostic.
    const out: Record<string, unknown> = {
      type: value.name,
      message: scrubText(value.message),
      stack: value.stack ? scrubText(value.stack) : undefined,
    };
    if (value.cause !== undefined) out.cause = scrub(value.cause, depth + 1);
    // web3.js hangs `code` and `data` off its RPC errors as own properties.
    for (const [k, v] of Object.entries(value)) {
      if (!(k in out)) out[k] = scrub(v, depth + 1);
    }
    return out;
  }

  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = scrub(v, depth + 1);
  }
  return out;
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  serializers: {
    // `scrub` has already flattened the error to pino's own {type, message,
    // stack} shape. Letting pino's serializer run over that result again
    // relabels every error `type: "Object"`, losing the class name — which is
    // the field that tells a SolanaJSONRPCError from a fetch failure.
    err: (e: unknown) => e,
  },
  hooks: {
    // Every call site funnels through here, so nothing has to remember to
    // scrub at the point of logging.
    logMethod(args, method) {
      return method.apply(this, args.map((a) => scrub(a)) as Parameters<typeof method>);
    },
  },
  transport: { target: "pino-pretty", options: { colorize: true } },
});

/**
 * Route crashes through the scrubbing logger.
 *
 * Node's default handler prints the raw stack straight to stderr, bypassing
 * pino entirely — and a web3.js `Connection` failure names the endpoint it
 * failed on, key and all. That default is the one output path the hook above
 * cannot see.
 *
 * It still exits non-zero. Logging and carrying on would turn a crash into a
 * zombie that pm2 never restarts, and FR-G2's dead-man switch depends on
 * restarts actually happening.
 *
 * Not installed on import: entrypoints call it, so importing the logger in a
 * test does not hijack the test runner's own crash handling.
 */
export function installCrashHandlers(): void {
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaught exception — exiting");
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "unhandled rejection — exiting");
    process.exit(1);
  });
}
