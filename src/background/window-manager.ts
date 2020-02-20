import { mapInsert } from "../util/util.js"
import { SimpleEventListener } from "../util/event.js";

export interface PartialTab extends Pick<browser.tabs.Tab,
	'id' | 'title' | 'url' | 'active' | 'pinned' | 'favIconUrl' | 'cookieStoreId'> { }

function arrayRemoveOne<T>(arr: T[], item: T) {
	const i = arr.indexOf(item)
	if (i > -1) { arr.splice(i, 1); return true }
	return false
}

export class WindowManager {
	private readonly tabs = new Map<number, PartialTab>()
	private readonly windowTabIdMap = new Map<number, PartialTab[]>()

	private window(id: number) {
		return mapInsert(this.windowTabIdMap, id, () => [])
	}

	constructor() {
		browser.tabs.onCreated.addListener(tab => this.createTab(tab))
		browser.tabs.query({}).then(tabs => {
			for (const tab of tabs) { this.createTab(tab) }
		})

		browser.tabs.onActivated.addListener(({ tabId, previousTabId }) => {
			const tab = this.tabs.get(tabId)
			if (tab) tab.active = true
			if (previousTabId !== undefined) {
				const previousTab = this.tabs.get(previousTabId)
				if (previousTab) previousTab.active = false
			}
		})

		browser.tabs.onMoved.addListener((tabId, { windowId, toIndex }) => {
			const tabs = this.window(windowId)
			const tab = this.tabs.get(tabId)
			if (!tab || !arrayRemoveOne(tabs, tab)) return
			tabs.splice(toIndex, 0, tab)
		})

		browser.tabs.onAttached.addListener((tabId, { newWindowId, newPosition }) => {
			const tab = this.tabs.get(tabId)
			if (!tab) return
			this.window(newWindowId).splice(newPosition, 0, tab)
		})

		browser.tabs.onDetached.addListener((tabId, { oldWindowId }) => {
			this.detachTab(tabId, oldWindowId)
		})

		browser.tabs.onRemoved.addListener((tabId, { windowId, isWindowClosing }) => {
			if (!isWindowClosing) this.detachTab(tabId, windowId)
			this.tabs.delete(tabId)
		})

		browser.windows.onRemoved.addListener(windowId => {
			const tabs = this.windowTabIdMap.get(windowId)
			if (!tabs) return
			this.windowTabIdMap.delete(windowId)
			this.onWindowRemoved.dispatch(windowId, tabs)
		})

		browser.tabs.onUpdated.addListener((tabId, changeInfo, newTab) => {
			const tab = this.tabs.get(tabId)
			if (!tab) return

			// Bug 1450384: favIconUrl may not be reported in changeInfo
			tab.favIconUrl = newTab.favIconUrl
			for (const key of ['title', 'url', 'pinned'] as const)
				if (changeInfo[key] !== undefined)
					(tab[key] as any) = changeInfo[key]
		})
	}

	private createTab(tab: browser.tabs.Tab): void {
		if (this.tabs.has(tab.id!)) return // may be called twice on startup
		this.tabs.set(tab.id!, tab)
		this.window(tab.windowId!).splice(tab.index, 0, tab)
	}

	private detachTab(tabId: number, windowId: number) {
		const tab = this.tabs.get(tabId)
		if (!tab) return
		arrayRemoveOne(this.window(windowId), tab)
	}

	readonly onWindowRemoved = new SimpleEventListener<[number, PartialTab[]]>()
}