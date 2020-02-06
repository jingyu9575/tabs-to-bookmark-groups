import { panelGroupMenus } from "../common/common.js";
import { M } from "../util/webext/i18n.js";
import { groupManager } from "./group-manager.js";

export { }

browser.runtime.onInstalled.addListener(({ reason, temporary }) => {
	if (reason === 'install' && !temporary)
		browser.tabs.create({ url: '/pages/first-install.html' });
})

const panelURL = new URL(browser.runtime.getManifest()
	.browser_action!.default_popup!)
panelURL.search = ''
panelGroupMenus.register({ title: M, documentUrlPatterns: [panelURL + '*'] })

const moveToGroupMenu = browser.menus.create({
	title: M.moveToGroup,
	contexts: ['tab'],
})
const moveToGroupSubMenus = new Map<string | number, string>()

browser.menus.onShown.addListener(async ({ menuIds }) => {
	if (!(menuIds as unknown[]).includes(moveToGroupMenu)) return
	for (const id of moveToGroupSubMenus.keys())
		browser.menus.remove(id)
	moveToGroupSubMenus.clear()
	for (const group of await groupManager.listGroups()) {
		const groupId = group.id
		if (group.state !== 'closed' || groupId === undefined) continue
		moveToGroupSubMenus.set(browser.menus.create({
			title: group.name, parentId: moveToGroupMenu,
			onclick: async (_, tab) => {
				await groupManager.appendGroup(groupId,
					[{ ...tab, active: false }])
				const tabs = await browser.tabs.query({ windowId: tab.windowId })
				if (tabs.length === 1 && tabs[0].id === tab.id)
					void browser.tabs.create({ windowId: tab.windowId })
				void browser.tabs.remove(tab.id!)
			}
		}), groupId)
	}
	browser.menus.update(moveToGroupMenu, { enabled: !!moveToGroupSubMenus.size })
	browser.menus.refresh()
})