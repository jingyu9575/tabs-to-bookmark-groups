import { M } from "../util/webext/i18n.js";
import { CriticalSection } from "../util/promise.js";
import { GroupState } from "../common/types.js";
import { getWindowTabsToSave } from "../common/common.js";
import { S } from "./settings.js";

const KEY_GROUP = 'group'

export class GroupManager {
	private static markerURL = browser.runtime.getURL('/pages/marker.html')
	private static transactionURL = browser.runtime.getURL(
		'/pages/transaction.html?committed=0')
	private static commitedTransactionURL = browser.runtime.getURL(
		'/pages/transaction.html?committed=1')

	private static urlConverter = new class {
		private prefix = browser.runtime.getURL('pages/url.html?')

		private readonly restrictedProtocols = new Set([
			'chrome:', 'javascript:', 'data:', 'file:', 'about:', 'blob:'
		])

		private parse(url: string) {
			if (url.startsWith(this.prefix)) {
				try {
					const { searchParams } = new URL(url)
					return {
						url: new URL(searchParams.get('url')!).href,
						active: !!Number(searchParams.get('active')),
					}
				} catch { }
			}
			return { url, active: false }
		}

		toBookmark(v: { url: string, active: boolean }) {
			const { url } = this.parse(v.url)
			if (!v.active) return url
			return this.prefix + new URLSearchParams({ url, active: '1' })
		}

		toTab(url: string) {
			const result = this.parse(url)
			const lc = result.url!.toLowerCase()
			if (lc === 'about:blank')
				return result
			if (lc === 'about:newtab' || lc === 'about:home')
				return { ...result, url: undefined }
			try {
				if (!this.restrictedProtocols.has(new URL(lc).protocol))
					return result
			} catch { }
			return {
				...result,
				url: this.prefix + new URLSearchParams({ url: result.url })
			}
		}
	}

	private readonly criticalSection = new CriticalSection()
	private rootId?: string
	private readonly windowGroupMap = new Map<number, string | undefined>()

	protected readonly initialization = this.criticalSection.sync(async () => {
		const windows = await browser.windows.getAll()
		const onCreated = async ({ id }: browser.windows.Window) => {
			browser.sessions.getWindowValue(id!, KEY_GROUP).then(
				group => { this.windowGroupMap.set(id!, group as string) })
		}
		browser.windows.onCreated.addListener(onCreated)
		browser.windows.onRemoved.addListener(id => this.windowGroupMap.delete(id))
		for (const w of windows) onCreated(w)
	})

	private async loadSubtree() {
		if (this.rootId !== undefined) {
			try {
				return (await browser.bookmarks.getSubTree(this.rootId))[0]
			} catch { }
		}

		const marker = (await browser.bookmarks.search({
			url: GroupManager.markerURL
		}))[0]

		if (marker) {
			this.rootId = marker.parentId!
		} else {
			const root = (await browser.bookmarks.create({
				index: 0, title: M.extensionName
			}))!
			await browser.bookmarks.create({
				parentId: root.id, index: 0,
				url: GroupManager.markerURL,
				title: M('bookmarkMarkerTitle', M.extensionName)
			})
			this.rootId = root.id
		}
		return (await browser.bookmarks.getSubTree(this.rootId))[0]
	}

	async listGroups(windowId: number) {
		return this.criticalSection.sync(async () => {
			const currentGroup = this.windowGroupMap.get(windowId)
			const lockedGroups = new Set(this.windowGroupMap.values())
			let hasOpenGroup = false
			const groups = (await this.loadSubtree()).children!
				.filter(v => v.type === 'folder').map(v => ({
					id: v.id as string | undefined,
					name: v.title,
					size: v.children!.length,
					state: v.id === currentGroup ? (hasOpenGroup = true, 'open') :
						lockedGroups.has(v.id) ? 'locked' : 'closed' as GroupState
				}))
			if (!hasOpenGroup) {
				groups.unshift({
					id: undefined, name: M.currentWindow, size: NaN, state: 'unsaved',
				})
			}
			return groups
		})
	}

