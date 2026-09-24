import { requestUrl, TFile } from "obsidian";
import { ICSSubscription, ICSEvent, ICSCache } from "../types";
import { EventEmitter } from "../utils/EventEmitter";
import TaskNotesPlugin from "../main";
import type { InterpolationValues, TranslationKey } from "../i18n";
import { createTaskNotesLogger } from "../utils/tasknotesLogger";
import { publishUserNotice } from "../core/userNotices";
import { parseICSEvents } from "../utils/icsParsing";

const tasknotesLogger = createTaskNotesLogger({ tag: "Services/ICSSubscriptionService" });

type VaultAdapterWithBasePath = {
	getBasePath?: () => string;
};

export class ICSSubscriptionService extends EventEmitter {
	private plugin: TaskNotesPlugin;
	private subscriptions: ICSSubscription[] = [];
	private cache: Map<string, ICSCache> = new Map();
	private refreshTimers: Map<string, number> = new Map();
	private fileWatchers: Map<string, () => void> = new Map(); // For local file change tracking
	private pendingRefreshes: Set<string> = new Set(); // Track in-progress refreshes to avoid duplicates
	private lastFetched: Map<string, string> = new Map(); // In-memory storage for last fetch timestamps (ISO strings)
	private lastError: Map<string, string> = new Map(); // In-memory storage for last error messages
	private destroyed = false;

	// Grace period after cache expiration to show stale data while refreshing (5 minutes)
	private readonly CACHE_GRACE_PERIOD = 5 * 60 * 1000;

	private translate(key: TranslationKey, variables?: InterpolationValues): string {
		return this.plugin.i18n.translate(key, variables);
	}

	constructor(plugin: TaskNotesPlugin) {
		super();
		this.plugin = plugin;
	}

	async initialize(): Promise<void> {
		this.destroyed = false;
		// Load subscriptions from plugin data
		await this.loadSubscriptions();

		// Start refresh timers and file watchers for enabled subscriptions
		// Also immediately fetch subscriptions that don't have valid cache
		const fetchPromises: Promise<void>[] = [];
		this.subscriptions.forEach((subscription) => {
			if (subscription.enabled) {
				if (subscription.type === "remote") {
					this.startRefreshTimer(subscription);
				} else if (subscription.type === "local") {
					this.startFileWatcher(subscription);
				}

				// Immediately fetch if no cache or cache is expired
				const cache = this.cache.get(subscription.id);
				if (!cache || new Date(cache.expires) <= new Date()) {
					fetchPromises.push(this.fetchSubscription(subscription.id));
				}
			}
		});

		// Wait for initial fetches to complete
		await Promise.allSettled(fetchPromises);

		// Emit initial data load
		this.emit("data-changed");
	}

	private async loadSubscriptions(): Promise<void> {
		try {
			const data = (await this.plugin.loadData()) as {
				icsSubscriptions?: ICSSubscription[];
			} | null;
			this.subscriptions = data?.icsSubscriptions || [];
		} catch (error) {
			tasknotesLogger.error("Failed to load ICS subscriptions:", {
				category: "provider",
				operation: "load-ics-subscriptions",
				error: error,
			});
			this.subscriptions = [];
		}
	}

	private async saveSubscriptions(): Promise<void> {
		try {
			const data = await this.plugin.loadPluginDataForSafeWrite("save-ics-subscriptions");
			if (!data) return;
			data.icsSubscriptions = this.subscriptions;
			await this.plugin.saveData(data);
		} catch (error) {
			tasknotesLogger.error("Failed to save ICS subscriptions:", {
				category: "provider",
				operation: "save-ics-subscriptions",
				error: error,
			});
			throw error;
		}
	}

	getSubscriptions(): ICSSubscription[] {
		return [...this.subscriptions];
	}

	getLastFetched(id: string): string | undefined {
		return this.lastFetched.get(id);
	}

	getLastError(id: string): string | undefined {
		return this.lastError.get(id);
	}

