import type { HookContext, HookResult, PreHook, PostHook } from "./types"
import { classifyTool } from "./classifier"
import { buildTraceEntry, computeContentHash, updateActiveIntent, writeTrace, loadActiveIntents } from "./sidecarWriter"
import * as path from "path"

export class HookEngine {
	constructor(
		private readonly orchestrationDir: string,
		private readonly preHooks: PreHook[],
		private readonly postHooks: PostHook[],
	) {}

	public async runWithHooks<T>(
		ctx: HookContext,
		execute: () => Promise<T>,
	): Promise<{ result?: T; hookResult: HookResult }> {
		const enrichedCtx = { ...ctx, category: classifyTool(ctx) }
		for (const pre of this.preHooks) {
			const decision = await pre(enrichedCtx)
			if (!decision.allow) {
				await this.emitPostHooks(enrichedCtx, decision)
				await this.trace(enrichedCtx, decision)
				return { hookResult: decision }
			}
		}

		let resultValue: T | undefined
		let postDecision: HookResult = { allow: true }
		try {
			resultValue = await execute()
			postDecision = { allow: true, message: "ok" }
		} catch (error: any) {
			postDecision = { allow: false, isError: true, message: error?.message ?? String(error) }
		}

		await this.emitPostHooks(enrichedCtx, postDecision)
		await this.trace(enrichedCtx, postDecision)
		return { result: resultValue, hookResult: postDecision }
	}

	private async emitPostHooks(ctx: HookContext, result: HookResult): Promise<void> {
		for (const post of this.postHooks) {
			await post(ctx, result)
		}
	}

	private async trace(ctx: HookContext, result: HookResult): Promise<void> {
		const entry = buildTraceEntry(ctx, result)
		await writeTrace(this.orchestrationDir, entry)
	}
}

// Pre-hook: require active intent for destructive tools
export const requireActiveIntent: PreHook = async (ctx) => {
	if (ctx.category === "destructive" && !ctx.activeIntentId) {
		return { allow: false, isError: true, message: "No active intent selected. Call select_active_intent first." }
	}
	return { allow: true }
}

// Post-hook: update active_intents.yaml when intent present
export const syncActiveIntent: PostHook = async (ctx) => {
	if (ctx.activeIntentId && ctx.cwd) {
		await updateActiveIntent(ctx.cwd.replace(/\\/g, "/"), ctx.activeIntentId)
	}
}

// Pre-hook helper: add content hash if mutationSummary present
export const hashMutation: PreHook = async (ctx) => {
	if (ctx.mutationSummary && !ctx.contentHash) {
		ctx.contentHash = computeContentHash(ctx.mutationSummary)
	}
	return { allow: true }
}

// Pre-hook: enforce owned_scope from active_intents.yaml for destructive tools
export const enforceOwnedScope: PreHook = async (ctx) => {
	if (ctx.category !== "destructive") return { allow: true }
	if (!ctx.activeIntentId) return { allow: true }
	if (!ctx.cwd) return { allow: true }

	// Derive target path from common tool params (write_to_file, apply_diff, edit_file, etc.)
	const rawPath =
		(typeof ctx.params.path === "string" && ctx.params.path) ||
		(typeof ctx.params.file_path === "string" && ctx.params.file_path) ||
		""

	if (!rawPath) return { allow: true }

	const absoluteTarget = path.isAbsolute(rawPath) ? rawPath : path.join(ctx.cwd, rawPath)

	// Load intents and find the active one
	const intents = await loadActiveIntents(ctx.cwd.replace(/\\/g, "/"))
	const intent = intents.find((i) => i.id === ctx.activeIntentId)
	if (!intent || !intent.owned_scope || intent.owned_scope.length === 0) {
		// No scope defined → allow but this weakens guarantees; caller can tighten later.
		return { allow: true }
	}

	// Very small, dependency-free glob matcher for patterns like:
	// - "src/auth/**"
	// - "src/middleware/jwt.ts"
	const matchesScope = intent.owned_scope.some((pattern) => {
		const normalizedPattern = pattern.replace(/\\/g, "/")
		const normalizedTarget = absoluteTarget.replace(/\\/g, "/")

		if (normalizedPattern.endsWith("/**")) {
			const base = normalizedPattern.slice(0, -3) // drop "/**"
			return normalizedTarget.startsWith(base)
		}

		// Exact or prefix match for simple patterns
		return normalizedTarget.endsWith(normalizedPattern) || normalizedTarget.includes(`/${normalizedPattern}`)
	})

	if (!matchesScope) {
		return {
			allow: false,
			isError: true,
			message: `Scope Violation: intent ${ctx.activeIntentId} is not authorized to edit ${rawPath}. Request scope expansion or update owned_scope in .orchestration/active_intents.yaml.`,
		}
	}

	return { allow: true }
}
