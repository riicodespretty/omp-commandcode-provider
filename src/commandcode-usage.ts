import type { UsageLimit, UsageReport, UsageStatus } from "@oh-my-pi/pi-ai";

import { buildHeaders, PROVIDER_ID, resolveBaseUrl } from "./api";
import {
	isFiniteJsonNumber,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	lookup,
	type JsonValue,
} from "./guards";

export interface CommandCodeWhoami {
	orgId: string;
	orgLogin?: string;
	userName?: string;
}

export interface CommandCodeCredits {
	monthlyCredits: number;
	purchasedCredits: number;
	freeCredits: number;
	planId?: string;
}

export interface CommandCodeSubscription {
	planId?: string;
	status?: string;
	currentPeriodStart?: string;
	currentPeriodEnd?: string;
}

export interface CommandCodeSummary {
	totalCost: number;
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
	const org = isJsonObject(data.org) ? data.org : undefined;
	const orgId = org && isJsonString(org.id) && org.id.length > 0 ? org.id : undefined;
	if (!orgId) return null;

	const user = isJsonObject(data.user) ? data.user : undefined;
	const orgLogin = org && isJsonString(org.login) && org.login.length > 0 ? org.login : undefined;
	const userName =
		user && isJsonString(user.userName) && user.userName.length > 0 ? user.userName : undefined;

	return { orgId, orgLogin, userName };
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

	return {
		monthlyCredits: monthly ?? 0,
		purchasedCredits: purchased ?? 0,
		freeCredits: free ?? 0,
		planId,
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

	return { totalCost, topModels };
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
	const scope = { provider: PROVIDER_ID, shared: true, orgId: whoami.orgId };
	const planId = subscription?.planId ?? credits.planId;
	const resetsAt = parseIsoMs(subscription?.currentPeriodEnd);

	const limits: UsageLimit[] = [
		{
			id: "commandcode:credits",
			label: "Command Code Credits",
			scope,
			window: resetsAt
				? {
						id: "period",
						label: "Billing period",
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
		},
	];

	if (planId && credits.monthlyCredits > 0) {
		limits.push({
			id: `commandcode:plan:${planId}`,
			label: `Plan — ${lookup(PLAN_NAMES, planId) ?? planId}`,
			scope,
			amount: { limit: credits.monthlyCredits, unit: "usd" },
		});
	}

	if (summary && summary.totalCost > 0) {
		limits.push({
			id: "commandcode:summary",
			label: "Usage since period start",
			scope,
			amount: { used: summary.totalCost, unit: "usd" },
			notes: summary.topModels ? [`Top models: ${summary.topModels.join(", ")}`] : undefined,
		});
	}

	if (usedFraction !== undefined) {
		for (const [windowId, label] of [
			["7d", "Command Code Usage (7d)"],
			["5h", "Command Code Usage (5h)"],
		] as const) {
			limits.push({
				id: `commandcode:usage:${windowId}`,
				label,
				scope: { ...scope, windowId },
				window: resetsAt ? { id: windowId, label, resetsAt } : undefined,
				amount: { used, limit: total, remaining, usedFraction, unit: "usd" },
				status: statusFor(usedFraction),
			});
		}
	}

	return {
		provider: PROVIDER_ID,
		fetchedAt,
		limits,
		notes: ["Credits are Command Code's own currency; USD figures come from its usage summary."],
		metadata: {
			endpoint: "commandcode",
			account: whoami.userName ?? whoami.orgLogin ?? whoami.orgId,
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

	const orgQuery = `orgId=${encodeURIComponent(whoami.orgId)}`;
	const [creditsRaw, subscriptionRaw] = await Promise.all([
		getJson(fetchImpl, `${baseUrl}/alpha/billing/credits?${orgQuery}`, headers, signal),
		getJson(fetchImpl, `${baseUrl}/alpha/billing/subscriptions?${orgQuery}`, headers, signal),
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
				`${baseUrl}/alpha/usage/summary?${orgQuery}&since=${encodeURIComponent(since)}`,
				headers,
				signal,
			),
		);
	}

	return buildUsageReport({ whoami, credits, subscription, summary, fetchedAt: Date.now() });
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
