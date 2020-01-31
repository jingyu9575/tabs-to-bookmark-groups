import { M } from "../util/webext/i18n.js";
import { CriticalSection } from "../util/promise.js";
import { GroupState } from "../common/types.js";
import { getWindowTabsToSave } from "../common/common.js";
import { S } from "./settings.js";
import { PartialTab, WindowManager } from "./window-manager.js";

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

		toBookmark(tab: PartialTab): browser.bookmarks.CreateDetails {
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
	private cachedRootId?: string
	private readonly windowGroupMap = new Map<number, string | undefined>()
	private readonly windowManager = new WindowManager()

	protected readonly initialization = this.criticalSection.sync(async () => {
		const windows = await browser.windows.getAll()
		const onCreated = async ({ id }: browser.windows.Window) => {
			browser.sessions.getWindowValue(id!, KEY_GROUP).then(
				group => { this.windowGroupMap.set(id!, group as string) })
		}
		browser.windows.onCreated.addListener(onCreated)
		this.windowManager.onWindowRemoved.listen((windowId, tabs) => {
			const groupId = this.windowGroupMap.get(windowId)
			if (groupId === undefined) return
			this.windowGroupMap.delete(windowId)
			this.criticalSection.sync(async () => {
				if (!await this.isValidGroupId(groupId)) return
				await this.saveGroupImpl(groupId, tabs)
			})
		})

		for (const w of windows) void onCreated(w)
	})

	private async rootId() {
		if (this.cachedRootId !== undefined) {
			try {
				const roots = await browser.bookmarks.get([this.cachedRootId])
				if (roots.length && roots[0].type === 'folder')
					return this.cachedRootId
			} catch { this.cachedRootId = undefined }
		}

		const markers = await browser.bookmarks.search({ url: GroupManager.markerURL })
		if (markers.length) {
			this.cachedRootId = markers[0].parentId!
		} else {
			const root = (await browser.bookmarks.create({
				index: 0, title: M.extensionName
			}))!
			await browser.bookmarks.create({
				parentId: root.id, index: 0,
				url: GroupManager.markerURL,
				title: M('bookmarkMarkerTitle', M.extensionName)
			})
			this.cachedRootId = root.id
		}
		return this.cachedRootId
	}

	listGroups(windowId: number) {
		return this.criticalSection.sync(async () => {
			const currentGroup = this.windowGroupMap.get(windowId)
			const lockedGroups = new Set(this.windowGroupMap.values())
			let hasOpenGroup = false
			const [root] = await browser.bookmarks.getSubTree(await this.rootId())
			const groups = root.children!.filter(v => v.type === 'folder').map(v => ({
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
		return browser.bookmarks.create({
			parentId: await this.rootId(),
			title: name,
			index: Number.MAX_SAFE_INTEGER,
		})
	}

	createGroup(name: string) {
		return this.criticalSection.sync(() => this.createGroupImpl(name))
	}

	private async saveGroupImpl(groupId: string, tabs: PartialTab[]) {
		const bookmarks = await browser.bookmarks.getChildren(groupId)
		// TODO recovery
		const transaction = (await browser.bookmarks.create({
			parentId: groupId,
			title: 'Transaction', url: GroupManager.transactionURL,
			index: Number.MAX_SAFE_INTEGER,
		}))!
		for (const tab of tabs!)
			await browser.bookmarks.create({
				parentId: groupId,
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

	switchGroup(windowId: number, groupId?: string, unsavedGroupName?: string) {
		return this.criticalSection.sync(async () => {
			let oldGroupId = this.windowGroupMap.get(windowId)
			if (!await this.isValidGroupId(oldGroupId)) oldGroupId = undefined

			// do not create new group with single blank tab, if not saving directly
			const oldTabs = await getWindowTabsToSave(windowId,
				oldGroupId === undefined && groupId !== undefined)

			if (oldGroupId === undefined && oldTabs.length
				&& unsavedGroupName !== undefined)
				oldGroupId = (await this.createGroupImpl(unsavedGroupName))!.id

			if (oldGroupId !== undefined) { // save old group
				await this.saveGroupImpl(oldGroupId, oldTabs)
			}

			if (groupId === undefined) {
				if (oldGroupId === undefined) return // unsaved window is closed
				groupId = oldGroupId
			}

			if (groupId !== oldGroupId) { // load new group
				this.windowGroupMap.set(windowId, undefined)
				await browser.sessions.removeWindowValue(windowId, KEY_GROUP)

				const bookmarks = await browser.bookmarks.getChildren(groupId)
				let coverTab: browser.tabs.Tab | undefined

				for (; ;) {
					let tabs = (await browser.windows.get(windowId,
						{ populate: true })).tabs!
					const allTabsLength = tabs.length
					if (S.excludePinnedTabs) tabs = tabs.filter(v => !v.pinned)
					if (coverTab) tabs = tabs.filter(v => v.id !== coverTab!.id)
					if (tabs.length === allTabsLength) {
						coverTab = await browser.tabs.create({
							windowId, active: true,
							url: bookmarks.length ? 'about:blank' : undefined,
							index: Number.MAX_SAFE_INTEGER,
						})
					}
					if (!tabs.length) break
					await browser.tabs.remove(tabs.map(v => v.id!))
				}
				if (bookmarks.length) {
					let activeTab: browser.tabs.Tab | undefined
					for (const bookmark of bookmarks) {
						const v = GroupManager.converter.toTab(bookmark)
						v.discarded = S.discardInactiveTabs && !!v.url &&
							!v.url.trimStart().toLowerCase().startsWith('about:')
						if (!v.discarded) delete v.title

						// workaround "Pinned tabs cannot be created and discarded"
						const discardedAndPinned = v.discarded && v.pinned
						if (discardedAndPinned) v.pinned = false

						try {
							const tab = await browser.tabs.create({
								windowId, index: Number.MAX_SAFE_INTEGER,
								...v, active: false,
							})
							if (!activeTab || v.active) activeTab = tab
							if (discardedAndPinned)
								await browser.tabs.update(tab!.id!, { pinned: true })
						} catch (error) { console.error(error) }
					}
					if (coverTab) {
						if (activeTab)
							browser.tabs.update(activeTab.id!, { active: true })
						await browser.tabs.remove(coverTab.id!)
					} // leave active tab as-is if !coverTab
				}
			}

			this.windowGroupMap.set(windowId, groupId)
			await browser.sessions.setWindowValue(windowId, KEY_GROUP, groupId)
		})
	}

	private async isValidGroupId(id?: string) {
		if (id === undefined) return false
		try {
			const bookmark = (await browser.bookmarks.get([id]))[0]
			return bookmark && bookmark.type === 'folder'
				&& bookmark.parentId === await this.rootId()
		} catch { return false }
	}
}