import { M } from "../util/webext/i18n.js";
import { CriticalSection } from "../util/promise.js";
import { GroupState } from "../common/types.js";

const KEY_GROUP = 'group'

export class GroupManager {
	private static markerURL = browser.runtime.getURL('/pages/marker.html')
	private static transactionURL = browser.runtime.getURL(
		'/pages/transaction.html?committed=0')
	private static commitedTransactionURL = browser.runtime.getURL(
		'/pages/transaction.html?committed=1')

	private readonly criticalSection = new CriticalSection()
	private newTabURL = ''
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

		this.newTabURL = (await browser.browserSettings.newTabPageOverride
			.get({})).value || ''
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
				parentId: root.id,
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
		})
	}
	createGroup(name: string) {
		return this.criticalSection.sync(() => this.createGroupImpl(name))
	}

	switchGroup(windowId: number, groupId: string) {
		return this.criticalSection.sync(async () => {
			const oldTabs = (await browser.windows.get(windowId,
				{ populate: true })).tabs!
			if (oldTabs.length === 1 && [
				'about:blank', 'about:newtab', this.newTabURL
			].includes(oldTabs[0].url!))
				oldTabs.splice(0, 1) // do not save a single blank tab

			let oldGroupId = this.windowGroupMap.get(windowId)
			try {
				if (oldGroupId && (await browser.bookmarks.get(oldGroupId))[0]
					.type !== 'folder')
					oldGroupId = undefined
			} catch { oldGroupId = undefined }
			if (oldGroupId === undefined && oldTabs.length)
				oldGroupId = (await this.createGroupImpl(M.unnamed))!.id

			if (oldGroupId !== undefined) { // save old group
				const bookmarks = await browser.bookmarks.getChildren(oldGroupId)

				// TODO recovery
				const transaction = (await browser.bookmarks.create({
					parentId: oldGroupId,
					title: 'Transaction', url: GroupManager.transactionURL
				}))!
				for (const { title, url } of oldTabs!)
					await browser.bookmarks.create({ parentId: oldGroupId, title, url })
				await browser.bookmarks.update(transaction.id, {
					title: 'Transaction (committed)',
					url: GroupManager.commitedTransactionURL,
				})
				for (const { id } of bookmarks)
					await browser.bookmarks.remove(id)
				await browser.bookmarks.remove(transaction.id)
			}

			this.windowGroupMap.set(windowId, undefined)
			await browser.sessions.removeWindowValue(windowId, KEY_GROUP)

			{ // load new group
				const bookmarks = await browser.bookmarks.getChildren(groupId)
				const coverTab = (await browser.tabs.create({
					windowId, active: true,
					url: bookmarks.length ? 'about:blank' : undefined,
				}))!
				for (; ;) {
					const tabIds = (await browser.windows.get(windowId,
						{ populate: true })).tabs!.map(v => v.id!)
					const filteredTabIds = tabIds.filter(v => v !== coverTab.id)
					if (filteredTabIds.length === tabIds.length) return
					if (!filteredTabIds.length) break
					await browser.tabs.remove(filteredTabIds)
				}
				if (bookmarks.length) {
					let firstTab: browser.tabs.Tab | undefined
					for (const { url } of bookmarks) {
						const tab = await browser.tabs.create({
							windowId, url: this.toOpenableURL(url!), active: false,
						})
						if (!firstTab) firstTab = tab
					}
					if (firstTab) browser.tabs.update(firstTab.id!, { active: true })
					await browser.tabs.remove(coverTab.id!)
				}
			}

			this.windowGroupMap.set(windowId, groupId)
			await browser.sessions.setWindowValue(windowId, KEY_GROUP, groupId)
		})
	}

	private static readonly restrictedProtocols = new Set([
		'chrome:', 'javascript:', 'data:', 'file:', 'about:',
	])

	private toOpenableURL(url: string) {
		url = url.toLowerCase()
		if (url === 'about:blank') return url
		if (url === 'about:newtab') return undefined

		try {
			if (!GroupManager.restrictedProtocols.has(new URL(url).protocol))
				return url
		} catch { }

		return browser.runtime.getURL('pages/restricted.html?') +
			new URLSearchParams({ url })
	}
}