	private async createGroupImpl(name: string) {
		if (this.rootId === undefined) await this.loadSubtree()
		return browser.bookmarks.create({
			parentId: this.rootId,
			title: name,
			index: Number.MAX_SAFE_INTEGER,
		})
	}
	createGroup(name: string) {
		return this.criticalSection.sync(() => this.createGroupImpl(name))
	}

	switchGroup(windowId: number, groupId?: string, newGroupName?: string) {
		return this.criticalSection.sync(async () => {
			let oldGroupId = this.windowGroupMap.get(windowId)
			try {
				if (oldGroupId && (await browser.bookmarks.get(oldGroupId))[0]
					.type !== 'folder')
					oldGroupId = undefined
			} catch { oldGroupId = undefined }

			// do not create new group with single blank tab, if not saving directly
			const oldTabs = await getWindowTabsToSave(windowId,
				oldGroupId === undefined && groupId !== undefined)

			if (oldGroupId === undefined && oldTabs.length) {
				if (newGroupName === undefined) newGroupName = M.unnamed
				oldGroupId = (await this.createGroupImpl(newGroupName))!.id
			}

			if (oldGroupId !== undefined) { // save old group
				const bookmarks = await browser.bookmarks.getChildren(oldGroupId)

				// TODO recovery
				const transaction = (await browser.bookmarks.create({
					parentId: oldGroupId,
					title: 'Transaction', url: GroupManager.transactionURL,
					index: Number.MAX_SAFE_INTEGER,
				}))!
				for (const { title, url, active } of oldTabs!)
					await browser.bookmarks.create({
						parentId: oldGroupId, title,
						url: GroupManager.urlConverter.toBookmark(
							{ url: url!, active }),
						index: Number.MAX_SAFE_INTEGER,
					})
				await browser.bookmarks.update(transaction.id, {
					title: 'Transaction (committed)',
					url: GroupManager.commitedTransactionURL,
				})
				for (const { id } of bookmarks)
					await browser.bookmarks.remove(id)
				await browser.bookmarks.remove(transaction.id)
			}

			if (groupId === undefined) {
				if (oldGroupId === undefined) return // unreachable
				groupId = oldGroupId
			}

			if (groupId !== oldGroupId) { // load new group
				this.windowGroupMap.set(windowId, undefined)
				await browser.sessions.removeWindowValue(windowId, KEY_GROUP)

				const bookmarks = await browser.bookmarks.getChildren(groupId)
				const coverTab = (await browser.tabs.create({
					windowId, active: true,
					url: bookmarks.length ? 'about:blank' : undefined,
					index: Number.MAX_SAFE_INTEGER,
				}))!
				for (; ;) {
					let tabs = (await browser.windows.get(windowId,
						{ populate: true })).tabs!
					if (S.excludePinnedTabs) tabs = tabs.filter(v => !v.pinned)
					const tabIds = tabs.map(v => v.id!)
					const filteredTabIds = tabIds.filter(v => v !== coverTab.id)
					if (filteredTabIds.length === tabIds.length) return
					if (!filteredTabIds.length) break
					await browser.tabs.remove(filteredTabIds)
				}
				if (bookmarks.length) {
					let activeTab: browser.tabs.Tab | undefined
					for (const { url } of bookmarks) {
						const t = GroupManager.urlConverter.toTab(url!)
						try {
							const tab = await browser.tabs.create({
								windowId, url: t.url,
								discarded: S.discardInactiveTabs,
								index: Number.MAX_SAFE_INTEGER,
							})
							if (!activeTab || t.active) activeTab = tab
						} catch (error) { console.error(error) }
					}
					if (activeTab) browser.tabs.update(activeTab.id!, { active: true })
					await browser.tabs.remove(coverTab.id!)
				}
			}

			this.windowGroupMap.set(windowId, groupId)
			await browser.sessions.setWindowValue(windowId, KEY_GROUP, groupId)
		})
	}
}