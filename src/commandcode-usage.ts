import type { UsageLimit, UsageReport, UsageStatus } from "@oh-my-pi/pi-ai";

import { buildHeaders, PROVIDER_ID, resolveBaseUrl } from "./api";
import {
	isFiniteJsonNumber,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "./guards";

export interface CommandCodeWhoami {
	/** The account's userId — the gateway keys usage queries on this, not org. */
	userId: string;
	userName?: string;
	orgId?: string;
	orgLogin?: string;
}

export interface CommandCodeWindowLimit {
	used: number;
	cap: number | undefined;
	exceeded: boolean;
	resetAt?: number;
}

export interface CommandCodeCredits {
	monthlyCredits: number;
	purchasedCredits: number;
	freeCredits: number;
	planId?: string;
	fiveHour?: CommandCodeWindowLimit;
	weekly?: CommandCodeWindowLimit;
}

export interface CommandCodeSubscription {
	planId?: string;
	status?: string;
	currentPeriodStart?: string;
	currentPeriodEnd?: string;
}

export interface CommandCodeSummary {
	totalCost: number;
	totalTokens?: number;
	totalCount?: number;
	topModels?: string[];
}

export const PLAN_NAMES = {
	"individual-free": "Free",
	"individual-plus": "Plus",
	"individual-ultra": "Ultra",
	"teams-pro": "Teams Pro",
} satisfies Readonly<Record<string, string>>;

const WARNING_FRACTION = 0.8;

export function parseWhoami(raw: JsonValue | undefined): CommandCodeWhoami | null {
	if (!isJsonObject(raw)) return null;
	const root = raw;
	const data = isJsonObject(root.data) ? root.data : root;
	const user = isJsonObject(data.user) ? data.user : undefined;
	const userId = user && isJsonString(user.id) && user.id.length > 0 ? user.id : undefined;
	if (!userId) return null;

	const userName =
		user && isJsonString(user.userName) && user.userName.length > 0 ? user.userName : undefined;

	const org = isJsonObject(data.org) ? data.org : undefined;
	const orgId = org && isJsonString(org.id) && org.id.length > 0 ? org.id : undefined;
	const orgLogin = org && isJsonString(org.login) && org.login.length > 0 ? org.login : undefined;

	return { userId, userName, orgId, orgLogin };
}

function parseWindowLimit(raw: JsonValue | undefined): CommandCodeWindowLimit | undefined {
	if (!isJsonObject(raw)) return undefined;
	const used = isFiniteJsonNumber(raw.used) ? raw.used : undefined;
	if (used === undefined) return undefined;
	const cap = isFiniteJsonNumber(raw.cap) ? raw.cap : undefined;
	const exceeded = raw.exceeded === true;
	const resetAt = isFiniteJsonNumber(raw.resetAt) ? raw.resetAt : undefined;
	return { used, cap, exceeded, resetAt };
}

export function parseCredits(
	raw: JsonValue | undefined,
	_orgId?: string,
): CommandCodeCredits | null {
	if (!isJsonObject(raw)) return null;
	const root = raw;
	const data = isJsonObject(root.data) ? root.data : root;
	const credits = isJsonObject(data.credits) ? data.credits : undefined;
	if (!credits) return null;

	const monthly = isFiniteJsonNumber(credits.monthlyCredits) ? credits.monthlyCredits : undefined;
	const purchased = isFiniteJsonNumber(credits.purchasedCredits)
		? credits.purchasedCredits
		: undefined;
	const free = isFiniteJsonNumber(credits.freeCredits) ? credits.freeCredits : undefined;

	if (monthly === undefined && purchased === undefined && free === undefined) return null;

	const planId =
		isJsonString(credits.planId) && credits.planId.length > 0 ? credits.planId : undefined;

	const windowLimits = isJsonObject(data.windowLimits) ? data.windowLimits : undefined;
	const fiveHour = parseWindowLimit(windowLimits?.fiveHour);
	const weekly = parseWindowLimit(windowLimits?.weekly);

	return {
		monthlyCredits: monthly ?? 0,
		purchasedCredits: purchased ?? 0,
		freeCredits: free ?? 0,
		planId,
		fiveHour,
		weekly,
	};
}

export function parseSubscription(
	raw: JsonValue | undefined,
	_orgId?: string,
): CommandCodeSubscription | null {
	if (!isJsonObject(raw)) return null;
	const root = raw;
	const data = isJsonObject(root.data) ? root.data : root;
	const nested = isJsonObject(data.data) ? data.data : data;

	const planId =
		isJsonString(nested.planId) && nested.planId.length > 0 ? nested.planId : undefined;
	const status =
		isJsonString(nested.status) && nested.status.length > 0 ? nested.status : undefined;
	const currentPeriodStart =
		isJsonString(nested.currentPeriodStart) && nested.currentPeriodStart.length > 0
			? nested.currentPeriodStart
			: undefined;
	const currentPeriodEnd =
		isJsonString(nested.currentPeriodEnd) && nested.currentPeriodEnd.length > 0
			? nested.currentPeriodEnd
			: undefined;

	if (!planId && !status && !currentPeriodStart && !currentPeriodEnd) return null;

	return { planId, status, currentPeriodStart, currentPeriodEnd };
}

export function parseSummary(raw: JsonValue | undefined): CommandCodeSummary | null {
	if (!isJsonObject(raw)) return null;
	const root = raw;
	const data = isJsonObject(root.data) ? root.data : root;

	const totalCost = isFiniteJsonNumber(data.totalCost) ? data.totalCost : undefined;
	const totalTokens = isFiniteJsonNumber(data.totalTokens) ? data.totalTokens : undefined;
	const totalCount = isFiniteJsonNumber(data.totalCount) ? data.totalCount : undefined;
	if (totalCost === undefined) return null;

	let topModels: string[] | undefined;
	if (isJsonObject(data.costByModel)) {
		const byModel = data.costByModel;
		const ranked = Object.entries(byModel)
			.map(([model, cost]) => ({ model, cost: isJsonNumber(cost) ? cost : 0 }))
			.filter((entry) => entry.cost > 0)
			.sort((a, b) => b.cost - a.cost)
			.slice(0, 3)
			.map((entry) => entry.model);
		if (ranked.length > 0) topModels = ranked;
	}

	return { totalCost, totalTokens, totalCount, topModels };
}

function statusFor(usedFraction: number | undefined): UsageStatus {
	if (usedFraction === undefined) return "unknown";
	if (usedFraction >= 1) return "exhausted";
	if (usedFraction >= WARNING_FRACTION) return "warning";
	return "ok";
}

function parseIsoMs(iso: string | undefined): number | undefined {
	if (!iso) return undefined;
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? ms : undefined;
}

export interface BuildUsageReportInput {
	whoami: CommandCodeWhoami;
	credits: CommandCodeCredits;
	subscription: CommandCodeSubscription | null;
	summary: CommandCodeSummary | null;
	fetchedAt: number;
}

export function buildUsageReport(input: BuildUsageReportInput): UsageReport {
	const { whoami, credits, subscription, summary, fetchedAt } = input;
	const remaining = credits.monthlyCredits + credits.purchasedCredits + credits.freeCredits;
	const used = summary?.totalCost ?? 0;
	const total = used + remaining;
	const usedFraction = total > 0 ? used / total : undefined;
	const accountId = whoami.userId;
	const scope = { provider: PROVIDER_ID, shared: true, accountId };
	const planId = subscription?.planId ?? credits.planId;
	const resetsAt = parseIsoMs(subscription?.currentPeriodEnd);

	const limits: UsageLimit[] = [];

	if (credits.fiveHour || credits.weekly) {
		for (const [source, windowId, label] of [
			["fiveHour", "5h", "Command Code Usage (5h)"],
			["weekly", "7d", "Command Code Usage (7d)"],
		] as const) {
			const win = credits[source];
			if (!win) continue;
			const fraction = win.cap && win.cap > 0 ? win.used / win.cap : undefined;
			limits.push({
				id: `commandcode:usage:${windowId}`,
				label,
				scope: { ...scope, windowId },
				window: win.resetAt ? { id: windowId, label, resetsAt: win.resetAt } : undefined,
				amount: {
					used: win.used,
					limit: win.cap,
					usedFraction: fraction,
					unit: "usd",
				},
				status: statusFor(fraction),
				notes: win.exceeded ? ["Limit reached"] : undefined,
			});
		}
	}

	limits.push({
		id: "commandcode:credits",
		label: "Command Code Credits",
		scope: { ...scope, windowId: "monthly" },
		window: resetsAt
			? {
					id: "monthly",
					label: "Monthly limit",
					resetsAt,
				}
			: undefined,
		amount: {
			used,
			limit: total > 0 ? total : undefined,
			remaining,
			usedFraction,
			unit: "usd",
		},
		status: statusFor(usedFraction),
	});

	return {
		provider: PROVIDER_ID,
		fetchedAt,
		limits,
		notes: ["Credits are Command Code's own currency; USD figures come from its usage summary."],
		metadata: {
			endpoint: "commandcode",
			account: whoami.userName ?? whoami.orgLogin ?? whoami.userId,
			accountId: whoami.userId,
			orgId: whoami.orgId,
			planId,
			status: subscription?.status,
			fetchedAt,
		},
	};
}

export interface CommandCodeUsageOptions {
	apiKey: string;
	baseUrl?: string;
	sessionId?: string;
	projectSlug?: string;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
}

async function getJson(
	fetchImpl: typeof fetch,
	url: string,
	headers: Record<string, string>,
	signal: AbortSignal | undefined,
): Promise<JsonValue | null> {
	try {
		const response = await fetchImpl(url, { method: "GET", headers, signal });
		if (!response.ok) return null;
		// SAFETY: JSON.parse (via res.json()) produces exactly a JsonValue; the
		// callers re-check every field they read through the guards above.
		return (await response.json()) as JsonValue;
	} catch {
		return null;
	}
}

export async function fetchCommandCodeUsage(
	options: CommandCodeUsageOptions,
): Promise<UsageReport | null> {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const baseUrl = options.baseUrl ?? resolveBaseUrl();
	const sessionId = options.sessionId ?? crypto.randomUUID();
	const headers = buildHeaders(options.apiKey, {
		sessionId,
		projectSlug: options.projectSlug ?? "0000000000",
	});
	const signal = options.signal;

	const whoami = parseWhoami(await getJson(fetchImpl, `${baseUrl}/alpha/whoami`, headers, signal));
	if (!whoami) return null;

	const userQuery = `userId=${encodeURIComponent(whoami.userId)}`;
	const [creditsRaw, subscriptionRaw] = await Promise.all([
		getJson(fetchImpl, `${baseUrl}/alpha/billing/credits?${userQuery}`, headers, signal),
		getJson(fetchImpl, `${baseUrl}/alpha/billing/subscriptions?${userQuery}`, headers, signal),
	]);
	const credits = parseCredits(creditsRaw);
	if (!credits) return null;
	const subscription = parseSubscription(subscriptionRaw);

	let summary: CommandCodeSummary | null = null;
	const since = subscription?.currentPeriodStart;
	if (since) {
		summary = parseSummary(
			await getJson(
				fetchImpl,
				`${baseUrl}/alpha/usage/summary?${userQuery}&since=${encodeURIComponent(since)}`,
				headers,
				signal,
			),
		);
	}

	return buildUsageReport({ whoami, credits, subscription, summary, fetchedAt: Date.now() });
}

/**
 * Fetch a Command Code usage report for every stored api-key credential.
 * Used by /usage-commandcode so each logged-in account renders its own section.
 */
export async function fetchCommandCodeUsageForKeys(
	keys: readonly string[],
	options: Omit<CommandCodeUsageOptions, "apiKey">,
): Promise<UsageReport[]> {
	const seen = new Set<string>();
	const reports: UsageReport[] = [];
	for (const apiKey of keys) {
		// One account fails independently of the others; a bad key must not
		// hide the remaining accounts, so each fetch is isolated here.
		let report: UsageReport | null = null;
		try {
			report = await fetchCommandCodeUsage({ ...options, apiKey });
		} catch {
			// skip this account
		}
		if (!report) continue;
		const accountId = report.metadata?.accountId ?? report.metadata?.userId;
		if (isJsonString(accountId) && seen.has(accountId)) continue;
		if (isJsonString(accountId)) seen.add(accountId);
		reports.push(report);
	}
	return reports;
}

export async function fetchCommandCodeUsageReports(
	options: CommandCodeUsageOptions,
): Promise<UsageReport[] | null> {
	const report = await fetchCommandCodeUsage(options);
	return report ? [report] : null;
}

export function mergeCommandCodeReport(
	existing: UsageReport[] | null,
	report: UsageReport | null,
): UsageReport[] | null {
	if (!report) return existing;
	const others = (existing ?? []).filter((entry) => entry.provider !== PROVIDER_ID);
	return [...others, report];
}
