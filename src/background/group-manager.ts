import { M } from "../util/webext/i18n.js";
import { CriticalSection } from "../util/promise.js";
import { GroupState } from "../common/types.js";
import { getWindowTabsToSave, GroupColor } from "../common/common.js";
import { S, localSettings } from "./settings.js";
import { PartialTab, WindowManager } from "./window-manager.js";
import { remoteProxy } from "../util/webext/remote.js";
import { SimpleStorage, idbTransaction } from "../util/storage.js";
import { SimpleEventListener } from "../util/event.js";

const KEY_GROUP = 'group'

type TabsCreateDetails = Parameters<typeof browser.tabs.create>[0]

interface StoredTabInfo {
	cookieStoreId?: string
}

const panelRemote = remoteProxy<import('../panel/panel').PanelRemote>('PanelRemote')

const NO_CONTAINER = 'firefox-default'

export class GroupManager {
	private static markerURL = browser.runtime.getURL('/pages/marker.html')
	private static transactionURL = browser.runtime.getURL(
		'/pages/transaction.html?committed=0')
	private static commitedTransactionURL = browser.runtime.getURL(
		'/pages/transaction.html?committed=1')

	private static readonly symbolColorMap = new Map<string, GroupColor>([
		["\u{1F535}", "blue"],
		["\u{1F534}", "red"],
		["\u{1F7E0}", "orange"],
		["\u{1F7E3}", "purple"],
		["\u{1F7E1}", "yellow"],
		["\u{1F7E2}", "green"],
	])