	async addSubscription(subscription: Omit<ICSSubscription, "id">): Promise<ICSSubscription> {
		const newSubscription: ICSSubscription = {
			...subscription,
			filePath:
				subscription.type === "local" && subscription.filePath
					? this.normalizeLocalICSFilePathIfPossible(subscription.filePath)
					: subscription.filePath,
			id: this.generateId(),
		};

		this.subscriptions.push(newSubscription);
		await this.saveSubscriptions();

		if (newSubscription.enabled) {
			if (newSubscription.type === "remote") {
				this.startRefreshTimer(newSubscription);
				// Immediately fetch the subscription
				await this.fetchSubscription(newSubscription.id);
			} else if (newSubscription.type === "local") {
				this.startFileWatcher(newSubscription);
				// Immediately read the local file
				await this.fetchSubscription(newSubscription.id);
			}
		}

		this.emit("data-changed");
		return newSubscription;
	}

	async updateSubscription(id: string, updates: Partial<ICSSubscription>): Promise<void> {
		const index = this.subscriptions.findIndex((sub) => sub.id === id);
		if (index === -1) {
			throw new Error("Subscription not found");
		}

		const oldSubscription = this.subscriptions[index];
		const normalizedUpdates: Partial<ICSSubscription> = { ...updates };
		if (typeof updates.filePath === "string") {
			normalizedUpdates.filePath = this.normalizeLocalICSFilePathIfPossible(updates.filePath);
		}

		const updatedSubscription = { ...oldSubscription, ...normalizedUpdates };
		this.subscriptions[index] = updatedSubscription;

		await this.saveSubscriptions();

		// Update refresh timer or file watcher
		this.stopRefreshTimer(id);
		this.stopFileWatcher(id);
		if (updatedSubscription.enabled) {
			if (updatedSubscription.type === "remote") {
				this.startRefreshTimer(updatedSubscription);
			} else if (updatedSubscription.type === "local") {
				this.startFileWatcher(updatedSubscription);
			}
		}

		// Clear cache if URL or file path changed
		if (
			(updates.url && updates.url !== oldSubscription.url) ||
			(updates.filePath && updates.filePath !== oldSubscription.filePath)
		) {
			this.cache.delete(id);
		}

		this.emit("data-changed");
	}

	async removeSubscription(id: string): Promise<void> {
		const index = this.subscriptions.findIndex((sub) => sub.id === id);
		if (index === -1) {
			throw new Error("Subscription not found");
		}

		this.subscriptions.splice(index, 1);
		await this.saveSubscriptions();

		// Clean up
		this.stopRefreshTimer(id);
		this.stopFileWatcher(id);
		this.cache.delete(id);
		this.lastFetched.delete(id);
		this.lastError.delete(id);

		this.emit("data-changed");
	}

