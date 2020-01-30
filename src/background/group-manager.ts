import { M } from "../util/webext/i18n.js";
import { CriticalSection } from "../util/promise.js";
import { GroupState } from "../common/types.js";
import { getWindowTabsToSave } from "../common/common.js";
import { S } from "./settings.js";

const KEY_GROUP = 'group'

type TabsCreateDetails = Parameters<typeof browser.tabs.create>[0]

export class GroupManager {
	private static markerURL = browser.runtime.getURL('/pages/marker.html')
	private static transactionURL = browser.runtime.getURL(
		'/pages/transaction.html?committed=0')
	private static commitedTransactionURL = browser.runtime.getURL(
		'/pages/transaction.html?committed=1')

	private static converter = new class {
		private readonly restrictedURL = browser.runtime.getURL('pages/url.html?')

		private readonly restrictedProtocols = new Set([
			'chrome:', 'javascript:', 'data:', 'file:', 'about:', 'blob:'
		])

		private readonly prefixes = [ // reverse order
			{ key: 'active', prefix: '\u25B6\uFE0E' },
			{ key: 'pinned', prefix: '\uD83D\uDCCC\uFE0E' },
		] as const

		toBookmark(tab: browser.tabs.Tab): browser.bookmarks.CreateDetails {
			let url = tab.url!
			if (url.startsWith(this.restrictedURL)) {
				try {
					const { searchParams } = new URL(url)
					url = new URL(searchParams.get('url')!).href
				} catch { }
			}
			let title = this.trimPrefix(tab.title || url, {})
			for (const { key, prefix } of this.prefixes)
				if (tab[key])
					title = prefix + ' ' + title
			return { url, title }
		}

		private trimPrefix(title: string, result: TabsCreateDetails): string {
			for (const { key, prefix } of this.prefixes) {
				if (!title.startsWith(prefix)) continue
				result[key] = true
				return this.trimPrefix(title.slice(prefix.length).trimStart(), result)
			}
			return title
		}

		toTab(bookmark: browser.bookmarks.BookmarkTreeNode): TabsCreateDetails {
			let url: string | undefined = bookmark.url!
			const lc = url.toLowerCase()
			if (lc === 'about:newtab' || lc === 'about:home')
				url = undefined
			else try {
				if (this.restrictedProtocols.has(new URL(lc).protocol)
					&& lc !== 'about:blank')
					url = this.restrictedURL + new URLSearchParams({ url })
			} catch { }

			const details: TabsCreateDetails = {}
			const title = this.trimPrefix(bookmark.title, details)
			return { url, title, ...details }
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
				for (const tab of oldTabs!)
					await browser.bookmarks.create({
						parentId: oldGroupId,
						index: Number.MAX_SAFE_INTEGER,
						...GroupManager.converter.toBookmark(tab)
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
					for (const bookmark of bookmarks) {
						const v = GroupManager.converter.toTab(bookmark)
						v.discarded = S.discardInactiveTabs && !v.pinned && !!v.url &&
							!v.url.trimStart().toLowerCase().startsWith('about:')
						if (!v.discarded) delete v.title
						try {
							const tab = await browser.tabs.create({
								windowId, index: Number.MAX_SAFE_INTEGER,
								...v, active: false,
							})
							if (!activeTab || v.active) activeTab = tab
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