	private static converter = new class {
		private readonly extURL = browser.runtime.getURL('pages/url.html?')

		private readonly restrictedProtocols = new Set([
			'chrome:', 'javascript:', 'data:', 'file:', 'about:', 'blob:'
		])

		private readonly prefixes = [ // reverse order
			{ key: 'active', prefix: '\u25B6\uFE0E' },
			{ key: 'pinned', prefix: '\uD83D\uDCCC\uFE0E' },
		] as const

		toBookmark(tab: PartialTab): browser.bookmarks.CreateDetails {
			let url = tab.url!
			if (url.startsWith(this.extURL)) {
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

		toTab(bookmark: browser.bookmarks.BookmarkTreeNode,
			discardFavicon: boolean): TabsCreateDetails {
			const details: TabsCreateDetails = {}
			const title = this.trimPrefix(bookmark.title, details)

			let url: string | undefined = bookmark.url!
			const lc = url.toLowerCase()
			if (lc === 'about:newtab' || lc === 'about:home')
				url = undefined
			else try {
				if ((discardFavicon ||
					this.restrictedProtocols.has(new URL(lc).protocol)
				) && lc !== 'about:blank') {
					const p = new URLSearchParams({ id: bookmark.id, url, title })
					if (discardFavicon) p.set('discardFavicon', '1')
					url = this.extURL + p
				}
			} catch { }

			return { url, title, ...details }
		}
	}

	private readonly criticalSection = new CriticalSection()
	private cachedRootId?: string
	private readonly windowGroupMap = new Map<number, string | undefined>()
	private readonly windowManager = new WindowManager()
	private readonly faviconStorage = SimpleStorage.create<string, string>('favicon')
	private readonly tabInfoStorage =
		SimpleStorage.create<string, StoredTabInfo>('tab-info')

	readonly onWindowUpdate = new SimpleEventListener<[{
		windowId: number, groupId?: string, name?: string, color?: GroupColor,
	}]>()

	private syncWrite<T>(fn: () => Promise<T>) {
		return this.criticalSection.sync(fn).finally(() => panelRemote.reload())
	}

	protected readonly initialization = this.syncWrite(async () => {
		await localSettings.initialization
		const windows = await browser.windows.getAll()
		const onCreated = async ({ id }: browser.windows.Window) => {
			browser.sessions.getWindowValue(id!, KEY_GROUP).then(group => {
				void this.setWindowGroup(id!, group as string)
			})
		}
		browser.windows.onCreated.addListener(onCreated)
		this.windowManager.onWindowRemoved.listen((windowId, tabs) => {
			const groupId = this.windowGroupMap.get(windowId)
			if (groupId === undefined) return
			this.windowGroupMap.delete(windowId)
			this.syncWrite(async () => {
				if (!await this.getGroupBookmark(groupId)) return
				await this.saveGroupImpl(groupId, tabs)
			})
		})

		for (const w of windows) void onCreated(w)

		this.schedulePruneSecondaryStorage()
		browser.idle.onStateChanged.addListener(state => {
			if (state === 'idle' && this.pruneSecondaryStorageScheduled)
				void this.pruneSecondaryStorage()
		})
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

	private getGroupNameColor(bookmark: browser.bookmarks.BookmarkTreeNode) {
		const color = GroupManager.symbolColorMap.get(bookmark.title.slice(0, 2))
		if (!color) return { name: bookmark.title }
		return { name: bookmark.title.slice(2).trimStart(), color }
	}

	private async setWindowGroup(windowId: number, groupId: string | undefined) {
		this.windowGroupMap.set(windowId, groupId)
		const bookmark = await this.getGroupBookmark(groupId)
		this.onWindowUpdate.dispatch(bookmark ? {
			windowId, groupId, ...this.getGroupNameColor(bookmark),
		} : { windowId })
	}

	listGroups(windowId?: number) {
		return this.criticalSection.sync(async () => {
			const currentGroup = windowId !== undefined ?
				this.windowGroupMap.get(windowId) : undefined
			const lockedGroups = new Set(this.windowGroupMap.values())
			let hasOpenGroup = false
			const [root] = await browser.bookmarks.getSubTree(await this.rootId())
			const groups = root.children!.filter(v => v.type === 'folder').map(v => ({
				id: v.id as string | undefined,
				...this.getGroupNameColor(v),
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
			title: (!S.autoSetColor ? '' : [...GroupManager.symbolColorMap.keys()][
				Math.floor(Math.random() * GroupManager.symbolColorMap.size)] + ' '
			) + name,
			index: Number.MAX_SAFE_INTEGER,
		})
	}

	createGroup(name: string) {
		return this.syncWrite(() => this.createGroupImpl(name))
	}

	private async saveGroupImpl(groupId: string, tabs: PartialTab[],
		append?: 'append') {
		let existingBookmarks: browser.bookmarks.BookmarkTreeNode[]
		let transactionBookmarkId: string
		if (!append) {
			existingBookmarks = await browser.bookmarks.getChildren(groupId)
			// TODO recovery
			transactionBookmarkId = (await browser.bookmarks.create({
				parentId: groupId,
				title: 'Transaction', url: GroupManager.transactionURL,
				index: Number.MAX_SAFE_INTEGER,
			}))!.id
		}

		const faviconURLUpdates: [string, string][] = []
		const tabInfoUpdates: [string, StoredTabInfo][] = []
		for (const tab of tabs!) {
			const promise = browser.bookmarks.create({
				parentId: groupId,
				index: Number.MAX_SAFE_INTEGER,
				...GroupManager.converter.toBookmark(tab)
			}) // await later
			let { favIconUrl, cookieStoreId } = tab
			// Bug 1497587: favIconUrl is data URL (at least Firefox 64+)
			if (!favIconUrl || favIconUrl.slice(0, 5).toLowerCase() !== 'data:')
				favIconUrl = ''
			const { id } = (await promise)!
			faviconURLUpdates.push([id, favIconUrl])
			tabInfoUpdates.push([id, { cookieStoreId }])
		}

		// secondary storage, no await
		void this.faviconStorage.then(storage => {
			storage.transaction('readwrite', async () => {
				for (const [id, favIconUrl] of faviconURLUpdates)
					void storage.set(id, favIconUrl)
			})
		})

		try {
			const storage = await this.tabInfoStorage
			await storage.transaction('readwrite', () => {
				for (const [id, info] of tabInfoUpdates)
					void storage.set(id, info)
				return storage.currentTransaction!
			})
		} catch (error) { console.error(error) }

		if (!append) {
			await browser.bookmarks.update(transactionBookmarkId!, {
				title: 'Transaction (committed)',
				url: GroupManager.commitedTransactionURL,
			})
			for (const { id } of existingBookmarks!)
				await browser.bookmarks.remove(id)
			await browser.bookmarks.remove(transactionBookmarkId!)
			this.schedulePruneSecondaryStorage()
		}
	}

	switchGroup(windowId: number, groupId?: string, unsavedGroupName?: string) {
		return this.syncWrite(async () => {
			let oldGroupId = this.windowGroupMap.get(windowId)
			if (!await this.getGroupBookmark(oldGroupId)) oldGroupId = undefined

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
				this.windowGroupMap.delete(windowId)
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
					const tabInfoStorage = await this.tabInfoStorage.catch(() => { })
					let activeTab: browser.tabs.Tab | undefined
					for (const bookmark of bookmarks) {
						const info = GroupManager.converter.toTab(bookmark,
							S.discardInactiveTabs && !!S.discardInactiveTabsFavicon)
						info.discarded = S.discardInactiveTabs &&
							!S.discardInactiveTabsFavicon && !!info.url &&
							!info.url.trimStart().toLowerCase().startsWith('about:')
						if (!info.discarded) delete info.title

						// workaround "Pinned tabs cannot be created and discarded"
						const discardedAndPinned = info.discarded && info.pinned
						if (discardedAndPinned) info.pinned = false

						if (tabInfoStorage) {
							const value = await tabInfoStorage.get(bookmark.id)
							if (value) {
								if (value.cookieStoreId &&
									value.cookieStoreId !== NO_CONTAINER)
									info.cookieStoreId = value.cookieStoreId
							}
						}

						for (; ;) try {
							const tab = await browser.tabs.create({
								windowId, index: Number.MAX_SAFE_INTEGER,
								...info, active: false,
							})
							if (!activeTab || info.active) activeTab = tab
							break
						} catch (error) {
							if (info.cookieStoreId &&
								info.cookieStoreId !== NO_CONTAINER &&
								error && /\bNo cookie store exists\b/
									.test(`${error.message}`)) {
								info.cookieStoreId = undefined
								continue
							}
							console.error(error)
							break
						}
					}
					if (coverTab) {
						if (activeTab)
							browser.tabs.update(activeTab.id!, { active: true })
						await browser.tabs.remove(coverTab.id!)
					} // leave active tab as-is if !coverTab
				}
			}

			void this.setWindowGroup(windowId, groupId)
			await browser.sessions.setWindowValue(windowId, KEY_GROUP, groupId)
		})
	}

	deleteGroup(groupId: string) {
		return this.syncWrite(async () => {
			for (const [windowId, entryGroupId] of this.windowGroupMap)
				if (entryGroupId === groupId)
					this.setWindowGroup(windowId, undefined)
			await browser.bookmarks.removeTree(groupId)
			this.schedulePruneSecondaryStorage()
		})
	}

	private async getGroupBookmark(id?: string) {
		if (id === undefined) return undefined
		try {
			const bookmark = (await browser.bookmarks.get([id]))[0]
			if (bookmark && bookmark.type === 'folder'
				&& bookmark.parentId === await this.rootId())
				return bookmark
		} catch { }
		return undefined
	}

	private pruneSecondaryStorageScheduled = false

	private async pruneSecondaryStorage() {
		this.pruneSecondaryStorageScheduled = false
		const storages = [await this.faviconStorage, await this.tabInfoStorage]

		// not in critical section; assume favicon is saved after bookmarks
		const [root] = await browser.bookmarks.getSubTree(await this.rootId())
		const idList: string[] = []
		function addSubTree(node: typeof root) {
			idList.push(node.id)
			if (node.children) node.children.forEach(addSubTree)
		}
		addSubTree(root)
		const idSet = new Set<string>(idList)

		for (const storage of storages) {
			const existingKeys = await storage.keys()
			void storage.transaction('readwrite', async () => {
				for (const id of existingKeys) {
					if (idSet.has(id as string)) continue
					void storage.delete(id)
				}
			})
		}
	}

	private async schedulePruneSecondaryStorage() {
		if ((await browser.idle.queryState(30)) === 'idle')
			void this.pruneSecondaryStorage()
		else
			this.pruneSecondaryStorageScheduled = true
	}

	appendGroup(groupId: string, tabs: PartialTab[]) {
		return this.syncWrite(async () => {
			if (!await this.getGroupBookmark(groupId))
				throw new Error("Invalid group id")
			this.saveGroupImpl(groupId, tabs, 'append')
		})
	}

	setGroupColor(groupId: string, color: GroupColor | undefined) {
		return this.syncWrite(async () => {
			const bookmark = await this.getGroupBookmark(groupId)
			if (!bookmark) throw new Error("Invalid group id")
			const [prefix] = color && [...GroupManager.symbolColorMap]
				.find(([, c]) => c === color) || [undefined]
			const { name } = this.getGroupNameColor(bookmark)
			await browser.bookmarks.update(bookmark.id,
				{ title: prefix ? `${prefix} ${name}` : name })

			for (const [windowId, value] of this.windowGroupMap)
				if (value === groupId)
					this.onWindowUpdate.dispatch({ windowId, groupId, name, color })
		})
	}

	refreshAllWindowColor() {
		for (const [windowId, groupId] of [...this.windowGroupMap])
			void this.setWindowGroup(windowId, groupId)
	}
}
export const groupManager = new GroupManager()