	async fetchSubscription(id: string): Promise<void> {
		const subscription = this.subscriptions.find((sub) => sub.id === id);
		if (!subscription || !subscription.enabled) {
			return;
		}

		try {
			let icsData: string;

			if (subscription.type === "remote") {
				if (!subscription.url) {
					throw new Error("Remote subscription missing URL");
				}

				const response = await requestUrl({
					url: subscription.url,
					method: "GET",
					headers: {
						Accept: "text/calendar,*/*;q=0.1",
						"Accept-Language": "en-US,en;q=0.9",
						"User-Agent":
							"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
					},
				});

				icsData = response.text;
			} else if (subscription.type === "local") {
				if (!subscription.filePath) {
					throw new Error("Local subscription missing file path");
				}

				const normalizedFilePath = this.normalizeLocalICSFilePath(subscription.filePath);
				icsData = await this.readLocalICSFile(normalizedFilePath);
				if (subscription.filePath !== normalizedFilePath) {
					subscription.filePath = normalizedFilePath;
					await this.saveSubscriptions();
				}
			} else {
				throw new Error("Unknown subscription type");
			}

			const events = this.parseICS(icsData, subscription.id);

			// Update cache
			const cache: ICSCache = {
				subscriptionId: id,
				events,
				lastUpdated: new Date().toISOString(),
				expires: new Date(
					Date.now() + subscription.refreshInterval * 60 * 1000
				).toISOString(),
			};
			this.cache.set(id, cache);

			// Update in-memory metadata
			this.lastFetched.set(id, new Date().toISOString());
			this.lastError.delete(id);

			this.emit("data-changed");
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);

			// Update in-memory error
			this.lastError.set(id, errorMessage);

			// Show user notification for errors with more helpful message
			if (subscription.type === "remote") {
				if (errorMessage.includes("404")) {
					publishUserNotice(this.plugin.emitter,
						this.translate("services.icsSubscription.notices.calendarNotFound", {
							name: subscription.name,
						})
					);
				} else if (
					errorMessage.includes("500") ||
					errorMessage.includes("OwaBasicUnsupportedException")
				) {
					publishUserNotice(this.plugin.emitter,
						this.translate("services.icsSubscription.notices.calendarAccessDenied", {
							name: subscription.name,
						})
					);
				} else {
					publishUserNotice(this.plugin.emitter,
						this.translate("services.icsSubscription.notices.fetchRemoteFailed", {
							name: subscription.name,
							error: errorMessage,
						})
					);
				}
			} else {
				publishUserNotice(this.plugin.emitter,
					this.translate("services.icsSubscription.notices.readLocalFailed", {
						name: subscription.name,
						error: errorMessage,
					})
				);
			}
		}
	}

	private parseICS(icsData: string, subscriptionId: string): ICSEvent[] {
		return parseICSEvents(icsData, subscriptionId);
	}

	getAllEvents(): ICSEvent[] {
		const allEvents: ICSEvent[] = [];
		const now = new Date();

		// Check all enabled subscriptions, not just those with cache
		this.subscriptions.forEach((subscription) => {
			if (!subscription.enabled) {
				return;
			}

			const cache = this.cache.get(subscription.id);

			if (!cache) {
				// No cache exists - trigger immediate fetch
				if (!this.pendingRefreshes.has(subscription.id)) {
					this.pendingRefreshes.add(subscription.id);
					void this.fetchSubscription(subscription.id).finally(() =>
						this.pendingRefreshes.delete(subscription.id)
					);
				}
				return;
			}

			const expiryDate = new Date(cache.expires);
			const gracePeriodEnd = new Date(expiryDate.getTime() + this.CACHE_GRACE_PERIOD);

			// Return events if within grace period
			if (now < gracePeriodEnd) {
				allEvents.push(...cache.events);

				// Trigger refresh if cache expired but within grace period
				const isStale = now > expiryDate;
				if (isStale && !this.pendingRefreshes.has(subscription.id)) {
					this.pendingRefreshes.add(subscription.id);
					void this.fetchSubscription(subscription.id).finally(() =>
						this.pendingRefreshes.delete(subscription.id)
					);
				}
			} else {
				// Cache is expired beyond grace period - trigger fetch
				if (!this.pendingRefreshes.has(subscription.id)) {
					this.pendingRefreshes.add(subscription.id);
					void this.fetchSubscription(subscription.id).finally(() =>
						this.pendingRefreshes.delete(subscription.id)
					);
				}
			}
		});

		return allEvents;
	}

	getEventsForSubscription(subscriptionId: string): ICSEvent[] {
		const cache = this.cache.get(subscriptionId);
		if (!cache) {
			// No cache exists - trigger immediate fetch for enabled subscriptions
			const subscription = this.subscriptions.find((sub) => sub.id === subscriptionId);
			if (
				subscription &&
				subscription.enabled &&
				!this.pendingRefreshes.has(subscriptionId)
			) {
				this.pendingRefreshes.add(subscriptionId);
				void this.fetchSubscription(subscriptionId).finally(() =>
					this.pendingRefreshes.delete(subscriptionId)
				);
			}
			return [];
		}

		const now = new Date();
		const expiryDate = new Date(cache.expires);
		const gracePeriodEnd = new Date(expiryDate.getTime() + this.CACHE_GRACE_PERIOD);

		// Return events if within grace period
		if (now >= gracePeriodEnd) {
			// Cache expired beyond grace period - trigger fetch
			if (!this.pendingRefreshes.has(subscriptionId)) {
				this.pendingRefreshes.add(subscriptionId);
				void this.fetchSubscription(subscriptionId).finally(() =>
					this.pendingRefreshes.delete(subscriptionId)
				);
			}
			return [];
		}

		// Trigger refresh if cache expired but within grace period
		const isStale = now > expiryDate;
		if (isStale && !this.pendingRefreshes.has(subscriptionId)) {
			this.pendingRefreshes.add(subscriptionId);
			void this.fetchSubscription(subscriptionId).finally(() =>
				this.pendingRefreshes.delete(subscriptionId)
			);
		}

		return [...cache.events];
	}

	async refreshAllSubscriptions(): Promise<void> {
		const enabledSubscriptions = this.subscriptions.filter((sub) => sub.enabled);

		for (const subscription of enabledSubscriptions) {
			await this.fetchSubscription(subscription.id);
		}
	}

	private getVaultBasePath(): string | undefined {
		const adapter = this.plugin.app.vault.adapter as unknown as VaultAdapterWithBasePath;
		if (typeof adapter?.getBasePath !== "function") {
			return undefined;
		}

		try {
			const basePath = adapter.getBasePath();
			return typeof basePath === "string" && basePath.trim() ? basePath : undefined;
		} catch (error) {
			tasknotesLogger.warn("Failed to resolve vault base path for local ICS file:", {
				category: "provider",
				operation: "resolve-vault-base-path-local-ics-file",
				error: error,
			});
			return undefined;
		}
	}

	private normalizePathSeparators(filePath: string): string {
		return filePath
			.trim()
			.replace(/\\/g, "/")
			.replace(/^\.\/+/u, "");
	}

	private isAbsoluteFilePath(filePath: string): boolean {
		return filePath.startsWith("/") || /^[A-Za-z]:\//u.test(filePath);
	}

	private normalizeLocalICSFilePath(filePath: string): string {
		const normalizedPath = this.normalizePathSeparators(filePath);
		if (!this.isAbsoluteFilePath(normalizedPath)) {
			return normalizedPath;
		}

		const basePath = this.getVaultBasePath();
		if (basePath) {
			const normalizedBasePath = this.normalizePathSeparators(basePath).replace(/\/+$/u, "");
			if (normalizedPath.startsWith(`${normalizedBasePath}/`)) {
				return normalizedPath.slice(normalizedBasePath.length + 1);
			}
		}

		throw new Error(
			'Local ICS files must be inside the current Obsidian vault. Move the file into the vault or use a vault-relative path such as "Calendar.ics".'
		);
	}

	private normalizeLocalICSFilePathIfPossible(filePath: string): string {
		try {
			return this.normalizeLocalICSFilePath(filePath);
		} catch {
			return this.normalizePathSeparators(filePath);
		}
	}

	private async readLocalICSFile(filePath: string): Promise<string> {
		try {
			const normalizedFilePath = this.normalizeLocalICSFilePath(filePath);
			const file = this.plugin.app.vault.getAbstractFileByPath(normalizedFilePath);
			if (!file || !(file instanceof TFile)) {
				throw new Error(`File not found: ${normalizedFilePath}`);
			}

			if (file.extension !== "ics") {
				throw new Error(`File is not an ICS file: ${normalizedFilePath}`);
			}

			return await this.plugin.app.vault.cachedRead(file);
		} catch (error) {
			throw new Error(
				`Failed to read local ICS file "${filePath}": ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	private startFileWatcher(subscription: ICSSubscription): void {
		if (!subscription.filePath) {
			return;
		}

		this.stopFileWatcher(subscription.id);
		const watchedPath = this.normalizeLocalICSFilePathIfPossible(subscription.filePath);

		// Register file watcher with Obsidian's vault
		const watcherCallback = (file: TFile, oldPath?: string) => {
			if (file.path === watchedPath || oldPath === watchedPath) {
				// Debounce file changes to avoid excessive updates
				window.setTimeout(() => {
					void this.fetchSubscription(subscription.id);
				}, 1000);
			}
		};

		// Register event handlers for file modifications
		const modifyRef = this.plugin.app.vault.on("modify", watcherCallback);
		const renameRef = this.plugin.app.vault.on("rename", watcherCallback);
		const deleteRef = this.plugin.app.vault.on("delete", (file) => {
			if (file.path === watchedPath) {
				this.lastError.set(subscription.id, "Local ICS file was deleted");
			}
		});

		// Store cleanup function
		this.fileWatchers.set(subscription.id, () => {
			this.plugin.app.vault.offref(modifyRef);
			this.plugin.app.vault.offref(renameRef);
			this.plugin.app.vault.offref(deleteRef);
		});

		// Set up periodic refresh for local files (less frequent than remote)
		this.startFileRefreshTimer(subscription);
	}

	private stopFileWatcher(id: string): void {
		const cleanup = this.fileWatchers.get(id);
		if (cleanup) {
			cleanup();
			this.fileWatchers.delete(id);
		}
	}

	async refreshSubscription(id: string): Promise<void> {
		await this.fetchSubscription(id);
	}

	private startRefreshTimer(subscription: ICSSubscription): void {
		this.stopRefreshTimer(subscription.id);
		this.startRemoteRefreshTimer(subscription);
	}

	private startFileRefreshTimer(subscription: ICSSubscription): void {
		const intervalMs = subscription.refreshInterval * 60 * 1000; // Convert minutes to milliseconds
		const timer = window.setTimeout(() => {
			this.refreshTimers.delete(subscription.id);
			void this.fetchSubscription(subscription.id).finally(() => {
				if (this.shouldContinueRefresh(subscription.id)) {
					this.startFileRefreshTimer(subscription);
				}
			});
		}, intervalMs);

		this.refreshTimers.set(subscription.id, timer);
	}

	private startRemoteRefreshTimer(subscription: ICSSubscription): void {
		const intervalMs = subscription.refreshInterval * 60 * 1000;
		const timer = window.setTimeout(() => {
			this.refreshTimers.delete(subscription.id);
			void this.fetchSubscription(subscription.id).finally(() => {
				if (this.shouldContinueRefresh(subscription.id)) {
					this.startRemoteRefreshTimer(subscription);
				}
			});
		}, intervalMs);

		this.refreshTimers.set(subscription.id, timer);
	}

	private shouldContinueRefresh(id: string): boolean {
		return !this.destroyed && this.subscriptions.some((item) => item.id === id && item.enabled);
	}

	private stopRefreshTimer(id: string): void {
		const timer = this.refreshTimers.get(id);
		if (timer) {
			window.clearTimeout(timer);
			this.refreshTimers.delete(id);
		}
	}

	private generateId(): string {
		return "ics_" + Math.random().toString(36).substring(2, 11) + Date.now().toString(36);
	}

	destroy(): void {
		this.destroyed = true;
		// Clear all timers
		this.refreshTimers.forEach((timer) => window.clearTimeout(timer));
		this.refreshTimers.clear();

		// Clear all file watchers
		this.fileWatchers.forEach((cleanup) => cleanup());
		this.fileWatchers.clear();

		// Clear cache
		this.cache.clear();

		// Clear pending refreshes
		this.pendingRefreshes.clear();

		// Clear event listeners
		this.removeAllListeners();
	}

	// Helper method to suggest local ICS files
	getLocalICSFiles(): TFile[] {
		return this.plugin.app.vault
			.getFiles()
			.filter((file) => file.extension === "ics")
			.sort((a, b) => a.path.localeCompare(b.path));
	}
}

